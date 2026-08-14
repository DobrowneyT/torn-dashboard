/**
 * Per-member Torn event start windows (#459).
 *
 * MonChoon: *"you get 48h for the lifetime of an event and can adjust so the
 * start time is comfortable for you."*
 *
 * Each member picks their own hour, so during an event everyone's 48-hour
 * window opens at a different time. Knowing where they sit is genuine
 * coordination information — who is already inside their window, who has not
 * started yet, and who is about to run out.
 *
 * ⚠️ Torn's value is stored exactly as it states it ("11:30 TCT") and parsed
 * only here, at read time. Parsing on write would mean a format change is
 * silently wrong for every member at once with no raw value left to re-read.
 */

/** "11:30 TCT" → minutes past midnight TCT; null for anything unparseable. */
export function parseStartTime(raw) {
  if (typeof raw !== 'string') return null
  const m = /^\s*(\d{1,2}):(\d{2})/.exec(raw)
  if (!m) return null
  const hours = Number(m[1])
  const minutes = Number(m[2])
  // ⚠️ 24:00 and 61 minutes are not times. Torn is unlikely to send them, but
  // a "window" computed from a bad number would place someone's 48 hours in a
  // day that does not exist, and nothing downstream would notice.
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

/** "11:30 TCT", normalised and zero-padded; null when unreadable. */
export function formatStartTime(raw) {
  const mins = parseStartTime(raw)
  if (mins === null) return null
  const hh = String(Math.floor(mins / 60)).padStart(2, '0')
  const mm = String(mins % 60).padStart(2, '0')
  return `${hh}:${mm} TCT`
}

/**
 * The rows, readable and ordered by when each member's window opens.
 *
 * ⚠️ Members whose time we cannot read sink to the bottom in BOTH directions
 * (the #351 rule) — a stored string we failed to parse must not sort as
 * midnight and lead the list.
 */
export function eventWindowRows(rows, { direction = 'asc' } = {}) {
  const dir = direction === 'desc' ? -1 : 1
  return (rows ?? [])
    .map((r) => ({
      memberId: String(r.member_id),
      memberName: r.member_name || `Member ${r.member_id}`,
      raw: r.start_time ?? null,
      minutes: parseStartTime(r.start_time),
      label: formatStartTime(r.start_time),
      fetchedAt: r.fetched_at ?? null,
    }))
    .sort((a, b) => {
      if (a.minutes === null && b.minutes === null) return a.memberName.localeCompare(b.memberName)
      if (a.minutes === null) return 1
      if (b.minutes === null) return -1
      return dir * (a.minutes - b.minutes) || a.memberName.localeCompare(b.memberName)
    })
}

/**
 * Group the roster into hour buckets, so leadership can see the shape of the
 * faction's coverage rather than reading fifty rows.
 *
 * Only hours somebody actually picked appear. An empty hour is not information
 * — a 24-row table that is mostly zeroes hides the four rows that matter.
 */
export function coverageByHour(rows) {
  const buckets = new Map()
  for (const row of eventWindowRows(rows)) {
    if (row.minutes === null) continue
    const hour = Math.floor(row.minutes / 60)
    if (!buckets.has(hour)) buckets.set(hour, [])
    buckets.get(hour).push(row)
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hour, members]) => ({ hour, label: `${String(hour).padStart(2, '0')}:00`, members }))
}

/**
 * How many members have a readable window, out of how many are shown.
 *
 * ⚠️ Says nothing about the faction total on purpose. Members who did not opt
 * in are absent from `rows` entirely, so "12 of 80" would be reporting how many
 * people declined — which is not this feature's business to advertise.
 */
export function windowCoverage(rows) {
  const all = eventWindowRows(rows)
  return {
    shared: all.length,
    readable: all.filter((r) => r.minutes !== null).length,
  }
}
