// Tests the new-faction init script at its real seam: the CLI. Each run must
// produce a complete, independent faction database on the target Postgres.
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import EmbeddedPostgres from 'embedded-postgres'
import pg from 'pg'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(here, '..', 'new-faction.mjs')

const PORT = 55442
const PG_ENV = {
  ...process.env,
  PGHOST: '127.0.0.1',
  PGPORT: String(PORT),
  PGUSER: 'postgres',
  PGPASSWORD: 'postgres',
}

let server
let dataDir

function connect(database) {
  return new pg.Client({
    host: '127.0.0.1',
    port: PORT,
    user: 'postgres',
    password: 'postgres',
    database,
  })
}

async function query(database, sql) {
  const client = connect(database)
  await client.connect()
  try {
    return await client.query(sql)
  } finally {
    await client.end()
  }
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'tnl-new-faction-test-'))
  server = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port: PORT,
    persistent: false,
  })
  await server.initialise()
  await server.start()
})

afterAll(async () => {
  await server?.stop()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('new-faction script', () => {
  it('run twice produces two independent, fully seeded faction databases', async () => {
    const forge = await run(
      'node',
      [SCRIPT, '--slug', 'forge2', '--name', 'TNL Forge 2 Dashboard', '--faction-id', '53100'],
      { env: PG_ENV }
    )
    await run(
      'node',
      [SCRIPT, '--slug', 'mayhem2', '--name', 'TNL Mayhem 2 Dashboard', '--faction-id', '53101'],
      { env: PG_ENV }
    )

    // Each DB carries its own identity row.
    const forgeConfig = await query('faction_forge2', 'SELECT * FROM faction_config')
    expect(forgeConfig.rows).toHaveLength(1)
    expect(forgeConfig.rows[0].slug).toBe('forge2')
    expect(forgeConfig.rows[0].display_name).toBe('TNL Forge 2 Dashboard')
    expect(forgeConfig.rows[0].torn_faction_id).toBe('53100')

    const mayhemConfig = await query('faction_mayhem2', 'SELECT slug FROM faction_config')
    expect(mayhemConfig.rows[0].slug).toBe('mayhem2')

    // Game-global seed data landed.
    const types = await query('faction_forge2', 'SELECT count(*)::int AS n FROM oc_crime_types')
    expect(types.rows[0].n).toBe(19)
    const items = await query('faction_forge2', 'SELECT count(*)::int AS n FROM items')
    expect(items.rows[0].n).toBeGreaterThan(1000)

    // Databases are independent: a write in one is invisible in the other.
    await query('faction_forge2', `INSERT INTO members (member_id, member_name) VALUES ('7', 'OnlyInForge')`)
    const other = await query('faction_mayhem2', 'SELECT count(*)::int AS n FROM members')
    expect(other.rows[0].n).toBe(0)

    // The operator gets the compose/nginx wiring to copy-paste.
    expect(forge.stdout).toContain('api-forge2')
  })

  it('refuses to clobber an existing faction database', async () => {
    await expect(
      run(
        'node',
        [SCRIPT, '--slug', 'forge2', '--name', 'Dup', '--faction-id', '1'],
        { env: PG_ENV }
      )
    ).rejects.toThrow(/already exists/i)
  })
})
