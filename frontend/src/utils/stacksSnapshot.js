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
import { parseDbTime } from './time'
import { sortRows } from './tableSort.js'

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
  // ⚠️ `parseDbTime`, never `Date.parse`. `captured_at` arrives as a Postgres
  // timestamptz with a bare two-digit offset (`...+00`) that the built-in
  // parser rejects outright — the same trap that took the chain sampler down
  // for two days, and the repo has a test forbidding the raw call.
  //
  // ⚠️ I first hand-rolled a fallback to `Date.now()` here. That is WORSE than
  // the NaN it was avoiding: on a sheet read weeks later it would have made
  // every member look freshly active, which is a confident wrong answer rather
  // than a missing one. Unparseable is `null` — "not recorded" — like every
  // other absent reading on this sheet.
  const captured = parseDbTime(row?.captured_at)
  if (!captured) return null
  const seconds = Math.floor(captured.getTime() / 1000) - la
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
/** What each outcome means, for the column's tooltip. One definition, not two. */
export const OUTCOME_LEGEND = [
  ['Showed',    'said they\u2019d be on at the start, and was'],
  ['No-show',   'said they\u2019d be on at the start, and wasn\u2019t'],
  ['Turned up', 'said they couldn\u2019t make it \u2014 and was there anyway'],
  ['As stated', 'said they couldn\u2019t make it, and wasn\u2019t'],
  ['\u2014',        'activity wasn\u2019t recorded for this war'],
]

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

/**
 * Energy at capture. `null` when no pooled key answered.
 *
 * ⚠️ **The raw number, not a ratio of maximum.** I shipped a stack-ratio sort
 * first, on the reasoning that 1000/150 is nearly seven stacks and 1000/1000 is
 * one. MonChoon, 2026-09-27: *"everyone has 150e energy anyway, so it's
 * redundant."* With a constant denominator the ratio is the raw number scaled,
 * so it sorts identically — and costs a column of `/150` that says nothing.
 */
export function energyValue(row) {
  if (!row?.has_reading) return null
  const e = Number(row.energy_current)
  return Number.isFinite(e) ? e : null
}

/** Every column, with how it sorts. Shared by the table and the CSV so the two cannot drift. */
export const SNAPSHOT_COLUMNS = [
  // ⚠️ `kind` is DECLARED rather than sniffed from the value (#835). The old
  // comparator asked `typeof av === 'number'` per pair, which silently fell back
  // to a string compare whenever a column went null for one row — exactly the
  // class of bug the shared comparator exists to remove.
  { key: 'member',   label: 'Member',    align: 'left',  kind: 'text',   accessor: (r) => (r.member_name || '').toLowerCase() },
  { key: 'rollCall', label: 'Roll call', align: 'left',  kind: 'text',   accessor: (r) => rollCallLabel(r) },
  { key: 'energy',   label: 'Energy',    align: 'right', kind: 'number', accessor: (r) => energyValue(r) },
  { key: 'od',       label: 'OD',        align: 'left',  kind: 'number', accessor: (r) => (r.od_flagged_prewar ? 1 : 0) },
  { key: 'activity', label: 'LA',        align: 'right', kind: 'number', accessor: (r) => idleRank(r) },
  { key: 'outcome',  label: 'Outcome',   align: 'left',  kind: 'text',   accessor: (r) => outcome(r).label },
  { key: 'revised',  label: 'Revised',   align: 'left',  kind: 'number', accessor: (r) => (r.revised ? 1 : 0) },
]

/**
 * Sort rows by one column.
 *
 * ⚠️ **Delegates to the shared comparator now (#835).** It is kept as a named
 * export, with its own tests unchanged, because those tests ARE the proof that
 * `sortRows` reproduces this table's behaviour exactly — `null` sinking in both
 * directions and member name always breaking the tie in a fixed direction.
 * If they go red, the shared primitive does not do what this table needs.
 *
 * `dir` stays numeric here (1 / -1) because that is what the callers pass.
 */
export function sortSnapshot(rows, key, dir = 1) {
  return sortRows(rows, SNAPSHOT_COLUMNS, key, dir < 0 ? 'desc' : 'asc',
                  { tieBreak: 'member' })
}
