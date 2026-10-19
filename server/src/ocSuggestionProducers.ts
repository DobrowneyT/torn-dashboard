// The first producers for the OC action feed (#1022, #1023; PRD #1018).
//
// Pure functions over what the dashboard already holds — the crimes snapshot,
// the roster, each member's CPR readings and the published minimums — so they
// are tested without a database, and the job that calls them spends no Torn
// calls at all.
//
//   joined too low (#1022) — someone took a seat in a crime BELOW level 7
//     while a higher crime has an open seat. ⚠️ MonChoon: levels 7 and 8 are
//     one tier — a 7 with an 8 open is fine — and the goal is everyone in 7/8.
//     Only while the join is recent: after the window, moving costs progress.
//   not in any OC (#1023) — a current member in no crime for longer than the
//     grace period, with the best seat they could take.
//
// ⚠️ **Never an invented CPR.** A seat with no reading for the member says
// "no reading"; one with no published minimum says so. The suggestion is a
// prompt for a human, and a guessed number would be acted on as fact.
import type { SuggestionInput } from './ocSuggestions.js'

/** Levels 7 and 8 are the top tier (MonChoon, 2026-10-19). */
export const TOP_TIER = 7
export const TOO_LOW_WINDOW_HOURS_DEFAULT = 4
export const IDLE_GRACE_MINUTES_DEFAULT = 30

export interface Slot {
  position_label?: string
  position_info?: { label?: string | null } | null
  position?: string | null
  required_cpr?: number | null
  user?: { id?: number | string | null; joined_at?: number | null; name?: string | null } | null
}
export interface Crime {
  id: number | string
  name: string
  difficulty: number
  status: string
  slots?: Slot[]
}
/** `${crime_name}||${position_label}` → CPR, per member. */
export type Readings = Map<string, Map<string, number>>

const labelOf = (s: Slot) => s.position_label ?? s.position_info?.label ?? s.position ?? ''

export interface Seat {
  crime: Crime
  label: string
  required: number | null
  cpr: number | null
  clears: boolean | null
}

/**
 * Every open seat for this member, best first.
 *
 * ⚠️ Order is the instruction: levels 7/8 they clear first, then any seat
 * they clear, then higher level, then their measured CPR — so "the best open seat" means "the one leadership
 * wants filled by someone who can do it", not merely "the hardest crime".
 */
export function openSeatsFor(memberId: string, crimes: Crime[], readings: Readings, minDifficulty = 0): Seat[] {
  const mine = readings.get(memberId)
  const seats: Seat[] = []
  for (const c of crimes) {
    if (c.status !== 'Recruiting' || c.difficulty <= minDifficulty) continue
    for (const s of c.slots ?? []) {
      if (s.user?.id != null) continue
      const label = labelOf(s)
      const cpr = mine?.get(`${c.name}||${label}`) ?? null
      const required = s.required_cpr ?? null
      seats.push({ crime: c, label, required, cpr, clears: cpr == null || required == null ? null : cpr >= required })
    }
  }
  const rank = (x: Seat) => [
    x.crime.difficulty >= TOP_TIER && x.clears === true ? 1 : 0,
    // ⚠️ "Clears" beats "unknown or below", but an unknown or below-the-bar
    // seat is NOT ranked under a lower level for it: the goal is everyone in
    // 7/8, so a near-miss at L8 is a better prompt than a blank at L1.
    x.clears === true ? 1 : 0,
    x.crime.difficulty,
    x.cpr ?? -1,
  ]
  return seats.sort((a, b) => {
    const ra = rank(a)
    const rb = rank(b)
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return rb[i] - ra[i]
    return String(a.crime.id).localeCompare(String(b.crime.id)) || a.label.localeCompare(b.label)
  })
}

/** "CPR 78 (bar 70) ✓" / "CPR 61, below the bar of 70" / "no reading for this seat". */
export function seatLine(seat: Seat): string {
  if (seat.cpr == null) return 'no CPR reading for this seat yet'
  if (seat.required == null) return `CPR ${seat.cpr} (no published minimum)`
  return seat.clears ? `CPR ${seat.cpr}, clears the bar of ${seat.required} ✓` : `CPR ${seat.cpr}, below the bar of ${seat.required}`
}

const where = (s: Seat) => `**${s.crime.name}** (L${s.crime.difficulty}) as **${s.label}**`

/**
 * #1022. Returns the live suggestions, plus the keys whose member has since
 * moved UP (those resolve rather than expire).
 */
export function joinedTooLow(args: {
  crimes: Crime[]
  readings: Readings
  names: Map<string, string>
  nowSec: number
  windowHours?: number
  previousKeys?: string[]
}): { live: SuggestionInput[]; resolved: Set<string> } {
  const windowSec = (args.windowHours ?? TOO_LOW_WINDOW_HOURS_DEFAULT) * 3600
  const live: SuggestionInput[] = []
  const seatedIn = new Map<string, Crime>()
  for (const c of args.crimes) for (const s of c.slots ?? []) if (s.user?.id != null) seatedIn.set(String(s.user.id), c)

  for (const c of args.crimes) {
    if (c.difficulty >= TOP_TIER) continue
    for (const s of c.slots ?? []) {
      const id = s.user?.id == null ? null : String(s.user.id)
      const joined = s.user?.joined_at ?? null
      if (!id || joined == null || args.nowSec - joined > windowSec) continue
      const best = openSeatsFor(id, args.crimes, args.readings, c.difficulty)[0]
      if (!best) continue
      const name = s.user?.name ?? args.names.get(id) ?? id
      live.push({
        key: `too_low:${id}:${c.id}`,
        kind: 'too_low',
        crimeId: String(c.id),
        memberIds: [id],
        title: `${name} joined ${c.name} (L${c.difficulty})`,
        body: `${where(best)} has an open seat — ${seatLine(best)}.\n`
          // ⚠️ A Discord timestamp, not "N min ago": text that changes every
          // minute bumps the version every minute, and the bot redraws it.
          + `They joined <t:${joined}:R>, so moving now loses little progress.`,
        steps: [`${name} leaves ${c.name}`, `${name} joins ${best.crime.name} as ${best.label}`],
        value: {},
        severity: best.clears === true && best.crime.difficulty >= TOP_TIER ? 'warn' : 'info',
        expiresAt: (joined + windowSec) * 1000,
      })
    }
  }

  // Moved up since: a previous key whose member now sits in a higher crime.
  const resolved = new Set<string>()
  for (const key of args.previousKeys ?? []) {
    const [, member, crimeId] = key.split(':')
    const was = args.crimes.find((c) => String(c.id) === crimeId)
    const now = seatedIn.get(member)
    if (now && String(now.id) !== crimeId && now.difficulty > (was?.difficulty ?? 0)) resolved.add(key)
  }
  return { live, resolved }
}

/**
 * #1023. `lastSeatedSec` is when each member was last seen in any crime
 * (the occupancy observer), or absent when never.
 */
export function notInAnyOc(args: {
  crimes: Crime[]
  readings: Readings
  members: Array<{ id: string; name: string; state?: string | null }>
  lastSeatedSec: Map<string, number>
  nowSec: number
  graceMinutes?: number
  previousKeys?: string[]
}): { live: SuggestionInput[]; resolved: Set<string> } {
  const graceSec = (args.graceMinutes ?? IDLE_GRACE_MINUTES_DEFAULT) * 60
  const seated = new Set<string>()
  for (const c of args.crimes) for (const s of c.slots ?? []) if (s.user?.id != null) seated.add(String(s.user.id))

  const live: SuggestionInput[] = []
  for (const m of args.members) {
    if (seated.has(m.id) || m.state === 'Federal') continue
    const last = args.lastSeatedSec.get(m.id)
    if (last != null && args.nowSec - last < graceSec) continue
    const best = openSeatsFor(m.id, args.crimes, args.readings)[0]
    // ⚠️ A Discord timestamp, for the same reason as in joinedTooLow.
    const since = last == null ? 'not seen in a crime yet' : `out of a crime since <t:${last}:R>`
    live.push({
      key: `idle:${m.id}`,
      kind: 'idle',
      crimeId: best ? String(best.crime.id) : null,
      memberIds: [m.id],
      title: `${m.name} isn't in an OC`,
      body: best
        ? `${m.name} has been ${since}. Best open seat: ${where(best)} — ${seatLine(best)}.`
        : `${m.name} has been ${since}, and there is no open seat to suggest right now.`,
      steps: best ? [`${m.name} joins ${best.crime.name} as ${best.label}`] : [],
      value: {},
      severity: 'info',
    })
  }
  const resolved = new Set((args.previousKeys ?? []).filter((k) => seated.has(k.slice('idle:'.length))))
  return { live, resolved }
}


// ── #1021: better seating within a crime ─────────────────────────────────────
//
// The members already in a crime, arranged across its seats so the heavy roles
// hold the strongest CPRs. MonChoon (2026-10-19):
//   • switching seats inside a crime keeps planning progress;
//   • you cannot switch into a full crime — someone has to leave;
//   • a member whose planning is COMPLETE is idle, and can leave and rejoin
//     without costing the crime anything — so a full crime with one of those
//     still has a seat to move through.

export const SWAP_MIN_GAIN_PP_DEFAULT = 3
export const SWAP_MIN_WEIGHTED_GAIN_DEFAULT = 3

export interface SwapSlot extends Slot {
  position_info?: { id?: string | null; label?: string | null } | null
  checkpoint_pass_rate?: number | null
  user?: { id?: number | string | null; joined_at?: number | null; name?: string | null; progress?: number | null } | null
}
export interface SwapCrime extends Crime {
  ready_at?: number | null
  slots?: SwapSlot[]
}

interface Seat2 { pid: string; label: string; weight: number; occupant: string | null; liveCpr: number | null; progress: number | null }

/**
 * The best arrangement of a crime's seated members, and the moves to reach it.
 *
 * `weights` is the crime's role weights by seat id (P1…); `successOf`, when the
 * local simulator is trustworthy for this crime, turns a full CPR vector into a
 * success chance. Without it the gain is stated in weighted CPR, honestly.
 */
export function seatSwap(args: {
  crime: SwapCrime
  weights: Map<string, number>
  readings: Readings
  online: Set<string>
  names: Map<string, string>
  nowSec: number
  successOf?: ((cprByPid: Record<string, number>) => number) | null
  minGainPp?: number
  minWeightedGain?: number
}): SuggestionInput | null {
  const { crime } = args
  if (crime.status !== 'Recruiting' && crime.status !== 'Planning') return null
  if (crime.ready_at != null && crime.ready_at <= args.nowSec) return null
  const seats: Seat2[] = (crime.slots ?? []).map((s) => ({
    pid: String(s.position_info?.id ?? ''),
    label: labelOf(s),
    weight: args.weights.get(String(s.position_info?.id ?? '')) ?? 0,
    occupant: s.user?.id == null ? null : String(s.user.id),
    liveCpr: s.checkpoint_pass_rate ?? null,
    progress: s.user?.progress ?? null,
  })).filter((s) => s.pid && s.weight > 0)
  if (seats.length !== (crime.slots ?? []).length) return null   // a seat we cannot weigh: no opinion
  const members = seats.filter((s) => s.occupant).map((s) => s.occupant!) as string[]
  if (members.length < 2) return null

  const current = new Map<string, number>()   // member → seat index
  seats.forEach((s, i) => { if (s.occupant) current.set(s.occupant, i) })
  const readingsOf = (m: string) => args.readings.get(m)
  // ⚠️ Measured only. The seat a member holds now uses Torn's live figure;
  // any other seat needs a reading from the CPR scan, or the arrangement is out.
  const cprOf = (m: string, i: number): number | null => {
    if (current.get(m) === i) return seats[i].liveCpr ?? readingsOf(m)?.get(`${crime.name}||${seats[i].label}`) ?? null
    return readingsOf(m)?.get(`${crime.name}||${seats[i].label}`) ?? null
  }
  const totalWeight = seats.reduce((n, s) => n + s.weight, 0)

  const now = members.map((m) => current.get(m)!)
  const found = bestArrangement(members, now, (m, i) => cprOf(m, i), seats.map((x) => x.weight))
  if (!found) return null
  const { best, nowScore, bestScore } = found

  const movers = members.filter((m, k) => best[k] !== now[k])
  if (movers.length === 0) return null
  const weightedGain = (bestScore - nowScore) / totalWeight

  // A seat to move through: an empty one, or an idle seated member (planning
  // complete) who can leave without costing the crime anything.
  const hasEmpty = seats.some((s) => !s.occupant)
  let leaver: string | null = null
  if (!hasEmpty) {
    const idle = seats.filter((s) => s.occupant && (s.progress ?? 0) >= 100).map((s) => s.occupant!)
    leaver = idle.find((m) => args.online.has(m)) ?? null
    if (!leaver) return null
  }
  // ⚠️ Everyone who has to move must be online now (MonChoon).
  if (![...movers, ...(leaver ? [leaver] : [])].every((m) => args.online.has(m))) return null

  // The gain, in success chance where the simulator can be trusted.
  let successPp: number | null = null
  const full = seats.every((s) => s.occupant)
  if (args.successOf && full) {
    const vec = (assign: number[]) => {
      const out: Record<string, number> = {}
      members.forEach((m, k) => { out[seats[assign[k]].pid] = cprOf(m, assign[k])! })
      return out
    }
    successPp = (args.successOf(vec(best)) - args.successOf(vec(now))) * 100
  }
  if (successPp != null ? successPp < (args.minGainPp ?? SWAP_MIN_GAIN_PP_DEFAULT)
    : weightedGain < (args.minWeightedGain ?? SWAP_MIN_WEIGHTED_GAIN_DEFAULT)) return null

  const name = (m: string) => args.names.get(m) ?? m
  const target = new Map(members.map((m, k) => [m, best[k]]))
  const steps = moveSequence(seats.map((s) => s.occupant), target, leaver)
    .map((mv) => mv.kind === 'leave'
      ? `${name(mv.member)} leaves the crime (their planning is complete, so nothing is lost)`
      : mv.kind === 'join'
        ? `${name(mv.member)} rejoins as ${seats[mv.to].label}`
        : `${name(mv.member)} moves to ${seats[mv.to].label}`)
  const pct = (w: number) => `${Math.round((w / totalWeight) * 100)}%`
  const lines = movers.map((m) => {
    const from = seats[current.get(m)!]
    const to = seats[target.get(m)!]
    return `${name(m)}: ${from.label} (CPR ${cprOf(m, current.get(m)!)}, ${pct(from.weight)} weight) → `
      + `${to.label} (CPR ${cprOf(m, target.get(m)!)}, ${pct(to.weight)} weight)`
  })
  const worth = successPp != null ? `+${successPp.toFixed(1)}% success` : `+${weightedGain.toFixed(1)} weighted CPR`
  return {
    key: `swap:${crime.id}:${[...target.entries()].filter(([m]) => movers.includes(m))
      .map(([m, i]) => `${m}@${seats[i].pid}`).sort().join(',')}`,
    kind: 'swap',
    crimeId: String(crime.id),
    memberIds: [...movers, ...(leaver && !movers.includes(leaver) ? [leaver] : [])],
    title: `${crime.name} (L${crime.difficulty}) — reseat for ${worth}`,
    body: lines.join('\n') + (successPp == null
      ? '\n_Success chance not computed for this crime; the gain is in role-weighted CPR._' : ''),
    steps,
    value: successPp != null ? { success_pp: Math.round(successPp * 10) / 10 } : { weighted_gain: Math.round(weightedGain * 10) / 10 },
    severity: (successPp ?? weightedGain) >= 5 ? 'warn' : 'info',
    expiresAt: crime.status === 'Planning' && crime.ready_at ? crime.ready_at * 1000 : null,
  }
}

export type Move = { kind: 'move' | 'join'; member: string; to: number } | { kind: 'leave'; member: string }

/**
 * The moves from `seating` to `target`, through one free seat.
 *
 * A member whose target seat is empty moves straight there; when every
 * misplaced member's target is taken (a cycle), one of them steps into a free
 * seat to break it. `leaver` (an idle member in a full crime) leaves first and
 * rejoins last, into the seat that is left.
 */
export function moveSequence(seating: (string | null)[], target: Map<string, number>, leaver: string | null = null): Move[] {
  const seat = [...seating]
  const moves: Move[] = []
  const pos = (m: string) => seat.indexOf(m)
  if (leaver) { seat[pos(leaver)] = null; moves.push({ kind: 'leave', member: leaver }) }
  const pending = () => [...target.entries()].filter(([m, i]) => m !== leaver && pos(m) !== i)
  for (let guard = 0; guard < 4 * seat.length && pending().length; guard++) {
    const direct = pending().find(([, i]) => seat[i] == null)
    if (direct) {
      const [m, i] = direct
      seat[pos(m)] = null; seat[i] = m; moves.push({ kind: 'move', member: m, to: i })
      continue
    }
    // A cycle: park one member in a free seat that is nobody's target if
    // possible, else any free seat.
    const [m] = pending()[0]
    const targets = new Set(target.values())
    const free = seat.findIndex((x, i) => x == null && !targets.has(i))
    const any = free >= 0 ? free : seat.findIndex((x) => x == null)
    if (any < 0) break
    seat[pos(m)] = null; seat[any] = m; moves.push({ kind: 'move', member: m, to: any })
  }
  if (leaver) {
    const to = target.get(leaver) ?? seat.findIndex((x) => x == null)
    moves.push({ kind: 'join', member: leaver, to })
  }
  return moves
}

/** A previous swap suggestion is resolved once every member sits where it said. */
export function swapResolved(key: string, crimes: SwapCrime[]): boolean {
  const [, crimeId, pairs] = key.split(':')
  const crime = crimes.find((c) => String(c.id) === crimeId)
  if (!crime || !pairs) return false
  return pairs.split(',').every((p) => {
    const [m, pid] = p.split('@')
    return (crime.slots ?? []).some((s) => String(s.position_info?.id) === pid && String(s.user?.id) === m)
  })
}


/**
 * The best placement of `members` over the seats they currently hold
 * (`now[k]` is member k's seat), by Σ weight × CPR. Shared by the swap
 * suggestions (#1021) and the efficiency report (#1024) so both judge a crew
 * the same way.
 *
 * ⚠️ Only the seats already held — an empty seat scores nothing, so spreading
 * into one would "gain" by pushing anyone into a heavy role. Returns null when
 * the current arrangement itself cannot be scored (a seat with no CPR).
 * Ties keep the current arrangement.
 */
export function bestArrangement(
  members: string[], now: number[], cprOf: (member: string, seat: number) => number | null, weights: number[],
): { best: number[]; nowScore: number; bestScore: number } | null {
  const score = (assign: number[]) => {
    let sc = 0
    for (let k = 0; k < members.length; k++) {
      const c = cprOf(members[k], assign[k])
      if (c == null) return null
      sc += weights[assign[k]] * c
    }
    return sc
  }
  const nowScore = score(now)
  if (nowScore == null) return null
  let best = now
  let bestScore = nowScore
  const used = new Array(now.length).fill(false)
  const pick: number[] = []
  const walk = (k: number) => {
    if (k === members.length) {
      const sc = score(pick)
      if (sc != null && sc > bestScore + 1e-9) { bestScore = sc; best = [...pick] }
      return
    }
    for (let j = 0; j < now.length; j++) {
      if (used[j]) continue
      used[j] = true; pick.push(now[j]); walk(k + 1); pick.pop(); used[j] = false
    }
  }
  walk(0)
  return { best, nowScore, bestScore }
}
