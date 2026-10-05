// Every migration must be a NO-OP against a freshly provisioned database.
//
// ⚠️ **Why this exists.** A new tenant database is created from `template.sql`
// — which carries the FINAL shape of every table — and is then run through the
// whole migration history. So each migration has to tolerate a database that
// already looks finished.
//
// `CREATE TABLE IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS` do that for free,
// which is why this held for sixty-nine migrations without anybody needing to
// think about it. **`RENAME COLUMN` has no `IF EXISTS`**, and 0070 used the
// bare form: on every freshly provisioned database it threw
// `column "battle_stats" does not exist` and ABORTED THE DEPLOY — for all
// tenants at once, because one database failing stops the run. Production sat
// three versions behind until somebody noticed the version had not moved.
//
// Nothing caught it: the suite applied template.sql, and separately applied
// migrations to an empty database. Neither models what provisioning does.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import EmbeddedPostgres from 'embedded-postgres'
import pg from 'pg'

function freePort() {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

const here = dirname(fileURLToPath(import.meta.url))
const TEMPLATE = readFileSync(join(here, '..', 'template.sql'), 'utf8')
const MIGRATIONS_DIR = join(here, '..', 'migrations')
const MIGRATIONS = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()

let server
let dataDir
let client

beforeAll(async () => {
  const port = await freePort()
  dataDir = mkdtempSync(join(tmpdir(), 'tnl-mig-over-template-'))
  server = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port, persistent: false,
  })
  await server.initialise()
  await server.start()
  await server.createDatabase('provisioned')
  client = new pg.Client({
    host: '127.0.0.1', port, user: 'postgres', password: 'postgres', database: 'provisioned',
  })
  await client.connect()
  // Exactly what provisioning does: the template first.
  await client.query(TEMPLATE)
}, 120_000)

afterAll(async () => {
  await client?.end()
  await server?.stop()
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
})

describe('every migration is a no-op on a template-provisioned database', () => {
  it('⚠️ applies the whole history over template.sql without throwing', async () => {
    const failures = []
    for (const file of MIGRATIONS) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
      try {
        await client.query(sql)
      } catch (err) {
        failures.push(`${file}: ${err.message}`)
      }
    }
    expect(
      failures,
      'These migrations fail against a database created from template.sql. A new ' +
      'tenant is provisioned from the template and THEN run through the whole ' +
      'history, so every migration must tolerate a database that already looks ' +
      'finished. `CREATE TABLE IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS` do ' +
      'this for free; `RENAME COLUMN` and `DROP COLUMN` do NOT and need an ' +
      'explicit existence check. A failure here aborts the deploy for EVERY ' +
      'tenant, not just a new one.'
    ).toEqual([])
  }, 180_000)

  it('⚠️ is still idempotent on a SECOND pass', async () => {
    // The deploy re-runs anything the migrations table does not already list,
    // and a half-finished run leaves exactly that state.
    const failures = []
    for (const file of MIGRATIONS) {
      try {
        await client.query(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
      } catch (err) {
        failures.push(`${file}: ${err.message}`)
      }
    }
    expect(failures).toEqual([])
  }, 180_000)
})
