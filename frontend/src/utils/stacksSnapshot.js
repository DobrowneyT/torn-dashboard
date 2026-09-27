// The pre-war stacks & roll call sheet (#480, reshaped 2026-09-27).
//
// ⚠️ **The sheet answers three questions, in this order**: what did they SAY
// they would do, were they READY (stacked, not overdosed), and did they SHOW
// UP. MonChoon: "the spirit of the sheet is a post-war post-mortem — who said
// they would be available and was ready and showed up… also nice to see people
// who said they wouldn't be there but were still prepared or showed up anyway."
//
// The columns it used to carry were shaped by what happened to be in the table
// rather than by that question, which is why three of them had to go:
//
//   • `Reading` — a yes/no for "did a pooled key answer". It is the ENERGY
//     cell's own caveat, not a fact about the member, and it already renders
//     there as "unknown".
//   • `Max Energy` — never read on its own; the table always showed `795/150`.
//   • `Said online` — the yes/no half of a roll call answer whose other half
//     (`Availability`) already contains it. "yes" and "on_time" were the same
//     statement in two columns, and a row could show `no` + `on_time`, which
//     reads as a contradiction rather than as the revision it is.
import { rollCallLabel, rollCallState } from './rollCall'

/** Seconds of inactivity below which somebody was, in any useful sense, there. */
export const ACTIVE_WINDOW_SEC = 15 * 60

/**
 * How long before the snapshot this member was last active, in seconds.
 *
 * `null` when it was never recorded — which is NOT the same as "inactive", and
 * the two must never render alike. Snapshots taken before the activity columns
 * existed can never be backfilled, so this null is permanent for those wars.
 */
export function idleSeconds(row) {
  const la = Number(row?.last_action_epoch)
  if (!la) return null
  const captured = row?.captured_at ? Date.parse(row.captured_at) : NaN
  // ⚠️ `captured_at` crosses the wire as a Postgres timestamptz string with a
  // bare two-digit offset, which `Date.parse` rejects outright — the same trap
  // that took the chain sampler down for two days. Fall back to "now" rather
  // than emitting NaN, and never let it reach a formatter.
  const base = Number.isFinite(captured) ? captured : Date.now()
  const seconds = Math.floor(base / 1000) - la
  return seconds >= 0 ? seconds : 0
}

/** "3m", "1h 12m", "2d" — compact enough for a column, exact enough to judge. */
export function formatIdle(seconds) {
  if (seconds == null) return null
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return h < 10 ? `${h}h ${m % 60}m` : `${h}h`
  return `${Math.floor(h / 24)}d`
}

/**
 * Sort key for the activity column.
 *
 * ⚠️ Unrecorded sinks to the BOTTOM in both directions, the same rule the War
 * Room flags column follows: reversing the sort should show the other end of
 * the real data, not a screen of blanks.
 */
export function idleRank(row) {
  const s = idleSeconds(row)
  return s == null ? null : s
}

/** Was this member, by any reasonable reading, present when the war started? */
export function wasAround(row) {
  const s = idleSeconds(row)
  return s == null ? null : s <= ACTIVE_WINDOW_SEC
}

/**
 * The post-mortem verdict for one row: did what they said match what they did?
 *
 * ⚠️ This is the column the sheet exists for, and it is DERIVED rather than
 * stored — every input is already on the row, and a stored verdict would go
 * stale the moment the thresholds were argued about.
 */
export function outcome(row) {
  const said = rollCallState(row)          // 'here' | '1_2h' | … | 'unavailable' | 'na'
  const around = wasAround(row)
  if (around == null) return { key: 'unknown', label: '—' }
  const expected = said === 'here'
  if (expected && around) return { key: 'kept', label: 'Showed' }
  if (expected && !around) return { key: 'missed', label: 'No-show' }
  // ⚠️ The case MonChoon explicitly asked for: people who said they could not
  // make it and turned up anyway. Worth seeing, and worth NOT filing under the
  // same label as somebody who simply did as they promised.
  if (!expected && around) return { key: 'bonus', label: 'Turned up' }
  return { key: 'as_said', label: 'As stated' }
}

/** Energy as a fraction of max — the "were they stacked" number, 0..n. */
export function stackRatio(row) {
  if (!row?.has_reading) return null
  const max = Number(row.energy_maximum)
  if (!max) return null
  return Number(row.energy_current) / max
}

/** Every column, with how it sorts. Shared by the table and the CSV so the two cannot drift. */
export const SNAPSHOT_COLUMNS = [
  { key: 'member',   label: 'Member',    align: 'left',  sort: (r) => (r.member_name || '').toLowerCase() },
  { key: 'rollCall', label: 'Roll call', align: 'left',  sort: (r) => rollCallLabel(r) },
  { key: 'energy',   label: 'Energy',    align: 'right', sort: (r) => stackRatio(r) },
  { key: 'od',       label: 'OD',        align: 'left',  sort: (r) => (r.od_flagged_prewar ? 1 : 0) },
  { key: 'activity', label: 'LA',        align: 'right', sort: (r) => idleRank(r) },
  { key: 'outcome',  label: 'Outcome',   align: 'left',  sort: (r) => outcome(r).label },
  { key: 'revised',  label: 'Revised',   align: 'left',  sort: (r) => (r.revised ? 1 : 0) },
]

/**
 * Sort rows by one column.
 *
 * ⚠️ `null` sinks in BOTH directions, and name always breaks the tie in a fixed
 * direction — without that, rows with equal values reshuffle every render and
 * the table appears to move on its own.
 */
export function sortSnapshot(rows, key, dir = 1) {
  const col = SNAPSHOT_COLUMNS.find(c => c.key === key) ?? SNAPSHOT_COLUMNS[0]
  const name = SNAPSHOT_COLUMNS[0].sort
  return [...rows].sort((a, b) => {
    const av = col.sort(a), bv = col.sort(b)
    const aNull = av == null || av === '', bNull = bv == null || bv === ''
    if (aNull && bNull) return name(a).localeCompare(name(b))
    if (aNull) return 1
    if (bNull) return -1
    const cmp = typeof av === 'number' && typeof bv === 'number'
      ? av - bv
      : String(av).localeCompare(String(bv))
    return cmp !== 0 ? dir * cmp : name(a).localeCompare(name(b))
  })
}
