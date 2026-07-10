// Tests the new-faction init script at its real seam: the CLI. Each run must
// produce a complete, independent faction database on the target Postgres.
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
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

// Fixed ports flake when runners share a host; ask the OS for a free one.
function freePort() {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

let PORT
let PG_ENV

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
  PORT = await freePort()
  PG_ENV = {
    ...process.env,
    PGHOST: '127.0.0.1',
    PGPORT: String(PORT),
    PGUSER: 'postgres',
    PGPASSWORD: 'postgres',
  }
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
    // Redirect deploy artifacts away from the real deploy/ (slice #75).
    const deployDir = mkdtempSync(join(tmpdir(), 'tnl-deploy-main-'))
    const forge = await run(
      'node',
      [SCRIPT, '--slug', 'forge2', '--name', 'TNL Forge 2 Dashboard', '--faction-id', '53100', '--deploy-dir', deployDir],
      { env: PG_ENV }
    )
    await run(
      'node',
      [SCRIPT, '--slug', 'mayhem2', '--name', 'TNL Mayhem 2 Dashboard', '--faction-id', '53101', '--deploy-dir', deployDir],
      { env: PG_ENV }
    )
    rmSync(deployDir, { recursive: true, force: true })

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

  it('provisions a scoped credential per faction — tenant A cannot read tenant B (slice #75)', async () => {
    const deployDir = mkdtempSync(join(tmpdir(), 'tnl-deploy-test-'))
    try {
      await run(
        'node',
        [SCRIPT, '--slug', 'tenanta', '--name', 'Tenant A', '--faction-id', '111', '--deploy-dir', deployDir],
        { env: PG_ENV }
      )
      await run(
        'node',
        [SCRIPT, '--slug', 'tenantb', '--name', 'Tenant B', '--faction-id', '222', '--deploy-dir', deployDir],
        { env: PG_ENV }
      )

      // The generated credential lands in the deploy env file (compose
      // interpolates it into that faction's DATABASE_URL).
      const envFile = readFileSync(join(deployDir, '.env'), 'utf8')
      const passA = envFile.match(/^DB_PASSWORD_TENANTA=(\S+)$/m)?.[1]
      const passB = envFile.match(/^DB_PASSWORD_TENANTB=(\S+)$/m)?.[1]
      expect(passA).toBeTruthy()
      expect(passB).toBeTruthy()
      expect(passA).not.toBe(passB)

      // Tenant A's credential works on tenant A's database…
      const asA = new pg.Client({
        host: '127.0.0.1', port: PORT, user: 'app_tenanta', password: passA, database: 'faction_tenanta',
      })
      await asA.connect()
      try {
        const config = await asA.query('SELECT slug FROM faction_config')
        expect(config.rows[0].slug).toBe('tenanta')
        // …including writes (the API owns its own data).
        await asA.query(`INSERT INTO members (member_id, member_name) VALUES ('1', 'A-Member')`)
      } finally {
        await asA.end()
      }

      // …and is rejected by tenant B's database at connect time.
      const crossTenant = new pg.Client({
        host: '127.0.0.1', port: PORT, user: 'app_tenanta', password: passA, database: 'faction_tenantb',
      })
      await expect(crossTenant.connect()).rejects.toThrow(/permission denied|not permitted|denied/i)

      // The superuser path (snapshot restores, migrations) is unaffected.
      const admin = await query('faction_tenantb', 'SELECT count(*)::int AS n FROM members')
      expect(admin.rows[0].n).toBe(0)
    } finally {
      rmSync(deployDir, { recursive: true, force: true })
    }
  })

  it('writes the deploy artifacts: compose service + nginx vhost, no code edits needed (slice #75)', async () => {
    const deployDir = mkdtempSync(join(tmpdir(), 'tnl-deploy-artifacts-'))
    try {
      await run(
        'node',
        [SCRIPT, '--slug', 'artifax', '--name', 'Artifax', '--faction-id', '333', '--deploy-dir', deployDir],
        { env: PG_ENV }
      )

      // Compose override: auto-loaded by `docker compose up`, one service per
      // faction, connecting with the scoped credential.
      const override = readFileSync(join(deployDir, 'docker-compose.override.yml'), 'utf8')
      expect(override).toContain('api-artifax:')
      expect(override).toContain('FACTION_SLUG: artifax')
      expect(override).toContain('postgres://app_artifax:${DB_PASSWORD_ARTIFAX}@postgres:5432/faction_artifax')

      // nginx vhost: host-header routing for <slug>.<any domain>.
      const vhost = readFileSync(join(deployDir, 'nginx', 'factions', 'artifax.conf'), 'utf8')
      expect(vhost).toContain('server_name artifax.*')
      expect(vhost).toContain('api-artifax:8080')

      // A second faction appends to the same override without clobbering.
      await run(
        'node',
        [SCRIPT, '--slug', 'artifay', '--name', 'Artifay', '--faction-id', '334', '--deploy-dir', deployDir],
        { env: PG_ENV }
      )
      const both = readFileSync(join(deployDir, 'docker-compose.override.yml'), 'utf8')
      expect(both).toContain('api-artifax:')
      expect(both).toContain('api-artifay:')
    } finally {
      rmSync(deployDir, { recursive: true, force: true })
    }
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
