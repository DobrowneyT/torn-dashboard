// Scoped-role grants for a faction database (#115).
//
// A faction API connects as `app_<slug>`, never as the superuser, and REVOKEing
// CONNECT from PUBLIC is what makes the per-faction isolation real. Those
// privileges live in the *cluster/database*, not in the schema — so `pg_dump
// --no-privileges` (what db/backup.mjs produces) carries none of them, and a
// restored database is unreadable by the API until they are re-applied.
//
// Hence this module: one idempotent routine, shared by db/new-faction.mjs
// (fresh provisioning) and db/restore.mjs (making a restored DB bootable).

/** Slug → role name. `faction_forge` / `forge` both yield `app_forge`. */
export function roleNameForDb(dbName) {
  const m = /^faction_(.+)$/.exec(dbName)
  return m ? `app_${m[1]}` : null
}

/**
 * Grant `roleName` everything the faction API needs on `dbName`, idempotently.
 *
 * `password` is only used when the role must be CREATEd. When the role already
 * exists we deliberately leave its credential alone — it lives in deploy/.env,
 * and rotating it here would silently break a running API.
 *
 * `client` must be connected to `dbName` as a superuser for the table/sequence
 * grants to apply; the database-level GRANT works from any connection.
 */
export async function applyScopedGrants(client, { dbName, roleName, password }) {
  if (!/^[a-z0-9_]+$/.test(dbName) || !/^[a-z0-9_]+$/.test(roleName)) {
    throw new Error(`Unsafe identifier: ${dbName} / ${roleName}`)
  }

  // `GRANT ... ON ALL TABLES IN SCHEMA public` applies to the CURRENT database.
  // Connected to the wrong one, every statement below "succeeds" while granting
  // nothing useful — a silent no-op that leaves the API unable to read. Refuse.
  const cur = await client.query('SELECT current_database() AS db')
  if (cur.rows[0].db !== dbName) {
    throw new Error(
      `applyScopedGrants must run on ${dbName}, but this client is connected to ${cur.rows[0].db}`
    )
  }

  const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [roleName])
  if (exists.rowCount === 0) {
    if (!password) throw new Error(`Role ${roleName} does not exist and no password was supplied`)
    await client.query(`CREATE ROLE ${roleName} LOGIN PASSWORD '${password.replace(/'/g, "''")}'`)
  }

  // Isolation: only this role may reach this database.
  await client.query(`REVOKE CONNECT ON DATABASE ${dbName} FROM PUBLIC`)
  await client.query(`GRANT CONNECT ON DATABASE ${dbName} TO ${roleName}`)

  // Objects. GRANT is idempotent, so re-applying is free.
  await client.query(`GRANT USAGE ON SCHEMA public TO ${roleName}`)
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${roleName}`)
  await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${roleName}`)

  // Tables created later (db/migrate.mjs runs as the admin user) stay reachable.
  await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${roleName}`)
  await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${roleName}`)
}
