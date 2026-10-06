// What each dibs claim came to, and who took it (#530).
//
// ⚠️ **Everything here is pure, and takes EPOCH SECONDS.** `claimed_at` and
// `deleted_at` are timestamptz and arrive from pg as `...+00` strings that
// `new Date()` reads as NaN (#140); `faction_attacks.started` is already a
// bigint of epoch seconds. Converting in SQL — `extract(epoch from claimed_at)`
// — means the two are the same unit before any arithmetic happens, and no
// timestamp parsing exists in this file to get wrong.
//
// ⚠️ **ATTACKS OUTRANK THE RELEASE REASON.** A successful conversion is recorded
// as `spent`, because the sweep frees a claim the moment the target stops being
// attackable and deliberately does not care who put them there. Reading the
// reason first would file every success under "target went down, nobody's
// doing". The reason only decides when our faction has no attack to show.
//
// ⚠️ **This file decides who gets blamed.** The output carries members' names
// into a leaderboard, so where the data is ambiguous it has to say so rather
// than pick the unflattering reading. Three cases exist only for that: a target
// who self-hospitalised to dodge looks exactly like a steal (`outside`), a board
// wiped at war setup is nobody's failure (`boardReset`), and pre-0072 claims
// have no reason at all (`unknown`).
import { WIN_RESULTS } from './warOverview/summary.js'
import { isDibsReleaseReason, DIBS_RELEASE_REASONS } from './warDibsReasons.js'

/**
 * How a claim ended, one bucket per claim, mutually exclusive.
 *
 * ⚠️ Mutually exclusive AND exhaustive on purpose: the buckets sum to the claim
 * count, so a reader can check the row rather than take it on trust. That
 * matters more than usual for a number with somebody's name next to it.
 */
export const CLAIM_OUTCOMES = {
  /** The holder hit it and won. */
  converted: 'converted',
  /** The holder hit it and lost. They swung. */
  attempted: 'attempted',
  /** Another of OUR members landed the finishing hit. */
  taken: 'taken',
  /** #106 window lapsed with the target still standing and nobody of ours
   *  having swung. ⚠️ The "did not swing" bucket. */
  noSwing: 'no-swing',
  /** The target went down with no attack from our faction. Another faction, or
   *  the target self-hospitalising to dodge. ⚠️ Never anyone's failure. */
  outside: 'outside',
  /** The holder gave it back. */
  released: 'released',
  /** The holder claimed a different target instead. */
  hopped: 'hopped',
  /** A lead released it. */
  overridden: 'overridden',
  /** The board was wiped at war setup. ⚠️ Never anyone's failure. */
  boardReset: 'board-reset',
  /** Still held when the war ended. */
  open: 'open',
  /** No reason recorded and no attack to go on — pre-0072 history. ⚠️ Visibly
   *  unexplained rather than quietly bucketed. */
  unknown: 'unknown',
} as const

export type ClaimOutcome = typeof CLAIM_OUTCOMES[keyof typeof CLAIM_OUTCOMES]

/**
 * How long a claim must have been live before another member's hit counts as
 * taking it.
 *
 * ⚠️ A claim takes a moment to reach other people's screens, and somebody who
 * clicked attack in the same instant raced rather than stole. Stated tunable,
 * not a hardcoded truth: pass `graceSeconds` to override. Five seconds is the
 * starting point because the War Room pushes a claim over its socket
 * sub-second, so anything beyond a few seconds of overlap is a choice rather
 * than a collision — revise it against real wars, not from first principles.
 */
export const STEAL_GRACE_SECONDS = 5

interface ClaimRow {
  id: number
  target_id: number
  claimed_by: number
  claimed_name?: string | null
  /** epoch seconds */
  claimed_at: number
  /** epoch seconds, or null while still held */
  deleted_at: number | null
  release_reason: string | null
}

interface AttackRow {
  attacker_id: number
  attacker_faction_id: number | string | null
  attacker_name?: string | null
  defender_id: number
  /** epoch seconds */
  started: number
  result: string | null
}

export interface ClaimVerdict {
  claim_id: number
  member_id: number
  outcome: ClaimOutcome
  /** Did the holder attack the target at all inside the claim's life? */
  holderSwung: boolean
  /** Who took it, when `outcome === taken`. */
  takenBy: number | null
  /** A teammate won it INSIDE the grace window — a race, not a theft. Kept
   *  because "we collided" is a real thing leads will want to see rather than
   *  an absence of data. */
  raced: boolean
}

/** ⚠️ Through `Number()`: faction ids arrive as strings from some payloads. */
const sameFaction = (a: unknown, b: unknown) => Number(a) === Number(b)

const isWin = (result: string | null) => !!result && WIN_RESULTS.has(result)

/** The reason, when there is no attack of ours to speak for the claim. */
function outcomeFromReason(reason: string | null, stillHeld: boolean): ClaimOutcome {
  if (stillHeld) return CLAIM_OUTCOMES.open
  // ⚠️ NULL is not a reason and must not fall through to a default. A claim we
  // cannot explain has to read as unexplained, or the first report files months
  // of back-history under whichever bucket the `else` happened to point at.
  if (!isDibsReleaseReason(reason)) return CLAIM_OUTCOMES.unknown
  switch (reason) {
    case DIBS_RELEASE_REASONS.window: return CLAIM_OUTCOMES.noSwing
    case DIBS_RELEASE_REASONS.spent:
    case DIBS_RELEASE_REASONS.rehospitalised: return CLAIM_OUTCOMES.outside
    case DIBS_RELEASE_REASONS.manual: return CLAIM_OUTCOMES.released
    case DIBS_RELEASE_REASONS.superseded: return CLAIM_OUTCOMES.hopped
    case DIBS_RELEASE_REASONS.admin: return CLAIM_OUTCOMES.overridden
    case DIBS_RELEASE_REASONS.reset: return CLAIM_OUTCOMES.boardReset
    default: return CLAIM_OUTCOMES.unknown
  }
}

/**
 * One claim's verdict.
 *
 * `attacks` may be the whole war's feed; it is filtered here. `warEndTs` closes
 * the window for a claim still held when the war finished.
 */
export function classifyClaim({
  claim, attacks = [], ourFactionId, warEndTs,
  graceSeconds = STEAL_GRACE_SECONDS,
}: {
  claim: ClaimRow
  attacks?: AttackRow[]
  ourFactionId: number | string
  warEndTs: number
  graceSeconds?: number
}): ClaimVerdict {
  const from = Number(claim.claimed_at)
  const stillHeld = claim.deleted_at == null
  const to = stillHeld ? Number(warEndTs) : Number(claim.deleted_at)

  let holderWin = false
  let holderLoss = false
  let takenBy: number | null = null
  let raced = false

  for (const a of attacks) {
    if (Number(a.defender_id) !== Number(claim.target_id)) continue
    if (!sameFaction(a.attacker_faction_id, ourFactionId)) continue
    // ⚠️ `started`, never `ended`. A fight already underway when the claim was
    // placed could not have been a response to it — and because it ENDS inside
    // the window, matching on `ended` would convict whoever was mid-attack.
    const started = Number(a.started)
    if (!(started >= from && started <= to)) continue

    if (Number(a.attacker_id) === Number(claim.claimed_by)) {
      // ⚠️ The holder is never racing themselves; grace applies to others only.
      if (isWin(a.result)) holderWin = true
      else holderLoss = true
      continue
    }
    // ⚠️ A teammate's LOSS steals nothing: it does not put the target in
    // hospital, so the claim is still live and the holder has lost nothing.
    if (!isWin(a.result)) continue
    if (started < from + Number(graceSeconds)) { raced = true; continue }
    if (takenBy == null) takenBy = Number(a.attacker_id)
  }

  const holderSwung = holderWin || holderLoss
  let outcome: ClaimOutcome
  if (holderWin) outcome = CLAIM_OUTCOMES.converted
  else if (takenBy != null) outcome = CLAIM_OUTCOMES.taken
  else if (holderLoss) outcome = CLAIM_OUTCOMES.attempted
  else outcome = outcomeFromReason(claim.release_reason, stillHeld)

  return {
    claim_id: claim.id,
    member_id: Number(claim.claimed_by),
    outcome,
    holderSwung,
    takenBy: outcome === CLAIM_OUTCOMES.taken ? takenBy : null,
    raced,
  }
}

export interface MemberDibsRow {
  member_id: number
  member_name: string | null
  claims: number
  converted: number
  attempted: number
  takenFrom: number
  noSwing: number
  outside: number
  released: number
  hopped: number
  overridden: number
  boardReset: number
  open: number
  unknown: number
  /** Claims where the holder attacked the target at all. */
  swung: number
  /** ⚠️ The OTHER axis: finishing hits this member landed on somebody else's
   *  live claim. "Stolen" is two numbers that cannot share a column, and the
   *  top-offenders question needs this one. */
  tookFromOthers: number
}

const emptyRow = (member_id: number, member_name: string | null): MemberDibsRow => ({
  member_id, member_name, claims: 0, converted: 0, attempted: 0, takenFrom: 0,
  noSwing: 0, outside: 0, released: 0, hopped: 0, overridden: 0, boardReset: 0,
  open: 0, unknown: 0, swung: 0, tookFromOthers: 0,
})

/** ⚠️ Narrowed to the COUNT fields only. `keyof MemberDibsRow` includes
 *  `member_name`, which makes the write target `never` and the increment below
 *  a type error — the compiler catching a real hazard, since an outcome mapped
 *  to the name field would quietly corrupt the row. */
type CountField = {
  [K in keyof MemberDibsRow]: MemberDibsRow[K] extends number ? K : never
}[keyof MemberDibsRow]

const OUTCOME_FIELD: Record<ClaimOutcome, CountField> = {
  [CLAIM_OUTCOMES.converted]: 'converted',
  [CLAIM_OUTCOMES.attempted]: 'attempted',
  [CLAIM_OUTCOMES.taken]: 'takenFrom',
  [CLAIM_OUTCOMES.noSwing]: 'noSwing',
  [CLAIM_OUTCOMES.outside]: 'outside',
  [CLAIM_OUTCOMES.released]: 'released',
  [CLAIM_OUTCOMES.hopped]: 'hopped',
  [CLAIM_OUTCOMES.overridden]: 'overridden',
  [CLAIM_OUTCOMES.boardReset]: 'boardReset',
  [CLAIM_OUTCOMES.open]: 'open',
  [CLAIM_OUTCOMES.unknown]: 'unknown',
}

/**
 * One war's dibs activity, per member.
 *
 * ⚠️ Two passes over the same claims, because the two theft numbers are on
 * different axes: who lost a target, and who took one. A member can be on both
 * sides in the same war, and collapsing them into one "stolen" column answers
 * neither question.
 */
export function summariseWarDibs({
  claims = [], attacks = [], ourFactionId, warEndTs,
  graceSeconds = STEAL_GRACE_SECONDS,
}: {
  claims?: ClaimRow[]
  attacks?: AttackRow[]
  ourFactionId: number | string
  warEndTs: number
  graceSeconds?: number
}): { members: MemberDibsRow[]; verdicts: ClaimVerdict[] } {
  const rows = new Map<number, MemberDibsRow>()
  const row = (id: number, name: string | null) => {
    if (!rows.has(id)) rows.set(id, emptyRow(id, name))
    const r = rows.get(id)!
    if (r.member_name == null && name) r.member_name = name
    return r
  }

  const verdicts: ClaimVerdict[] = []
  for (const claim of claims) {
    const v = classifyClaim({ claim, attacks, ourFactionId, warEndTs, graceSeconds })
    verdicts.push(v)
    const r = row(v.member_id, claim.claimed_name ?? null)
    r.claims += 1
    const field = OUTCOME_FIELD[v.outcome]
    r[field] += 1
    if (v.holderSwung) r.swung += 1
    // The offender's own row. ⚠️ Created even if they never claimed anything
    // themselves — somebody who only ever takes other people's targets must not
    // be absent from the table that exists to show exactly that.
    if (v.takenBy != null) {
      const taker = attacks.find((a) => Number(a.attacker_id) === v.takenBy)
      row(v.takenBy, taker?.attacker_name ?? null).tookFromOthers += 1
    }
  }

  return {
    members: [...rows.values()].sort(
      (a, b) => b.claims - a.claims
        || b.tookFromOthers - a.tookFromOthers
        // ⚠️ A stable last resort: without it the table reshuffles between
        // identical runs, and a leaderboard that moves on its own looks wrong.
        || a.member_id - b.member_id
    ),
    verdicts,
  }
}

/**
 * How long after a war ends before its attacks are assumed complete.
 *
 * ⚠️ Stated tunable. `attacks-sync` runs every 30 minutes and pages forward to
 * the present, so two hours is several chances to have caught up — but a run
 * that hits a Torn rate limit mid-backlog EXITS AS A SUCCESS, so "a sync
 * succeeded" alone does not prove coverage. Hence two conditions below, not one.
 */
export const ATTACKS_SETTLE_SECONDS = 2 * 60 * 60

/**
 * Are this war's attacks in, so the summary can be trusted?
 *
 * ⚠️ **Getting this wrong is permanent.** A war summarised before its attacks
 * land records conversions that happened as "no swing", with members' names
 * against them — and once the raw claims are pruned there is nothing to correct
 * it from. So the gate is deliberately conservative: a war that is not ready
 * simply waits for the next run.
 *
 * `newestAttackTs` — `max(started)` in `faction_attacks`. This is the strong
 * signal: the sync pages forward from there, so an attack newer than the war's
 * end means everything up to that end is stored.
 *
 * The time-based fallback covers a faction that fought a war and then genuinely
 * did nothing, leaving `max(started)` behind the war's end for days. It needs a
 * SUCCESSFUL sync well after the war ended, not merely the clock.
 */
export function warAttacksSettled({
  warEndTs, newestAttackTs, lastSuccessfulSyncTs,
  settleSeconds = ATTACKS_SETTLE_SECONDS,
}: {
  warEndTs: number | null
  newestAttackTs: number | null
  lastSuccessfulSyncTs: number | null
  settleSeconds?: number
}): boolean {
  // ⚠️ A war still running has no end to settle against.
  if (warEndTs == null || !Number.isFinite(Number(warEndTs))) return false
  const end = Number(warEndTs)
  if (newestAttackTs != null && Number(newestAttackTs) >= end) return true
  if (lastSuccessfulSyncTs != null && Number(lastSuccessfulSyncTs) >= end + Number(settleSeconds)) {
    return true
  }
  return false
}

/** Bumped when the classifier's rules change, so older summaries recompute
 *  instead of sitting stale. ⚠️ Raise this in the SAME commit as any change to
 *  `classifyClaim`, or the fleet keeps numbers produced by the old rules. */
export const DIBS_SUMMARY_VERSION = 1
