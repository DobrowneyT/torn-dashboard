// `template.sql` must already carry everything the migrations would add.
//
// ⚠️ **Why this exists.** The two are separate files, edited by hand, and a
// change that touches one and forgets the other produces a fleet where new
// tenants and existing tenants have DIFFERENT schemas — silently. Nothing
// errors: provisioning succeeds, the deploy succeeds, and the divergence only
// surfaces when a query works on one tenant and 500s on another.
//
// ⚠️ **The test is "applying the history changes nothing", not "both paths
// agree".** There is no such thing as a tenant built from the migrations alone
// — the history does not start at the beginning of the schema and references
// tables that exist only in the template (`member_secrets`, which lives out of
// band). The one real provisioning path is template-then-history, and on a
// template that is up to date every migration is a no-op. So if the column set
// GROWS while the history runs, the template is behind by exactly those columns.
//
// The migration-0047 and migration-0061 tests each check this for their own
// change. That is the right instinct repeated per-migration, which means it is
// only ever as good as whoever remembered to write it; #530's 0072 was the
// seventy-second chance to forget.
//
// ⚠️ **Columns and tables only, deliberately.** Indexes, constraint names and
// defaults diverge for legitimate historical reasons, and asserting on those
// would mean a standing failure nobody can act on — the exact state that makes
// a gate worthless. The column set is the part that breaks queries.
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
let before
let after

/** Every public column, as "table.column", sorted. */
async function columnSet(c) {
  const res = await c.query(
    `SELECT table_name || '.' || column_name AS col
     FROM information_schema.columns
     WHERE table_schema = 'public'
     ORDER BY col`
  )
  return res.rows.map((r) => r.col)
}

beforeAll(async () => {
  const port = await freePort()
  dataDir = mkdtempSync(join(tmpdir(), 'tnl-template-parity-'))
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

  // Exactly what provisioning does, in order.
  await client.query(TEMPLATE)
  before = await columnSet(client)
  for (const file of MIGRATIONS) {
    await client.query(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  after = await columnSet(client)
}, 180_000)

afterAll(async () => {
  await client?.end()
  await server?.stop()
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
})

describe('template.sql is not behind the migrations', () => {
  it('⚠️ a migration that adds a column also adds it to template.sql', () => {
    const added = after.filter((c) => !before.includes(c))
    expect(
      added,
      'The migration history ADDED these columns to a database provisioned from ' +
      'template.sql, which means the template is missing them. A newly ' +
      'provisioned tenant gets them only because the history runs afterwards — ' +
      'but the template is supposed to be the final shape, and anything relying ' +
      'on it (a fresh provision that stops early, a hand-built database, reading ' +
      'the file to know the schema) is now wrong. Add them to the table ' +
      'definition in db/template.sql.'
    ).toEqual([])
  })

  it('⚠️ and a migration that adds a TABLE adds it to template.sql too', async () => {
    // Same property, one level up: a table created only by a migration is a
    // table the template does not describe.
    const names = (cols) => [...new Set(cols.map((c) => c.split('.')[0]))]
    const newTables = names(after).filter((t) => !names(before).includes(t))
    expect(newTables).toEqual([])
  })
})
