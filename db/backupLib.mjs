// Pure helpers for the nightly backup job (#76). Deterministic and
// dependency-free so they unit-test without a database or shell-outs; the
// pg_dump / psql / rclone orchestration that uses them lives in db/backup.mjs
// and db/restore.mjs and is proven by the compose E2E.

/**
 * Every live application database is `faction_<slug>`; map pg_database rows to
 * those. Staging copies (`faction_<slug>_dev`, #292) are deliberately excluded:
 * this drives the nightly backup and deploy/update.sh's migrate loop, and the
 * prod cron must never write to — or waste an archive on — a dev database.
 */
export function factionDbsFromRows(rows) {
  return rows
    .map((r) => r.datname)
    .filter((name) => name.startsWith('faction_') && !name.endsWith('_dev'))
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
 * rclone argv for pruning the OFF-SITE copies (#117). Scoped with --include so
 * a shared or dirty bucket path can never lose foreign files to our retention
 * sweep — only names shaped like our archives qualify, and only those older
 * than the window (rclone --min-age selects files OLDER than the given age).
 */
export function remotePruneArgs(remote, retentionDays) {
  return ['delete', '--min-age', `${retentionDays}d`, '--include', 'faction_*.sql.gz', remote]
}

/**
 * rclone argv for collecting the hidden versions B2 keeps behind our prune
 * (#510). Deleting a file on B2 does not free its bytes — a hidden version
 * remains until a lifecycle rule or an explicit cleanup collects it, and
 * nothing here ever did: 3 GiB of the 9.34 GiB billed was deleted files.
 *
 * ⚠️ `cleanup` is bucket-wide — it takes no --include, so unlike
 * remotePruneArgs() it cannot be scoped to our own archives. It only ever
 * removes SUPERSEDED and hidden versions, never a current file, so the blast
 * radius is old copies of whatever shares the bucket. That is acceptable here
 * only because this bucket holds database dumps and nothing else, which is
 * also why the issue says never to put public files in it.
 */
export function remoteCleanupArgs(remote) {
  return ['cleanup', remote]
}

/**
 * Does this faction already have an archive inside `withinHours` of `now`?
 *
 * The deploy-day volume fix (#510): a deploy dumps every database twice, once
 * from update.sh (the rollback path — always runs) and again when the restarted
 * sidecar starts. This is what lets the second one stand down.
 *
 * Compares on the NEWEST matching archive and treats a future-dated one as
 * fresh, so clock skew between the box and a restored volume can only ever
 * cause one dump too few, never a spurious extra one.
 */
export function hasFreshBackup(names, slug, now, withinHours) {
  const windowMs = withinHours * 60 * 60 * 1000
  for (const name of names) {
    const { slug: found, at } = parseBackup(name)
    if (at === null || found !== slug) continue
    if (now.getTime() - at.getTime() < windowMs) return true
  }
  return false
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

/**
 * Network-bounding flags for every rclone invocation (#B2-hang).
 *
 * Without these, rclone waits indefinitely on an unreachable remote. During a
 * Backblaze maintenance window that wedged a pre-deploy backup for over an
 * hour, which in turn held deploy/update.sh's flock, so every subsequent
 * auto-deploy logged "another update is already running" and skipped. The
 * stack silently stopped updating with no error anywhere.
 *
 * Deliberately short: an upload that has not made progress in two minutes is
 * not going to, and the LOCAL archive — the one a deploy actually depends on —
 * is already written by the time we get here.
 */
export function rcloneFlags() {
  return [
    '--contimeout', '30s',
    '--timeout', '120s',
    '--retries', '2',
    '--low-level-retries', '3',
  ]
}

/**
 * The closing summary line.
 *
 * Names failed uploads explicitly rather than letting a local-only run read as
 * a full success — "6 archived" while the offsite copy silently did not happen
 * is exactly the kind of quiet half-failure that only surfaces when you need
 * the backup.
 */
export function summarize({ archived, uploadFailures, pruned, retentionDays, remote, skipped = 0 }) {
  const parts = [`${archived} archived`]
  if (skipped > 0) parts.push(`${skipped} already fresh`)
  if (remote) {
    parts.push(uploadFailures === 0
      ? `${archived} uploaded`
      : `⚠️ ${uploadFailures} UPLOAD(S) FAILED — local only`)
  }
  parts.push(`${pruned} local expired removed (retention ${retentionDays}d)`)
  return `Backups complete: ${parts.join(', ')}.`
}
