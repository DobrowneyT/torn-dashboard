// Clone a live tenant into its staging copy (#292).
//
//   node db/clone-tenant-dev.mjs --tenant forge
//
// Drops and recreates `faction_<slug>_dev` as a full copy of the live
// `faction_<slug>` (pg_dump | psql, so the live database needs no downtime and
// is never written), turns every scraper OFF in the copy, re-applies the
// tenant's scoped grants, and brings the copy up to date with
// db/migrations/*.sql. Re-runnable: each run is an explicit operator-triggered
// refresh of the staging data.
//
// Runs ON THE VPS, against the same Postgres that serves production. The copy
// includes member_secrets/faction_secrets — that is intended and safe *because
// the data never leaves the box*; see deploy/DEV.md for the safety model.
//
// The naming/guard logic lives in db/cloneDevLib.mjs (unit tested); this file
// is the pg_dump/psql orchestration, mirroring db/backup.mjs + db/restore.mjs.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { pipeline } from 'node:stream/promises'
import dotenv from 'dotenv'
import pg from 'pg'
import { applyScopedGrants } from './grants.mjs'
import { devDbName, assertDevTarget, DISABLE_SCRAPERS_SQL } from './cloneDevLib.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const composeEnv = {}
dotenv.config({ path: join(here, '..', 'deploy', '.env'), processEnv: composeEnv })

const { values: args } = parseArgs({
  options: {
    tenant: { type: 'string' },
    // Leave the scrapers as they were in the live snapshot. Off by default is
    // the safe posture; this exists for the rare "reproduce the scheduler"
    // test and is deliberately noisy about what it does.
    'keep-scrapers': { type: 'boolean' },
  },
})
if (!args.tenant) {
  console.error('Usage: node db/clone-tenant-dev.mjs --tenant <slug> [--keep-scrapers]')
  process.exit(1)
}

// Throws on a malformed slug before anything reaches a DROP.
const devDb = devDbName(args.tenant)
const liveDb = `faction_${args.tenant}`
const roleName = `app_${args.tenant}`
assertDevTarget(devDb)

const conn = {
  host: process.env.PGHOST ?? '127.0.0.1',
  port: Number(process.env.PGPORT ?? composeEnv.POSTGRES_HOST_PORT ?? 5432),
  user: process.env.PGUSER ?? composeEnv.POSTGRES_USER ?? 'postgres',
  password: process.env.PGPASSWORD ?? composeEnv.POSTGRES_PASSWORD,
}
const pgEnv = { ...process.env, PGPASSWORD: conn.password ?? '' }
const baseArgs = ['--host', conn.host, '--port', String(conn.port), '--username', conn.user]

// 1. The source must exist. Cloning a typo'd slug would otherwise produce an
// empty database that looks like a working staging instance.
const admin = new pg.Client({ ...conn, database: 'postgres' })
await admin.connect()
try {
  const live = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [liveDb])
  if (live.rowCount === 0) {
    console.error(`Live database ${liveDb} does not exist — nothing to clone`)
    process.exit(2)
  }
} finally {
  await admin.end()
}

// 2. Recreate the target. assertDevTarget above is what keeps this off a live
// tenant; --if-exists makes the first run and a refresh the same command.
console.log(`==> recreating ${devDb}`)
execFileSync('dropdb', [...baseArgs, '--if-exists', devDb], { stdio: 'inherit', env: pgEnv })
execFileSync('createdb', [...baseArgs, devDb], { stdio: 'inherit', env: pgEnv })

// 3. pg_dump the live tenant straight into the copy. --no-owner/--no-privileges
// for the same reason db/backup.mjs uses them: the grants are re-applied below
// rather than carried, so the copy works even if roles differ.
console.log(`==> copying ${liveDb} → ${devDb}`)
const dump = spawn(
  'pg_dump',
  [...baseArgs, '--no-owner', '--no-privileges', '--format=plain', liveDb],
  { env: pgEnv }
)
let dumpErr = ''
dump.stderr.on('data', (d) => { dumpErr += d })

const psql = spawn(
  'psql',
  [...baseArgs, '--dbname', devDb, '--set', 'ON_ERROR_STOP=on', '--quiet'],
  { env: pgEnv, stdio: ['pipe', 'inherit', 'inherit'] }
)

// Attach exit listeners before the pipeline — 'close' can fire the instant the
// stream ends, before a later-attached listener would catch it (same race
// db/backup.mjs and db/restore.mjs guard against).
const dumpExited = new Promise((resolve, reject) => {
  dump.on('close', resolve)
  dump.on('error', reject)
})
const psqlExited = new Promise((resolve, reject) => {
  psql.on('close', resolve)
  psql.on('error', reject)
})
await pipeline(dump.stdout, psql.stdin)
const [dumpCode, psqlCode] = await Promise.all([dumpExited, psqlExited])
if (dumpCode !== 0) {
  console.error(`pg_dump ${liveDb} exited ${dumpCode}: ${dumpErr.trim()}`)
  process.exit(1)
}
if (psqlCode !== 0) {
  console.error(`psql restore into ${devDb} exited ${psqlCode}`)
  process.exit(1)
}

// 4. Safety + grants inside the copy.
const db = new pg.Client({ ...conn, database: devDb })
await db.connect()
let scrapersOff = 0
try {
  if (args['keep-scrapers']) {
    console.warn(
      '[warn] --keep-scrapers: this copy will run the live schedule against REAL Torn ' +
      'as soon as the dev API is up (writes stay in the copy).'
    )
  } else {
    const res = await db.query(DISABLE_SCRAPERS_SQL)
    scrapersOff = res.rowCount
  }

  // Dumps carry no privileges, so without this the dev API cannot read the
  // copy it is pointed at (the same trap db/restore.mjs documents at #115).
  const exists = await db.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [roleName])
  if (exists.rowCount === 0) {
    console.error(`Role ${roleName} does not exist — run db/new-faction.mjs for this tenant first`)
    process.exit(1)
  }
  await applyScopedGrants(db, { dbName: devDb, roleName })
} finally {
  await db.end()
}

// 5. Bring the copy up to the current schema, exactly as a deploy would.
console.log('==> migrations')
execFileSync('node', [join(here, 'migrate.mjs'), '--db', devDb], { stdio: 'inherit', env: pgEnv })

// 6. Smoke check, and prove the app role can actually read — a superuser check
// would pass on a copy the dev API cannot boot against.
const check = new pg.Client({ ...conn, database: devDb })
await check.connect()
try {
  const tables = await check.query(
    `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`
  )
  const cfg = await check.query('SELECT slug, torn_faction_id FROM faction_config LIMIT 1')
  const enabled = await check.query('SELECT count(*)::int AS n FROM scraper_jobs WHERE enabled')
  const readable = (await check.query(
    `SELECT has_table_privilege($1, 'members', 'SELECT') AS ok`, [roleName]
  )).rows[0].ok

  console.log(
    `\nCloned ${liveDb} → ${devDb}: ${tables.rows[0].n} public tables; ` +
    `faction_config = ${cfg.rows[0] ? `${cfg.rows[0].slug}/${cfg.rows[0].torn_faction_id}` : '(none)'}; ` +
    `${scrapersOff} scrapers disabled, ${enabled.rows[0].n} still enabled; ` +
    `${roleName} can read: ${readable}`
  )
  if (readable !== true) {
    console.error('Clone is NOT readable by the app role — the dev API will not boot.')
    process.exit(1)
  }
  console.log(`\nNext: ./deploy/dev-deploy.sh <branch>   (see deploy/DEV.md)`)
} finally {
  await check.end()
}
