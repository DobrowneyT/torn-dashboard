// Applies db/migrations/*.sql (in filename order) to a local faction DB.
// Every migration file is written to be idempotent, so re-running is safe.
// template.sql stays the source of truth for NEW databases; this brings
// EXISTING databases (created from an older template) up to the same shape.
//
//   node db/migrate.mjs [--db faction_forge]
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readdirSync, readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import dotenv from 'dotenv'
import pg from 'pg'

const here = dirname(fileURLToPath(import.meta.url))
const composeEnv = {}
dotenv.config({ path: join(here, '..', 'deploy', '.env'), processEnv: composeEnv })

const { values: args } = parseArgs({ options: { db: { type: 'string' } } })
const dbName = args.db ?? 'faction_forge'

const db = new pg.Client({
  host: '127.0.0.1',
  port: Number(process.env.PGPORT ?? composeEnv.POSTGRES_HOST_PORT ?? 5432),
  user: process.env.PGUSER ?? composeEnv.POSTGRES_USER ?? 'postgres',
  password: process.env.PGPASSWORD ?? composeEnv.POSTGRES_PASSWORD,
  database: dbName,
})
await db.connect()

try {
  const files = readdirSync(join(here, 'migrations')).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) {
    const sql = readFileSync(join(here, 'migrations', file), 'utf8')
    await db.query(sql)
    console.log(`applied ${file}`)
  }
  console.log(`Migrations applied to ${dbName}.`)
} finally {
  await db.end()
}
