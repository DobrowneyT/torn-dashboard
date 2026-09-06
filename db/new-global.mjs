// Provisions the shared `global` database (#609 slice 1).
//
// Creates the database, applies db/global-template.sql, and creates the two
// roles the architecture depends on:
//
//   app_global_ro   every tenant API. SELECT only.
//   app_global_rw   the admin container. The only writer in the fleet.
//
// ⚠️ Why two roles and not one. The #608 audit chose "tenants read `global`
// directly" over push or pull because it keeps the admin container out of every
// tenant's read path — which is what makes "killing the admin container leaves
// every tenant working" true by construction. That only holds if a tenant
// physically cannot write: a tenant with INSERT on a shared table could corrupt
// what every other faction reads, a worse failure than the duplication this
// replaces. The read-only role is the enforcement, not a convention.
//
//   node db/new-global.mjs
//   node db/new-global.mjs --adopt    # existing DB → apply grants only
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { parseArgs } from 'node:util'
import dotenv from 'dotenv'
import pg from 'pg'
import { applyScopedGrants, applyReadOnlyGrants } from './grants.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const deployDir = join(here, '..', 'deploy')
const composeEnv = {}
dotenv.config({ path: join(deployDir, '.env'), processEnv: composeEnv })

const { values: args } = parseArgs({ options: { adopt: { type: 'boolean' } } })
const adopt = args.adopt === true

const dbName = process.env.GLOBAL_DB_NAME ?? 'global'
const readerRole = 'app_global_ro'
const writerRole = 'app_global_rw'

// Same guard db/new-faction.mjs applies: these names are interpolated into
// CREATE DATABASE / CREATE ROLE, so they are validated before they get there.
if (!/^[a-z][a-z0-9_]{1,20}$/.test(dbName)) {
  console.error(`Invalid global database name "${dbName}"`)
  process.exit(2)
}

const conn = {
  host: process.env.PGHOST ?? '127.0.0.1',
  port: Number(process.env.PGPORT ?? composeEnv.POSTGRES_HOST_PORT ?? 5432),
  user: process.env.PGUSER ?? composeEnv.POSTGRES_USER ?? 'postgres',
  password: process.env.PGPASSWORD ?? composeEnv.POSTGRES_PASSWORD,
}

const admin = new pg.Client({ ...conn, database: 'postgres' })
await admin.connect()
try {
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName])
  if (exists.rowCount > 0 && !adopt) {
    console.error(`Database ${dbName} already exists — re-run with --adopt to (re)apply grants.`)
    process.exit(2)
  }
  if (exists.rowCount === 0) await admin.query(`CREATE DATABASE ${dbName}`)
} finally {
  await admin.end()
}

const db = new pg.Client({ ...conn, database: dbName })
await db.connect()

/** A credential already in deploy/.env must never be regenerated — a running
 *  service is using it, and rotating here would break it silently. */
function existingEnvValue(key) {
  const path = join(deployDir, '.env')
  if (!existsSync(path)) return null
  const m = new RegExp(`^${key}=(.*)$`, 'm').exec(readFileSync(path, 'utf8'))
  return m ? m[1] : null
}

function appendEnv(key, value) {
  const path = join(deployDir, '.env')
  // A hand-edited .env may lack a trailing newline; appending must never glue
  // onto its last line (the same trap db/new-faction.mjs guards).
  const needsEol = existsSync(path) && !readFileSync(path, 'utf8').endsWith('\n')
  appendFileSync(path, `${needsEol ? '\n' : ''}${key}=${value}\n`)
}

try {
  await db.query(readFileSync(join(here, 'global-template.sql'), 'utf8'))

  // Isolation first: only the two named roles may reach this database.
  await db.query(`REVOKE CONNECT ON DATABASE ${dbName} FROM PUBLIC`)

  // Writer — the admin container. applyScopedGrants gives full DML, which is
  // correct here and would be badly wrong for the reader.
  const rwExisting = existingEnvValue('DB_PASSWORD_GLOBAL_RW')
  const rwPassword = rwExisting ?? randomBytes(24).toString('hex')
  await applyScopedGrants(db, { dbName, roleName: writerRole, password: rwPassword })
  if (!rwExisting) appendEnv('DB_PASSWORD_GLOBAL_RW', rwPassword)

  // Reader — every tenant. SELECT only, including on tables added later.
  const roExisting = existingEnvValue('DB_PASSWORD_GLOBAL_RO')
  const roPassword = roExisting ?? randomBytes(24).toString('hex')
  await applyReadOnlyGrants(db, { dbName, roleName: readerRole, password: roPassword })
  if (!roExisting) appendEnv('DB_PASSWORD_GLOBAL_RO', roPassword)

  console.log(`
Global database ready: ${dbName}
  ${writerRole}  full DML   (admin container)
  ${readerRole}  SELECT only (every tenant)

Credentials appended to deploy/.env as DB_PASSWORD_GLOBAL_RW / DB_PASSWORD_GLOBAL_RO
(existing values are reused, never rotated).

Next, in deploy/.env add ONE line (compose interpolates it into every tenant):
  GLOBAL_DATABASE_URL=postgres://${readerRole}:<DB_PASSWORD_GLOBAL_RO>@postgres:5432/${dbName}

⚠️ Factions provisioned BEFORE this feature have no GLOBAL_DATABASE_URL line in
their docker-compose.override.yml service block. Add it to each api-<slug>:

      GLOBAL_DATABASE_URL: \${GLOBAL_DATABASE_URL:-}

then \`docker compose up -d\` those services. Until then they simply run without
control-plane reads, which is a supported state — nothing breaks.
`)
} finally {
  await db.end()
}
