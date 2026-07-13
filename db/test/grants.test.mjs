// The scoped-grants seam (#115). A faction API connects as app_<slug>, never as
// the superuser — so a faction DB is only *usable* if that role holds its
// privileges. Dumps carry none (`--no-privileges`), which means a restored DB is
// dead on arrival unless the grants can be re-applied independently.
//
// These tests verify from the app role's own connection — a superuser check
// would pass on a database the API cannot read, which is exactly the bug that
// shipped.
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import EmbeddedPostgres from 'embedded-postgres'
import pg from 'pg'
import { applyScopedGrants } from '../grants.mjs'

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

let pgsql
let dataDir
let port
const DB = 'faction_grantee'
const ROLE = 'app_grantee'
const PASSWORD = 'grantee-secret-pw'

async function admin(database = 'postgres') {
  const c = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', password: 'postgres', database })
  await c.connect()
  return c
}

/** Connect AS the scoped app role — the connection the API actually makes. */
async function asAppRole(database = DB) {
  const c = new pg.Client({ host: '127.0.0.1', port, user: ROLE, password: PASSWORD, database })
  await c.connect()
  return c
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'tnl-grants-'))
  port = await freePort()
  pgsql = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: 'postgres', port, persistent: false })
  await pgsql.initialise()
  await pgsql.start()

  // A faction DB as a restore leaves it: schema + data, no grants, role absent.
  const a = await admin()
  await a.query(`CREATE DATABASE ${DB}`)
  await a.end()
  const d = await admin(DB)
  await d.query(TEMPLATE)
  await d.end()
}, 60000)

afterAll(async () => {
  await pgsql?.stop()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('applyScopedGrants', () => {
  it('makes a freshly-restored database readable and writable by the app role', async () => {
    const a = await admin(DB)
    await applyScopedGrants(a, { dbName: DB, roleName: ROLE, password: PASSWORD })
    await a.end()

    const app = await asAppRole()
    // Read and write through the role the API actually uses.
    await app.query(`INSERT INTO members (member_id, member_name, is_current) VALUES ('9001', 'Grantee', true)`)
    const res = await app.query(`SELECT member_name FROM members WHERE member_id = '9001'`)
    expect(res.rows[0].member_name).toBe('Grantee')
    // Sequences too — inserts into serial-keyed tables need USAGE.
    await app.query(`INSERT INTO war_room_dibs_v2 (target_id, claimed_by, claimed_name) VALUES (1, 2, 'x')`)
    await app.end()
  })

  it('is idempotent: re-applying keeps the role working and does not rotate its password', async () => {
    const a = await admin(DB)
    await applyScopedGrants(a, { dbName: DB, roleName: ROLE, password: PASSWORD })
    // A second re-apply with NO password (the restore case: the role already
    // exists and its credential lives in deploy/.env — we must not change it).
    await applyScopedGrants(a, { dbName: DB, roleName: ROLE })
    await a.end()

    const app = await asAppRole()   // same password still works
    const res = await app.query(`SELECT count(*)::int AS n FROM members`)
    expect(res.rows[0].n).toBeGreaterThan(0)
    await app.end()
  })

  it('refuses to run against the wrong database rather than silently granting nothing', async () => {
    // GRANT ON ALL TABLES applies to the CURRENT database; connected to the
    // maintenance DB every statement "succeeds" and grants nothing useful.
    const a = await admin('postgres')
    await expect(
      applyScopedGrants(a, { dbName: DB, roleName: ROLE, password: PASSWORD })
    ).rejects.toThrow(/connected to postgres/)
    await a.end()
  })

  it('revokes PUBLIC connect, so the isolation between factions is real', async () => {
    const a = await admin()
    const res = await a.query(
      `SELECT has_database_privilege('public', $1, 'CONNECT') AS public_can_connect`, [DB]
    )
    await a.end()
    expect(res.rows[0].public_can_connect).toBe(false)
  })
})
