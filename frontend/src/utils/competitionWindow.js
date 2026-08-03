// Competition window boundary helpers (#229/#231). A boundary is a timestamp;
// the create form offers an optional time-of-day, and the display shows the
// exact time in Torn City Time (TCT = UTC). Date-only boundaries (start-of-day /
// end-of-day) hide the time to keep the common case clean.

// Build the value to submit for a boundary: a full ISO timestamp when a
// time-of-day is given, otherwise the bare date (the API maps a date to
// start-of-day / end-of-day). `time` is "HH:MM" in Torn City Time (= UTC).
export function boundaryValue(date, time) {
  if (!date) return ''
  return time ? `${date}T${time}:00.000Z` : date
}

// Parse a stored boundary (ISO from the API, or Postgres timestamptz text) to a
// Date, or null.
export function parseBoundary(v) {
  if (!v) return null
  let s = String(v)
  if (s.includes(' ') && !s.includes('T')) s = s.replace(' ', 'T') // PG "date time" → ISO
  s = s.replace(/([+-]\d{2})$/, '$1:00')                            // bare ±HH offset → ±HH:MM
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

const pad = (n) => String(n).padStart(2, '0')

// Format a boundary for display in Torn City Time. A date-only boundary
// (00:00 start / 23:59 end) shows just the date; an explicit time adds "HH:MM TCT".
export function fmtBoundary(v, edge) {
  const d = parseBoundary(v)
  if (!d) return ''
  const date = d.toISOString().slice(0, 10)
  const h = d.getUTCHours()
  const m = d.getUTCMinutes()
  const isStartOfDay = edge === 'start' && h === 0 && m === 0 && d.getUTCSeconds() === 0
  const isEndOfDay = edge === 'end' && h === 23 && m === 59
  if (isStartOfDay || isEndOfDay) return date
  return `${date} ${pad(h)}:${pad(m)} TCT`
}

// The window summary shown to every member, including the exact end time.
export function windowLabel(c) {
  if (c.window_kind === 'rolling') return `rolling · last ${c.rolling_days} days`
  return `${fmtBoundary(c.window_start, 'start')} → ${fmtBoundary(c.window_end, 'end')}`
}
