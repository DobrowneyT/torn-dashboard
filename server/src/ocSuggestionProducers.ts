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
      const minutes = Math.max(0, Math.round((args.nowSec - joined) / 60))
      live.push({
        key: `too_low:${id}:${c.id}`,
        kind: 'too_low',
        crimeId: String(c.id),
        memberIds: [id],
        title: `${name} joined ${c.name} (L${c.difficulty})`,
        body: `${where(best)} has an open seat — ${seatLine(best)}.\n`
          + `They joined ${minutes} min ago, so moving now loses little progress.`,
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
    const since = last == null ? 'not seen in a crime yet' : `out of a crime for ${fmtDuration(args.nowSec - last)}`
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

function fmtDuration(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.round((sec % 3600) / 60)
  return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : h ? `${h}h ${m}m` : `${m}m`
}
