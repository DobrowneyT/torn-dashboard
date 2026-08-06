// Pure helpers for the dev/staging clone (#292). Deterministic and
// dependency-free so they unit-test without a database or shell-outs; the
// pg_dump | psql orchestration that uses them lives in db/clone-tenant-dev.mjs
// and is exercised by the compose E2E.
//
// The naming contract is the whole safety model: a live tenant is
// `faction_<slug>`, its staging copy is `faction_<slug>_dev`, and nothing in
// the dev path is allowed to address a database without the `_dev` suffix.

const SLUG_RE = /^[a-z][a-z0-9_]*$/
const DEV_DB_RE = /^faction_(.+)_dev$/

/**
 * Slug → staging database name.
 *
 * The result is interpolated into `DROP DATABASE` / `CREATE DATABASE`, which
 * accept no bind parameters, so this validation is the injection boundary —
 * not a convenience check.
 */
export function devDbName(slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    throw new Error(`Invalid slug "${slug}" — lowercase letters, digits and underscores only`)
  }
  return `faction_${slug}_dev`
}

/** Is this a staging copy? */
export function isDevDb(name) {
  return DEV_DB_RE.test(name)
}

/** Staging database → the live tenant it was cloned from, or null. */
export function liveDbForDev(name) {
  const m = DEV_DB_RE.exec(name)
  return m ? `faction_${m[1]}` : null
}

/**
 * Fail closed unless `name` is a staging database.
 *
 * db/clone-tenant-dev.mjs drops and recreates its target. One bad argument
 * away from `faction_forge` is a live tenant, so the drop path calls this
 * first and every caller is expected to.
 */
export function assertDevTarget(name) {
  if (!isDevDb(name)) {
    throw new Error(
      `Refusing to operate on "${name}" — the dev clone only ever touches faction_<slug>_dev databases`
    )
  }
}

/** pg_database rows → the staging copies, for the dev migrate loop. */
export function devDbsFromRows(rows) {
  return rows
    .map((r) => r.datname)
    .filter(isDevDb)
    .map((db) => ({ db, slug: DEV_DB_RE.exec(db)[1] }))
}

/**
 * Connection URL for the dev API container: the tenant's own scoped role
 * against the staging copy, over the shared compose network. The role and its
 * credential are the live ones (db/clone-tenant-dev.mjs re-grants them on the
 * copy) — only the database differs, which is what keeps live data untouched.
 */
export function devDatabaseUrl({ slug, password, host = 'postgres', port = 5432 }) {
  return `postgres://app_${slug}:${encodeURIComponent(password ?? '')}@${host}:${port}/${devDbName(slug)}`
}

/**
 * Every scraper is off in a fresh clone. Enabling one is a deliberate,
 * per-job act by the operator — an enabled job would otherwise start calling
 * real Torn with the copied key pool the moment the instance came up.
 */
export const DISABLE_SCRAPERS_SQL = 'UPDATE scraper_jobs SET enabled = false'
