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
import { applyScopedGrants, roleNameForDb } from './grants.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const composeEnv = {}
dotenv.config({ path: join(here, '..', 'deploy', '.env'), processEnv: composeEnv })

const { values: args } = parseArgs({
  options: {
    archive: { type: 'string' },
    db: { type: 'string' },
    create: { type: 'boolean' },
    // Which scoped role to re-grant on the restored DB (#115). Dumps carry no
    // privileges, so without this the API cannot read what we just restored.
    // Defaults to app_<slug> derived from a `faction_<slug>` target; pass it
    // explicitly when restoring into a scratch name (e.g. --db
    // faction_forge_restore --role app_forge) so the API can boot against it.
    role: { type: 'string' },
    'no-grants': { type: 'boolean' },
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

// Re-apply the scoped grants (#115). pg_dump --no-privileges carries none, so
// without this the restored DB is unreadable by app_<slug> and the API cannot
// boot against it — which made the old "restore drill" a false positive.
const client = new pg.Client({ ...conn, database: args.db })
await client.connect()
try {
  const roleName = args.role ?? roleNameForDb(args.db)
  if (!args['no-grants']) {
    if (!roleName) {
      console.warn(
        `Could not derive a scoped role from "${args.db}" — pass --role app_<slug> ` +
        `(or --no-grants to skip). The API cannot read this DB until it is granted.`
      )
    } else {
      const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [roleName])
      if (exists.rowCount === 0) {
        console.warn(`Role ${roleName} does not exist — run db/new-faction.mjs first, or pass --role.`)
      } else {
        await applyScopedGrants(client, { dbName: args.db, roleName })
        console.log(`Re-applied scoped grants to ${roleName}.`)
      }
    }
  }

  // Smoke check: tables, identity, and — the part that actually matters —
  // that the app role can read. A superuser check would pass on a DB the API
  // cannot use at all.
  const tables = await client.query(
    `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`
  )
  const cfg = await client.query(`SELECT slug, torn_faction_id FROM faction_config LIMIT 1`)
  const readable = roleName
    ? (await client.query(
        `SELECT has_table_privilege($1, 'members', 'SELECT') AS ok`, [roleName]
      )).rows[0].ok
    : null
  console.log(`Restored ${args.db}: ${tables.rows[0].n} public tables; ` +
    `faction_config = ${cfg.rows[0] ? `${cfg.rows[0].slug}/${cfg.rows[0].torn_faction_id}` : '(none)'}; ` +
    `${roleName ?? '(no role)'} can read: ${readable}`)
  if (roleName && !args['no-grants'] && readable !== true) {
    console.error('Restored database is NOT readable by the app role — the API will not boot.')
    process.exit(1)
  }
} finally {
  await client.end()
}
