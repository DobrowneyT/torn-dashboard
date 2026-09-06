// Applies migrations (in filename order) to a local database.
// Every migration file is written to be idempotent, so re-running is safe.
// template.sql stays the source of truth for NEW databases; this brings
// EXISTING databases (created from an older template) up to the same shape.
//
//   node db/migrate.mjs [--db faction_forge]     # a faction DB
//   node db/migrate.mjs --global                 # the shared global DB (#609)
//
// ⚠️ Two lanes, deliberately separate. The `global` database (#608/#609) holds
// Torn-wide facts every tenant reads and has a different shape from a faction
// database entirely — running one lane against the other would apply the wrong
// schema to a live database. Selecting the lane by an explicit flag, rather
// than inferring it from the database name, keeps that mistake impossible to
// make by accident.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readdirSync, readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import dotenv from 'dotenv'
import pg from 'pg'

const here = dirname(fileURLToPath(import.meta.url))
const composeEnv = {}
dotenv.config({ path: join(here, '..', 'deploy', '.env'), processEnv: composeEnv })

const { values: args } = parseArgs({
  options: { db: { type: 'string' }, global: { type: 'boolean' } },
})
if (args.global && args.db) {
  console.error('Pass either --global or --db, not both.')
  process.exit(2)
}
const dbName = args.global ? (process.env.GLOBAL_DB_NAME ?? 'global') : (args.db ?? 'faction_forge')
const migrationsDir = args.global ? 'migrations-global' : 'migrations'

const db = new pg.Client({
  host: '127.0.0.1',
  port: Number(process.env.PGPORT ?? composeEnv.POSTGRES_HOST_PORT ?? 5432),
  user: process.env.PGUSER ?? composeEnv.POSTGRES_USER ?? 'postgres',
  password: process.env.PGPASSWORD ?? composeEnv.POSTGRES_PASSWORD,
  database: dbName,
})
await db.connect()

try {
  const files = readdirSync(join(here, migrationsDir)).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) {
    const sql = readFileSync(join(here, migrationsDir, file), 'utf8')
    await db.query(sql)
    console.log(`applied ${file}`)
  }
  console.log(`Migrations applied to ${dbName} (${migrationsDir}).`)
} finally {
  await db.end()
}
