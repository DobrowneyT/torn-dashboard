/**
 * ONE embedded Postgres cluster for the whole server test run.
 *
 * ⚠️ **Why this exists.** Every test file here used to boot its own cluster:
 * `initdb`, `start`, apply `db/template.sql`, and `stop` again — 83 times.
 * Measured on an idle 16-core box that is ~1.6s of pure lifecycle per file, and
 * `initdb` is ~900ms of it. It is also I/O-bound and CPU-hungry, and vitest
 * runs one worker per core, so four `initdb`s fire at once.
 *
 * The CI runner has FOUR cores, hosts all five production tenant containers,
 * AND carries a second Actions runner — so two suites can overlap and ask for
 * eight simultaneous cluster bootstraps on a box that is already busy. That is
 * the whole mechanism behind the intermittent red build: never an assertion,
 * always `Hook timed out in 180000ms` in whichever file happened to be starting
 * when the box was busiest. `admin-provisioning`, `scrapers-jobs`, `oc` and
 * `crime-participation` have each drawn the short straw, and every one of them
 * passes in seconds when run alone.
 *
 * ⚠️ Capping workers was tried first (#663) and made it WORSE, because the cap
 * starves the parallelism without removing the thing that was actually
 * oversubscribing the box. The fix is to stop doing the expensive thing 83
 * times. Measured on four pinned cores, the runner's shape:
 *
 *   per-file clusters, 2 threads (the #663 cap)   153.9s
 *   per-file clusters, 4 threads                  124.0s
 *   shared cluster,    4 threads                   66.1s
 *
 * ⚠️ Do not try to confirm this from a CI run's wall clock. Across ten recent
 * pre-change runs the vitest step ranged 149–364s; the box serves five
 * production tenants and a concurrent compose build, and that variance swamps
 * the effect entirely. Pin the cores and measure, or measure nothing.
 *
 * So: one cluster, started here in the main process before any worker exists,
 * plus two prepared TEMPLATE databases. A test stack then costs one
 * `CREATE DATABASE ... TEMPLATE`, which Postgres implements as a file copy —
 * ~44ms against ~1.6s, and no `initdb` at all.
 *
 * ⚠️ Teardown must happen HERE, not in a worker. `persistent: false` means the
 * data directory is disposable, but the postmaster is a real OS process and
 * this runner is the production box: a leaked cluster per CI run would
 * accumulate on the machine serving live tenants. globalSetup's teardown is the
 * only hook guaranteed to run once, after every worker is gone.
 */
import type { GlobalSetupContext } from 'vitest/node'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import EmbeddedPostgres from 'embedded-postgres'
import pg from 'pg'
import { FACTION_TEMPLATE_DB, GLOBAL_TEMPLATE_DB } from './templateDatabases.js'

const here = dirname(fileURLToPath(import.meta.url))
const dbDir = join(here, '..', '..', 'db')
const read = (...p: string[]) => readFileSync(join(dbDir, ...p), 'utf8')

const TEST_FACTION = { slug: 'forge', displayName: 'TNL Forge Dashboard', tornFactionId: '53100' }

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr === null || typeof addr === 'string') return reject(new Error('no port'))
      srv.close(() => resolve(addr.port))
    })
    srv.on('error', reject)
  })
}

let embedded: EmbeddedPostgres | undefined
let dataDir: string | undefined

export async function setup({ provide }: GlobalSetupContext) {
  const port = await freePort()
  dataDir = mkdtempSync(join(tmpdir(), 'tnl-server-cluster-'))
  embedded = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
    // ⚠️ Durability off. This cluster is deleted at the end of the run, so
    // fsync buys nothing and costs real time on every one of the ~1900 tests'
    // writes. `max_connections` is raised because one cluster now serves every
    // worker at once instead of one worker having a cluster to itself — the
    // default 100 is comfortable for four workers with small pools, and this
    // removes the cliff if that ever changes.
    postgresFlags: [
      '-c', 'fsync=off',
      '-c', 'full_page_writes=off',
      '-c', 'synchronous_commit=off',
      '-c', 'max_connections=300',
    ],
  })
  await embedded.initialise()
  await embedded.start()

  const conn = { host: '127.0.0.1', port, user: 'postgres', password: 'postgres' }

  // The faction template: schema, the policy-defaults seed a real new-faction
  // database gets, and the faction_config row every stack shares.
  await embedded.createDatabase(FACTION_TEMPLATE_DB)
  const faction = new pg.Client({ ...conn, database: FACTION_TEMPLATE_DB })
  await faction.connect()
  await faction.query(read('template.sql'))
  await faction.query(read('seed', '03_faction_settings_defaults.sql'))
  await faction.query(
    `INSERT INTO faction_config (slug, display_name, torn_faction_id) VALUES ($1, $2, $3)`,
    [TEST_FACTION.slug, TEST_FACTION.displayName, TEST_FACTION.tornFactionId]
  )
  await faction.end()

  await embedded.createDatabase(GLOBAL_TEMPLATE_DB)
  const global = new pg.Client({ ...conn, database: GLOBAL_TEMPLATE_DB })
  await global.connect()
  await global.query(read('global-template.sql'))
  await global.end()

  // ⚠️ Nothing may hold a connection to a template database. `CREATE DATABASE
  // ... TEMPLATE x` fails outright while any other session is connected to `x`,
  // so both clients above are closed before any worker starts.
  provide('pgPort', port)
}

export async function teardown() {
  await embedded?.stop().catch(() => {})
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
}

declare module 'vitest' {
  export interface ProvidedContext {
    pgPort: number
  }
}
