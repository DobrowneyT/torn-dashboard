// Restore drill (#76 / slice 18).
//
//   node db/restore.mjs --archive deploy/backups/faction_forge_....sql.gz \
//                       --db faction_scratch [--create]
//
// Restores a gzipped pg_dump archive into a target database so an operator can
// prove a backup is good (restore to a scratch DB and boot the stack against
// it — see deploy/README.md "Restore drill"). With --create the target is
// dropped and recreated first. Prints a table/row summary as a smoke check.
//
// Uses psql/dropdb/createdb from the host (or the postgres container in the
// compose E2E). Kept a thin shell-out; the naming lives in db/backupLib.mjs.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { createGunzip } from 'node:zlib'
import { parseArgs } from 'node:util'
import { pipeline } from 'node:stream/promises'
import dotenv from 'dotenv'
import pg from 'pg'

const here = dirname(fileURLToPath(import.meta.url))
const composeEnv = {}
dotenv.config({ path: join(here, '..', 'deploy', '.env'), processEnv: composeEnv })

const { values: args } = parseArgs({
  options: {
    archive: { type: 'string' },
    db: { type: 'string' },
    create: { type: 'boolean' },
  },
})
if (!args.archive || !args.db) {
  console.error('Usage: node db/restore.mjs --archive <file.sql.gz> --db <target> [--create]')
  process.exit(1)
}
if (!existsSync(args.archive)) {
  console.error(`Archive not found: ${args.archive}`)
  process.exit(1)
}

const conn = {
  host: process.env.PGHOST ?? '127.0.0.1',
  port: Number(process.env.PGPORT ?? composeEnv.POSTGRES_HOST_PORT ?? 5432),
  user: process.env.PGUSER ?? composeEnv.POSTGRES_USER ?? 'postgres',
  password: process.env.PGPASSWORD ?? composeEnv.POSTGRES_PASSWORD,
}
const pgEnv = { ...process.env, PGPASSWORD: conn.password ?? '' }
const baseArgs = ['--host', conn.host, '--port', String(conn.port), '--username', conn.user]

if (args.create) {
  // Recreate the scratch target — never the production DB by accident.
  execFileSync('dropdb', [...baseArgs, '--if-exists', args.db], { stdio: 'inherit', env: pgEnv })
  execFileSync('createdb', [...baseArgs, args.db], { stdio: 'inherit', env: pgEnv })
}

// gunzip archive → psql into the target DB. --set ON_ERROR_STOP so a bad
// restore fails loudly instead of a half-populated DB.
const psql = spawn(
  'psql',
  [...baseArgs, '--dbname', args.db, '--set', 'ON_ERROR_STOP=on', '--quiet'],
  { env: pgEnv, stdio: ['pipe', 'inherit', 'inherit'] }
)
// Attach the exit listener before the pipeline to avoid a close-before-listen race.
const exited = new Promise((resolve, reject) => {
  psql.on('close', resolve)
  psql.on('error', reject)
})
await pipeline(createReadStream(args.archive), createGunzip(), psql.stdin)
const code = await exited
if (code !== 0) {
  console.error(`psql restore exited ${code}`)
  process.exit(1)
}

// Smoke check: a restored stack DB should have its tables and some rows.
const client = new pg.Client({ ...conn, database: args.db })
await client.connect()
try {
  const tables = await client.query(
    `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`
  )
  const cfg = await client.query(`SELECT slug, torn_faction_id FROM faction_config LIMIT 1`)
  console.log(`Restored ${args.db}: ${tables.rows[0].n} public tables; ` +
    `faction_config = ${cfg.rows[0] ? `${cfg.rows[0].slug}/${cfg.rows[0].torn_faction_id}` : '(none)'}.`)
} finally {
  await client.end()
}
