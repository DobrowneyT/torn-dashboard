// DB timestamp parsing (#104). The API deliberately serves timestamps as
// Postgres text (PostgREST-shape contract, see server/src/db.ts) — but
// Postgres writes short UTC offsets ('+00') that JS Date rejects, and
// timestamp-without-tz values carry no offset at all (they are UTC).

/** Parse any timestamp shape this stack emits; null when absent/invalid. */
export function parseDbTime(ts) {
  if (!ts) return null
  let s = String(ts)
  // '+00' / '-05' → '+00:00' / '-05:00'
  s = s.replace(/([+-]\d{2})$/, '$1:00')
  // No offset and no Z → treat as UTC (PostgREST timestamp-without-tz shape).
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s)) s += 'Z'
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Local-time display, never 'Invalid Date' — a dash when unparseable. */
export function fmtDbTime(ts) {
  const d = parseDbTime(ts)
  return d ? d.toLocaleString() : '—'
}

/** Relative "time ago" for any DB timestamp shape; '—' when absent/invalid. */
export function fmtAgo(ts, nowMs = Date.now()) {
  const d = parseDbTime(ts)
  if (!d) return '—'
  const diff = Math.floor((nowMs - d.getTime()) / 1000)
  if (diff < 0) return 'just now'
  if (diff < 60) return 'just now'
  if (diff < 3_600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86_400) return `${Math.floor(diff / 3_600)}h ago`
  return `${Math.floor(diff / 86_400)}d ago`
}
