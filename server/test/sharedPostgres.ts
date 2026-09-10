/**
 * Handing a test its own database on the run's shared cluster.
 *
 * ⚠️ Kept apart from `globalPostgres.ts` on purpose. That module is the vitest
 * globalSetup and pulls in `embedded-postgres`; this one is imported by every
 * test file, and it must not drag a Postgres distribution's worth of module
 * graph into each worker to learn a database name.
 *
 * See `globalPostgres.ts` for why there is one cluster rather than 83.
 */
import { threadId } from 'node:worker_threads'
import { inject } from 'vitest'
import pg from 'pg'

export { FACTION_TEMPLATE_DB, GLOBAL_TEMPLATE_DB } from './templateDatabases.js'
export interface ClonedDatabase {
  /** node-postgres connection options, already pointed at the new database. */
  conn: { host: string; port: number; user: string; password: string; database: string }
  dbName: string
  /** Best-effort. A failed DROP must never fail a passing test. */
  drop(): Promise<void>
}

/**
 * Monotonic within one module registry — so it is unique per worker, and NOT
 * unique on its own.
 *
 * ⚠️ The pid is not enough either. Vitest's default pool is `threads`, so every
 * worker shares one process and one pid; naming databases `<pid>_<counter>`
 * collides the moment two workers reach their first stack, which is
 * immediately. `threadId` separates threads in a process, the pid separates
 * processes if the pool is ever switched to `forks`, and the counter separates
 * the several stacks a single file can start. All three are needed.
 *
 * A collision here is not a flaky test: a second worker would silently share
 * the first's database and see its rows.
 */
let counter = 0

export async function cloneDatabase(template: string, label = 'test'): Promise<ClonedDatabase> {
  const port = inject('pgPort')
  const base = { host: '127.0.0.1', port, user: 'postgres', password: 'postgres' }
  const dbName = `${label}_${process.pid}_${threadId}_${(counter += 1)}`

  const cluster = new pg.Client({ ...base, database: 'postgres' })
  await cluster.connect()
  try {
    // ⚠️ A file copy, not a schema replay: ~44ms against the ~1.6s an
    // `initdb` + `start` + schema apply + `stop` used to cost per file.
    await cluster.query(`CREATE DATABASE ${dbName} TEMPLATE ${template}`)
  } finally {
    await cluster.end().catch(() => {})
  }

  return {
    conn: { ...base, database: dbName },
    dbName,
    // ⚠️ Dropped rather than left to the cluster's teardown. Each clone is a
    // real ~10MB copy and a run makes well over a hundred of them, on a box
    // that is also serving production.
    drop: async () => {
      const dropper = new pg.Client({ ...base, database: 'postgres' })
      try {
        await dropper.connect()
        await dropper.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
      } catch {
        /* the cluster's own teardown will take it */
      } finally {
        await dropper.end().catch(() => {})
      }
    },
  }
}
