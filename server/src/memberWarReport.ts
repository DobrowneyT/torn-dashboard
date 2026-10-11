// Everything one member's post-war report needs, for one (war, member) (#943).
//
// ⚠️ **One endpoint carrying all five facts, not the bot calling five routes.**
// The bot reaches a dashboard through bearer-token internal routes only; roll
// call, dibs and war contributions are session-authed and unreachable to it.
// Assembling here also keeps the decision about *what belongs in a member
// report* on the side where the data lives — the bot renders, it does not
// select.
//
// ⚠️ **ABSENCE IS NOT ZERO, and this file is where that is won or lost.** Every
// one of the five is `null` when we have no measurement, and the formatter
// renders "not counted yet" rather than "0". Once a zero is written into the
// payload the distinction cannot be recovered, and what gets posted is a
// permanent claim about a named person that happens to be false.
//
// ⚠️ The sharpest case is dibs, and it has THREE states rather than two.
// `war_dibs_summary` holds a row only for members who claimed something, so a
// missing row could mean "claimed nothing", "the job has not run for this war
// yet", or "this tenant does not run the job at all". MonChoon, 2026-10-11:
// *"If dibs summary is disabled we can ship the war reports without it rather
// than wait. If it's enabled and the war wrap up has finished then we would
// know any member without a dibs summary row had no history in there."*
//
// Those three lead to OPPOSITE actions, which is why a bare `null` is not good
// enough here:
//
//   disabled → ship the report now, with the section saying tracking is off.
//   pending  → the wrap-up is not finished; posting now would be premature.
//   measured → a missing row is a genuine zero, "no dibs history found".
//
// The difference is live: `dibs-summary` is enabled on one of five tenants, so
// on the other four every member's missing row means "we never measured". So
// `dibs` always carries its state, and `counts` — the only place a zero is
// legitimate — is non-null only when that state is `measured`.
import type pg from 'pg'
import { summariseWindow, type Summary } from './warOverview/summary.js'
import { buildChart, resolveBinSeconds, type Chart } from './warOverview/series.js'
import { resolveFactionNames } from './warOverview/factionNames.js'
import { scoreMemberWar, type MemberWarScore } from './warMemberScore.js'

/**
 * Why there are, or are not, dibs numbers.
 *
 * ⚠️ `disabled` and `pending` both yield no counts but mean different things to
 * the caller: one is a finished report, the other is an unfinished wrap-up.
 */
export type DibsState = 'disabled' | 'pending' | 'measured'

export interface MemberDibs {
  state: DibsState
  /** When the war was summarised, epoch ms. Only on `measured`. */
  measured_ms: number | null
  /** The grace window those numbers were produced under. Only on `measured`. */
  grace_seconds: number | null
  /**
   * This member's claim counts.
   *
   * ⚠️ Non-null ONLY when `state` is `measured`, and then a row of zeros is a
   * real measurement — the job ran, saw their claims, and there were none.
   */
  counts: Record<string, unknown> | null
}

export interface MemberWarReport {
  war: {
    id: number
    opponent_id: number | null
    opponent_name: string | null
    /** epoch ms (the column is epoch SECONDS; converted at the edge). */
    start_ms: number
    end_ms: number | null
    our_score: number
    opponent_score: number
    is_termed: boolean
  }
  member: { id: number; name: string | null }
  score: MemberWarScore | null
  summary: Summary | null
  dibs: MemberDibs
  roll_call: MemberRollCall | null
  stacks: MemberStacks | null
  /** Pre-binned series for the bot's chart, member-scoped. Null when empty. */
  chart: Chart | null
}

/**
 * ⚠️ **A deliberate contract, NOT the raw `war_room_roll_call_v2` row.**
 *
 * The first version of this returned the row as it came out of Postgres, and
 * the formatter — which reads `responded` — rendered *"no answer recorded"* for
 * somebody who had answered. The dashboard selects, the bot renders; shipping
 * raw column names makes the bot responsible for a schema it cannot see.
 */
export interface MemberRollCall {
  /** ⚠️ True because a ROW EXISTS. Answering "no" is still answering. */
  responded: true
  on_at_start: boolean
  availability: string | null
  can_self_hospital: boolean | null
  needs_merc: boolean | null
  revised: boolean
  submitted_ms: number | null
  /**
   * Seconds between the war starting and this member's first attack, or null.
   *
   * ⚠️ Null means "no attack to measure against", NOT "did not turn up" — it
   * is also true of somebody who spent the war being revived.
   */
  first_action_offset_sec: number | null
}

export interface MemberStacks {
  /**
   * ⚠️ Null when `has_reading` is false. Energy 0 and "we could not read their
   * energy" are different facts, and the column exists because a blank cell
   * reads as zero. Sending 0 here is the absence-as-zero failure the whole
   * design is about — which is exactly what the first version did.
   */
  energy: number | null
  energy_max: number | null
  /** False when the member had no readable pooled key at capture time. */
  has_reading: boolean
  overdosed: boolean
  captured_ms: number | null
}

export type ReportError = { error: string }

/**
 * ⚠️ **A live war is refused.** The report is a permanent record and both
 * scores are only final once the war is. MonChoon on the wrap-up job: *"I don't
 * want it to post scoreless reports because the wrap up never completed, it
 * should just fail loudly."* An endpoint that happily served a half-finished
 * war is how a scoreless report gets posted.
 */
export async function collectMemberWarReport(
  db: pg.Pool, warId: number | string, memberId: number | string,
): Promise<MemberWarReport | ReportError> {
  const war = Number(warId)
  const member = Number(memberId)
  if (!Number.isFinite(war) || !Number.isFinite(member)) {
    return { error: 'war and member must be numeric' }
  }

  const usRes = await db.query('SELECT torn_faction_id FROM faction_config LIMIT 1')
  const ourFactionId = Number(usRes.rows[0]?.torn_faction_id ?? 0)
  if (!ourFactionId) return { error: 'this tenant has no faction id configured' }

  // ⚠️ `start_at` / `end_at` are bigint epoch SECONDS, unlike almost every
  // other timestamp in this schema. An `extract(epoch FROM …)` here throws,
  // which is the good outcome; the bad one is reading them as milliseconds and
  // placing the war in 1970.
  const warRes = await db.query(
    `SELECT id, opponent_id, opponent_name, start_at, end_at,
            our_score, opponent_score, is_termed
       FROM ranked_wars WHERE id = $1`,
    [war],
  )
  if (warRes.rowCount === 0) return { error: `no such war: ${war}` }
  const w = warRes.rows[0]
  if (w.end_at == null) return { error: `war ${war} has not ended` }

  const fromTs = Number(w.start_at)
  const toTs = Number(w.end_at)

  const [attacksRes, revivesRes, dibsRes, dibsStateRes, dibsJobRes, rollRes, stacksRes, nameRes] =
    await Promise.all([
      db.query(
        `SELECT started, result, chain, respect_gain, is_ranked_war,
                attacker_id, attacker_name, attacker_faction_id, attacker_faction_name,
                defender_id, defender_name, defender_faction_id, defender_faction_name
           FROM faction_attacks
          WHERE started >= $1 AND started <= $2`,
        [fromTs, toTs],
      ),
      db.query(
        `SELECT timestamp, result, target_id, target_faction_id,
                reviver_id, reviver_faction_id, reviver_faction_name
           FROM faction_revives
          WHERE timestamp >= $1 AND timestamp <= $2`,
        [fromTs, toTs],
      ),
      db.query(
        `SELECT * FROM war_dibs_summary WHERE war_id = $1 AND member_id = $2`,
        [war, member],
      ),
      // ⚠️ The discriminator. See the header note: without this, "nobody
      // measured dibs on this tenant" renders as "claimed 0".
      db.query(
        `SELECT war_id, claims_seen, grace_seconds, summary_version,
                (extract(epoch from computed_at) * 1000)::bigint AS computed_ms
           FROM war_dibs_summary_state WHERE war_id = $1`,
        [war],
      ),
      // ⚠️ Whether this tenant runs the job AT ALL. A disabled job means no
      // amount of waiting will produce numbers, so the report ships without
      // them rather than being held for a measurement that is never coming.
      // ⚠️ A job with no row has never been registered on this tenant, which
      // is also "off" — `enabled` defaults to false on registration.
      db.query(
        `SELECT enabled FROM scraper_jobs WHERE job_name = $1`,
        [DIBS_SUMMARY_JOB],
      ),
      db.query(
        `SELECT member_id, member_name, on_at_start, can_self_hospital, needs_merc,
                availability, revised,
                (extract(epoch from submitted_at) * 1000)::bigint AS submitted_ms
           FROM war_room_roll_call_v2 WHERE war_id = $1 AND member_id = $2`,
        [war, member],
      ),
      db.query(
        `SELECT member_id, member_name, energy_current, energy_maximum,
                has_reading, od_flagged_prewar,
                (extract(epoch from captured_at) * 1000)::bigint AS captured_ms
           FROM war_stacks_snapshot WHERE war_id = $1 AND member_id = $2`,
        [war, member],
      ),
      db.query('SELECT member_name FROM members WHERE member_id = $1', [String(member)]),
    ])

  const attacks = attacksRes.rows
  const revives = revivesRes.rows

  // ⚠️ Named from the attack rows first, falling back to the members table. A
  // member who has since left has no current row, and a report about them must
  // still carry a name — their thread is titled with it.
  const fromAttacks = attacks.find((a: any) =>
    Number(a.attacker_id) === member || Number(a.defender_id) === member)
  const name = (Number(fromAttacks?.attacker_id) === member
    ? fromAttacks?.attacker_name
    : fromAttacks?.defender_name) ?? nameRes.rows[0]?.member_name ?? null

  // ⚠️ Every faction the rows mention, not just the opponent — see
  // `factionNames.ts`. A third faction in the chart legend read as
  // `faction 21716` in a permanent thread.
  const factionNames = await resolveFactionNames(
    db, [...attacks, ...revives],
    { id: w.opponent_id == null ? null : Number(w.opponent_id), name: w.opponent_name ?? null },
  )

  const summary = summariseWindow({
    attacks, revives, fromTs, toTs, ourFactionId,
    selectedFactionIds: null, mode: 'member', memberId: member,
  })

  return {
    war: {
      id: Number(w.id),
      opponent_id: w.opponent_id == null ? null : Number(w.opponent_id),
      opponent_name: w.opponent_name ?? null,
      start_ms: fromTs * 1000,
      end_ms: toTs * 1000,
      our_score: Number(w.our_score ?? 0),
      opponent_score: Number(w.opponent_score ?? 0),
      // ⚠️ A label set BY HAND from the RW History page, passed through rather
      // than acted on. ALL wars get a report, termed included — MonChoon:
      // *"on a termed war most people do participate"*, and a war where nobody
      // turned up is keep-or-kick evidence, not noise.
      is_termed: !!w.is_termed,
    },
    member: { id: member, name },
    score: scoreMemberWar(attacks, member, ourFactionId),
    // ⚠️ `summariseWindow` always returns an object. It is nulled here when
    // there are no rows AT ALL for the window, because a summary of an empty
    // ledger is a row of zeros that reads as "did nothing" when the truth is
    // "the attack scrape has nothing for this war".
    summary: attacks.length === 0 && revives.length === 0 ? null : summary,
    dibs: describeDibs({
      jobEnabled: dibsJobRes.rows[0]?.enabled === true,
      state: dibsStateRes.rows[0] ?? null,
      row: dibsRes.rows[0] ?? null,
    }),
    roll_call: shapeRollCall(rollRes.rows[0] ?? null, attacks, member, fromTs),
    stacks: shapeStacks(stacksRes.rows[0] ?? null),
    // ⚠️ Member-scoped, and the same binner the page and `/rw overview` use —
    // a second implementation of "which bin does this attack fall in" is what
    // `warOverview/series.ts` exists to prevent.
    chart: attacks.length === 0 && revives.length === 0 ? null : buildChart({
      attacks, revives, fromTs, toTs, ourFactionId,
      selectedFactionIds: null, mode: 'member', memberId: member,
      factionNames, binSeconds: resolveBinSeconds(toTs - fromTs, 'auto').seconds,
    }),
  }
}

/**
 * The roll-call row as the report needs it.
 *
 * ⚠️ `responded: true` whenever a row exists. "Did not answer" is not "said
 * no", and the absence of a row is the only thing that means silence.
 */
function shapeRollCall(
  row: Record<string, any> | null, attacks: any[], memberId: number, fromTs: number,
): MemberRollCall | null {
  if (row === null) return null

  // ⚠️ Their FIRST outgoing attack in the window, which is what "turned up"
  // measures. Computed here rather than in SQL because the attack rows are
  // already loaded, and a second query asking the same question is a second
  // definition of it.
  let firstStarted: number | null = null
  for (const a of attacks) {
    if (Number(a.attacker_id) !== memberId) continue
    const started = Number(a.started)
    if (!Number.isFinite(started)) continue
    if (firstStarted === null || started < firstStarted) firstStarted = started
  }

  return {
    responded: true,
    on_at_start: row.on_at_start === true,
    availability: row.availability ?? null,
    can_self_hospital: row.can_self_hospital ?? null,
    needs_merc: row.needs_merc ?? null,
    revised: row.revised === true,
    submitted_ms: row.submitted_ms == null ? null : Number(row.submitted_ms),
    // ⚠️ Null when they never attacked — "not measured", never 0, which would
    // read as "turned up instantly".
    first_action_offset_sec: firstStarted === null
      ? null
      : Math.max(0, firstStarted - fromTs),
  }
}

/**
 * The stacks snapshot as the report needs it.
 *
 * ⚠️ **`energy` is null when `has_reading` is false.** The column exists
 * precisely because a blank energy cell reads as zero in a spreadsheet, and
 * sending 0 here reproduces that error in a permanent per-member record.
 */
function shapeStacks(row: Record<string, any> | null): MemberStacks | null {
  if (row === null) return null
  const hasReading = row.has_reading === true
  return {
    energy: hasReading ? Number(row.energy_current ?? 0) : null,
    energy_max: row.energy_maximum == null ? null : Number(row.energy_maximum),
    has_reading: hasReading,
    overdosed: row.od_flagged_prewar === true,
    captured_ms: row.captured_ms == null ? null : Number(row.captured_ms),
  }
}

/** The job whose `enabled` flag decides between `disabled` and `pending`. */
export const DIBS_SUMMARY_JOB = 'dibs-summary'

/**
 * Which of the three dibs states we are in, and the counts if any.
 *
 * ⚠️ **`disabled` is checked BEFORE `pending`.** A tenant that does not run the
 * job also has no state row, so testing for the state row first would report
 * every one of those wars as `pending` for ever — and a wrap-up that fails
 * loudly on `pending` would then never complete on four of five tenants.
 */
export function describeDibs({
  jobEnabled, state, row,
}: {
  jobEnabled: boolean
  state: Record<string, any> | null
  row: Record<string, unknown> | null
}): MemberDibs {
  if (!jobEnabled) {
    return { state: 'disabled', measured_ms: null, grace_seconds: null, counts: null }
  }
  if (state === null) {
    return { state: 'pending', measured_ms: null, grace_seconds: null, counts: null }
  }
  return {
    state: 'measured',
    measured_ms: state.computed_ms == null ? null : Number(state.computed_ms),
    grace_seconds: state.grace_seconds == null ? null : Number(state.grace_seconds),
    // ⚠️ The ONE place a zero is legitimate in this file. The job ran, it saw
    // this member's claims, and there were none — "no dibs history found",
    // which is a measurement rather than an absence.
    counts: row ?? { claims: 0 },
  }
}
