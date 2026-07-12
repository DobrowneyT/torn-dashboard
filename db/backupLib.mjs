// Pure helpers for the nightly backup job (#76). Deterministic and
// dependency-free so they unit-test without a database or shell-outs; the
// pg_dump / psql / rclone orchestration that uses them lives in db/backup.mjs
// and db/restore.mjs and is proven by the compose E2E.

/** Every application database is `faction_<slug>`; map pg_database rows to those. */
export function factionDbsFromRows(rows) {
  return rows
    .map((r) => r.datname)
    .filter((name) => name.startsWith('faction_'))
    .map((db) => ({ db, slug: db.slice('faction_'.length) }))
}

/** Compact UTC instant, filename-safe: 2026-07-12T13:15:00Z. */
function basicIso(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '')
}

const NAME_RE = /^faction_(.+)_(\d{8}T\d{6}Z)\.sql\.gz$/

/** Archive name for a faction DB dumped at a given instant. */
export function backupName(slug, date) {
  return `faction_${slug}_${basicIso(date)}.sql.gz`
}

/** Parse an archive name back to { slug, at:Date|null }; at is null if not ours. */
export function parseBackup(name) {
  const m = NAME_RE.exec(name)
  if (!m) return { slug: null, at: null }
  const [, slug, stamp] = m
  // 20260712T131500Z → 2026-07-12T13:15:00Z
  const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T` +
    `${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`
  return { slug, at: new Date(iso) }
}

/**
 * Names to prune: our archives strictly older than `retentionDays` before
 * `now`. Non-archive files are never selected. The boundary day is kept.
 */
export function selectExpired(names, now, retentionDays) {
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000
  return names.filter((name) => {
    const { at } = parseBackup(name)
    return at !== null && at.getTime() < cutoff
  })
}
