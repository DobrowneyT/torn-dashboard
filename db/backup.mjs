// Nightly per-faction database backup (#76 / slice 18).
//
//   node db/backup.mjs [--out DIR] [--retention-days N] [--db faction_forge]
//
// For every faction_<slug> database (or just --db): pg_dump → gzip → a
// timestamped archive under --out (default deploy/backups). When RCLONE_REMOTE
// is set the archive is copied to object storage (Backblaze B2 per the
// roadmap) and remote copies past the retention window are pruned; local
// copies past the window are always pruned. Upload/remote-prune are gated on
// config so the job is a no-op-but-local until the operator wires B2.
//
// The pure naming/discovery/retention logic lives in db/backupLib.mjs (unit
// tested); this file is the pg_dump/gzip/rclone orchestration, exercised by
// the compose E2E against a real postgres:17.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { createGzip } from 'node:zlib'
import { parseArgs } from 'node:util'
import { pipeline } from 'node:stream/promises'
import dotenv from 'dotenv'
import pg from 'pg'
import { factionDbsFromRows, backupName, selectExpired, remotePruneArgs } from './backupLib.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const composeEnv = {}
dotenv.config({ path: join(here, '..', 'deploy', '.env'), processEnv: composeEnv })

const { values: args } = parseArgs({
  options: {
    out: { type: 'string' },
    'retention-days': { type: 'string' },
    db: { type: 'string' },
  },
})

const conn = {
  host: process.env.PGHOST ?? '127.0.0.1',
  port: Number(process.env.PGPORT ?? composeEnv.POSTGRES_HOST_PORT ?? 5432),
  user: process.env.PGUSER ?? composeEnv.POSTGRES_USER ?? 'postgres',
  password: process.env.PGPASSWORD ?? composeEnv.POSTGRES_PASSWORD,
}
const outDir = args.out ?? join(here, '..', 'deploy', 'backups')
const retentionDays = Number(args['retention-days'] ?? 14)
const rcloneRemote = process.env.RCLONE_REMOTE // e.g. b2:tnl-dashboard-backups

const pgEnv = { ...process.env, PGPASSWORD: conn.password ?? '' }

async function discoverDbs() {
  if (args.db) return factionDbsFromRows([{ datname: args.db }])
  const client = new pg.Client({ ...conn, database: 'postgres' })
  await client.connect()
  try {
    const res = await client.query(
      `SELECT datname FROM pg_database WHERE datname LIKE 'faction_%' ORDER BY datname`
    )
    return factionDbsFromRows(res.rows)
  } finally {
    await client.end()
  }
}

async function dump({ db, slug }) {
  const name = backupName(slug, new Date())
  const finalPath = join(outDir, name)
  const tmpPath = `${finalPath}.partial`
  // pg_dump → gzip → file. --no-owner/--no-privileges so a dump restores onto
  // a scratch DB whose scoped role differs from production's.
  const proc = spawn(
    'pg_dump',
    ['--host', conn.host, '--port', String(conn.port), '--username', conn.user,
     '--no-owner', '--no-privileges', '--format=plain', db],
    { env: pgEnv }
  )
  let stderr = ''
  proc.stderr.on('data', (d) => { stderr += d })
  // Attach the exit listener BEFORE awaiting the pipeline: 'close' can fire the
  // instant stdout ends, before a later-attached listener would catch it.
  const exited = new Promise((resolve, reject) => {
    proc.on('close', resolve)
    proc.on('error', reject)
  })
  await pipeline(proc.stdout, createGzip(), createWriteStream(tmpPath))
  const code = await exited
  if (code !== 0) {
    rmSync(tmpPath, { force: true })
    throw new Error(`pg_dump ${db} exited ${code}: ${stderr.trim()}`)
  }
  renameSync(tmpPath, finalPath)
  return { name, path: finalPath }
}

function upload(path) {
  if (!rcloneRemote) return
  execFileSync('rclone', ['copy', path, `${rcloneRemote}/`], { stdio: 'inherit' })
}

function prune() {
  const local = selectExpired(readdirSync(outDir), new Date(), retentionDays)
  for (const name of local) rmSync(join(outDir, name), { force: true })
  if (rcloneRemote) {
    // rclone enforces the same window remotely by age, scoped to OUR archive
    // names so nothing else in the bucket path can ever be swept (#117).
    execFileSync('rclone', remotePruneArgs(rcloneRemote, retentionDays), { stdio: 'inherit' })
  }
  return local.length
}

mkdirSync(outDir, { recursive: true })
if (!existsSync(outDir)) throw new Error(`backup out dir not writable: ${outDir}`)

const dbs = await discoverDbs()
if (dbs.length === 0) {
  console.warn('No faction_* databases found — nothing to back up.')
  process.exit(0)
}

for (const target of dbs) {
  const { name } = await dump(target)
  upload(join(outDir, name))
  console.log(`backed up ${target.db} → ${name}${rcloneRemote ? ` (+ ${rcloneRemote})` : ' (local only)'}`)
}
const pruned = prune()
console.log(`Backups complete: ${dbs.length} archived, ${pruned} local expired removed (retention ${retentionDays}d).`)
