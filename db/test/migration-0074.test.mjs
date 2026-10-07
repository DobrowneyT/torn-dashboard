// Migration 0074 (#922) — removing the deprecated `visitor` role.
//
// ⚠️ **The row has to go before the constraint narrows.** A visitor assignment
// on a database nobody checked would make `ADD CONSTRAINT` fail, and because one
// database failing aborts the migration run, that would stop the deploy for
// EVERY tenant — the exact shape of the 0070 outage. All six databases were
// confirmed empty on 2026-10-06, but a migration that only works because
// somebody checked by hand is not a migration that works.
//
// ⚠️ Idempotency comes from `DROP CONSTRAINT IF EXISTS` preceding the `ADD`, not
// from a catalogue guard. I wrote a `pg_constraint` lookup first and probed it:
// it never fires, because the DROP always leaves the constraint absent. The
// probe is the only reason that dead code is not still sitting in the file.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
const MIGRATION = readFileSync(join(here, '..', 'migrations', '0074-drop-visitor-role.sql'), 'utf8')

/** The constraint an EXISTING tenant has before 0074: visitor still allowed. */
const OLD_CONSTRAINT = `
ALTER TABLE role_assignments DROP CONSTRAINT role_assignments_role_check;
ALTER TABLE role_assignments ADD CONSTRAINT role_assignments_role_check
  CHECK (role = ANY (ARRAY['admin'::text, 'leadership'::text, 'warlead'::text,
                           'ocmanager'::text, 'visitor'::text]));
`

let server
let dataDir
let port

beforeAll(async () => {
  port = await freePort()
  dataDir = mkdtempSync(join(tmpdir(), 'tnl-mig-0074-'))
  server = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port, persistent: false,
  })
  await server.initialise()
  await server.start()
}, 120_000)

afterAll(async () => {
  await server?.stop()
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
})

/** A database shaped like an existing tenant, optionally holding a visitor. */
async function existingTenant(name, { withVisitor = false } = {}) {
  await server.createDatabase(name)
  const c = new pg.Client({
    host: '127.0.0.1', port, user: 'postgres', password: 'postgres', database: name,
  })
  await c.connect()
  await c.query(TEMPLATE)
  await c.query(OLD_CONSTRAINT)
  await c.query(`INSERT INTO role_assignments (torn_user_id, role) VALUES ('888', 'leadership')`)
  if (withVisitor) {
    await c.query(`INSERT INTO role_assignments (torn_user_id, role) VALUES ('999', 'visitor')`)
  }
  return c
}

const roles = async (c) =>
  (await c.query('SELECT torn_user_id, role FROM role_assignments ORDER BY torn_user_id')).rows

describe('migration 0074 — drop the visitor role', () => {
  it('⚠️ removes a live visitor assignment instead of failing on it', async () => {
    const c = await existingTenant('with_visitor', { withVisitor: true })
    await c.query(MIGRATION)
    // ⚠️ The deploy must not depend on somebody having checked by hand.
    expect(await roles(c)).toEqual([{ torn_user_id: '888', role: 'leadership' }])
    await c.end()
  }, 60_000)

  it('leaves every other role alone', async () => {
    const c = await existingTenant('other_roles')
    await c.query(
      `INSERT INTO role_assignments (torn_user_id, role)
       VALUES ('1', 'admin'), ('2', 'warlead'), ('3', 'ocmanager')`
    )
    await c.query(MIGRATION)
    expect((await roles(c)).map((r) => r.role).sort())
      .toEqual(['admin', 'leadership', 'ocmanager', 'warlead'])
    await c.end()
  }, 60_000)

  it('narrows the constraint so visitor can never be granted again', async () => {
    const c = await existingTenant('narrowed')
    await c.query(MIGRATION)
    await expect(
      c.query(`INSERT INTO role_assignments (torn_user_id, role) VALUES ('777', 'visitor')`)
    ).rejects.toThrow(/role_assignments_role_check/)
    await c.end()
  }, 60_000)

  it('still accepts the four real roles afterwards', async () => {
    const c = await existingTenant('accepts_real')
    await c.query(MIGRATION)
    // ⚠️ `torn_user_id` is numeric, so the ids have to be too.
    const real = ['admin', 'leadership', 'warlead', 'ocmanager']
    for (const [i, role] of real.entries()) {
      await c.query(
        `INSERT INTO role_assignments (torn_user_id, role) VALUES ($1, $2)`,
        [9000 + i, role]
      )
    }
    expect((await roles(c)).length).toBe(5)
    await c.end()
  }, 60_000)

  /**
   * ⚠️ `ADD CONSTRAINT` has no `IF NOT EXISTS`, so the preceding
   * `DROP ... IF EXISTS` is what carries this — which is exactly the case the
   * deploy hits when a previous run was interrupted part-way.
   */
  it('is idempotent on a second pass', async () => {
    const c = await existingTenant('twice', { withVisitor: true })
    await c.query(MIGRATION)
    await c.query(MIGRATION)
    expect(await roles(c)).toEqual([{ torn_user_id: '888', role: 'leadership' }])
    await c.end()
  }, 60_000)

  /**
   * ⚠️ A NEW tenant is provisioned from `template.sql`, which already carries
   * the narrowed constraint, and is then run through the whole history. 0074
   * has to be a no-op there — see migrations-over-template.
   */
  it('is a no-op on a freshly provisioned database', async () => {
    await server.createDatabase('fresh')
    const c = new pg.Client({
      host: '127.0.0.1', port, user: 'postgres', password: 'postgres', database: 'fresh',
    })
    await c.connect()
    await c.query(TEMPLATE)
    await c.query(MIGRATION)
    await expect(
      c.query(`INSERT INTO role_assignments (torn_user_id, role) VALUES ('1', 'visitor')`)
    ).rejects.toThrow(/role_assignments_role_check/)
    await c.end()
  }, 60_000)
})
