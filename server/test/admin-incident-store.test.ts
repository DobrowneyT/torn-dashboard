// #609 slice 4 — the incident store, against real Postgres.
//
// The rules and the state machine are pure and tested without a database. What
// is left is the SQL, and it carries two things worth proving on a real server
// rather than eyeballing: that `opened_at` survives a round trip as NULL rather
// than becoming a falsy timestamp — the difference between "never announced"
// and "announced", which decides whether a resolution message is ever sent —
// and that a tenant cannot read the fleet's outage history.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import EmbeddedPostgres from 'embedded-postgres'
import pg from 'pg'
import { freePort } from './harness.js'
import { pgIncidentStore } from '../src/adminPlane/incidentStore.js'
import { buildAdminApp } from '../src/adminPlane/app.js'
import { hashPassword } from '../src/adminPlane/password.js'
import { generateTotpSecret } from '../src/adminPlane/totp.js'
import { mintAdminSession } from '../src/adminPlane/session.js'
import { reconcile, type Incident } from '../src/adminPlane/incidents.js'
import type { Alert } from '../src/adminPlane/alertRules.js'
// @ts-expect-error — plain .mjs helper shared with db/new-global.mjs
import { applyReadOnlyGrants, applyScopedGrants } from '../../db/grants.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const TEMPLATE = readFileSync(join(here, '..', '..', 'db', 'global-template.sql'), 'utf8')

let embedded: EmbeddedPostgres
let dataDir: string
let port: number
let admin: pg.Client
let writer: pg.Pool
let reader: pg.Pool

const NOW = '2026-09-05T12:00:00.000Z'
const at = (n: number) => new Date(Date.parse(NOW) + n * 60_000).toISOString()
const down: Alert = { key: 'tenant-down:tnl', severity: 'urgent', title: 'tnl is down', detail: 'ECONNREFUSED' }

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'incident-store-'))
  port = await freePort()
  embedded = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port, persistent: false,
  })
  await embedded.initialise()
  await embedded.start()
  await embedded.createDatabase('global')

  const conn = { host: '127.0.0.1', port, user: 'postgres', password: 'postgres' }
  admin = new pg.Client({ ...conn, database: 'global' })
  await admin.connect()
  await admin.query(TEMPLATE)
  await admin.query('REVOKE CONNECT ON DATABASE global FROM PUBLIC')
  await applyScopedGrants(admin, { dbName: 'global', roleName: 'app_global_rw', password: 'rw_pw' })
  await applyReadOnlyGrants(admin, { dbName: 'global', roleName: 'app_global_ro', password: 'ro_pw' })

  writer = new pg.Pool({ ...conn, database: 'global', user: 'app_global_rw', password: 'rw_pw', max: 4 })
  reader = new pg.Pool({ ...conn, database: 'global', user: 'app_global_ro', password: 'ro_pw', max: 2 })
}, 120_000)

afterAll(async () => {
  await writer?.end().catch(() => {})
  await reader?.end().catch(() => {})
  await admin?.end().catch(() => {})
  await embedded?.stop().catch(() => {})
  rmSync(dataDir, { recursive: true, force: true })
})

async function reset() {
  await admin.query('TRUNCATE alert_incidents, alert_events, control_state')
}

describe('pgIncidentStore', () => {
  it('⚠️ round-trips an unconfirmed incident with opened_at still NULL', async () => {
    await reset()
    const store = pgIncidentStore(writer)
    const r = reconcile([], [down], at(0))
    await store.save(r, at(0))

    const loaded = await store.load()
    expect(loaded).toHaveLength(1)
    // The whole point: `null`, not a timestamp and not undefined. A falsy
    // coalesce anywhere in this path would announce a resolution for an
    // incident nobody was ever told about.
    expect(loaded[0].openedAt).toBeNull()
    expect(loaded[0].observations).toBe(1)
    expect(loaded[0].firstSeenAt).toBe(at(0))
  })

  it('⚠️ survives a restart mid-incident without re-announcing', async () => {
    await reset()
    const store = pgIncidentStore(writer)
    // Cycle 1 and 2: the incident is confirmed and announced once.
    let state = reconcile([], [down], at(0))
    await store.save(state, at(0))
    state = reconcile(await store.load(), [down], at(1))
    await store.save(state, at(1))
    expect(state.opened).toHaveLength(1)

    // The container is redeployed. A fresh store, loading from Postgres, must
    // pick the incident up as already open — an in-memory map would announce it
    // all over again, triggered by the most routine operation there is.
    const afterRestart = pgIncidentStore(writer)
    const next = reconcile(await afterRestart.load(), [down], at(2))
    expect(next.opened).toEqual([])
    expect(next.incidents[0].openedAt).toBe(at(1))
  })

  it('deletes cleared incidents and records both events', async () => {
    await reset()
    const store = pgIncidentStore(writer)
    let state = reconcile([], [down], at(0))
    await store.save(state, at(0))
    state = reconcile(await store.load(), [down], at(1))
    await store.save(state, at(1))
    state = reconcile(await store.load(), [], at(2))
    await store.save(state, at(2))
    state = reconcile(await store.load(), [], at(3))
    await store.save(state, at(3))

    expect(await store.load()).toEqual([])
    const events = await store.recentEvents(at(-10))
    expect(events.map((e) => e.kind)).toEqual(['resolved', 'opened'])
    expect(events[0].title).toBe('tnl is down')
  })

  it('windows recent events by time', async () => {
    await reset()
    const store = pgIncidentStore(writer)
    await store.save(reconcile([], [down], at(0)), at(0))
    await store.save(reconcile(await store.load(), [down], at(1)), at(1))
    expect(await store.recentEvents(at(0))).toHaveLength(1)
    expect(await store.recentEvents(at(5))).toHaveLength(0)
  })

  it('handles a cycle with no incidents at all', async () => {
    await reset()
    const store = pgIncidentStore(writer)
    // `NOT (key = ANY('{}'))` must delete everything rather than nothing.
    await store.save(reconcile([], [down], at(0)), at(0))
    await store.save({ incidents: [], opened: [], resolved: [] }, at(1))
    expect(await store.load()).toEqual([])
  })

  it('round-trips control state', async () => {
    await reset()
    const store = pgIncidentStore(writer)
    expect(await store.getState('digest.last_sent_at')).toBeNull()
    await store.setState('digest.last_sent_at', NOW)
    expect(await store.getState('digest.last_sent_at')).toBe(NOW)
    await store.setState('digest.last_sent_at', at(60))
    expect(await store.getState('digest.last_sent_at')).toBe(at(60))
  })

  it('refreshes the wording of an ongoing incident in place', async () => {
    await reset()
    const store = pgIncidentStore(writer)
    await store.save(reconcile([], [down], at(0)), at(0))
    await store.save(reconcile(await store.load(), [{ ...down, detail: 'no response in 3000ms' }], at(1)), at(1))
    const loaded: Incident[] = await store.load()
    expect(loaded[0].detail).toBe('no response in 3000ms')
    expect(loaded).toHaveLength(1)
  })
})

describe('⚠️ the alerting tables are control-plane-private', () => {
  // `ALTER DEFAULT PRIVILEGES` hands app_global_ro SELECT on every table added
  // to this database — right for shared fleet data, wrong for the admin
  // container's own bookkeeping. These three carry a fleet-wide situation
  // report (which factions exist, which are down right now) that a single
  // compromised tenant container has no business holding.
  for (const table of ['alert_incidents', 'alert_events', 'control_state']) {
    it(`refuses a tenant read of ${table}`, async () => {
      await expect(reader.query(`SELECT * FROM ${table}`)).rejects.toThrow(/permission denied/i)
    })
  }

  it('still lets a tenant read the fleet metadata it depends on', async () => {
    const res = await reader.query('SELECT schema_version FROM fleet_meta WHERE id = 1')
    expect(res.rows).toHaveLength(1)
  })
})

// ── Fleet feature-flag defaults (#609 slice 5) ──────────────────────────────

describe('the fleet flag routes', () => {
  const SECRET = 'fleet-flag-session-secret'
  const TOTP = generateTotpSecret()

  const build = async (surface: 'public' | 'local') =>
    buildAdminApp({
      surface, username: 'u', passwordHash: await hashPassword('a-long-test-password'),
      totpSecret: TOTP, sessionSecret: SECRET, version: '9.9.9', fleetDb: writer,
    })

  const auth = async (surface: 'public' | 'local') =>
    ({ authorization: `Bearer ${await mintAdminSession(SECRET, 'u', surface)}` })

  it('⚠️ refuses to store a JSON null at the database level', async () => {
    // The row's EXISTENCE is the "set" signal, so a stored null would be a row
    // that counts as set while holding nothing — unset and set at once. The
    // CHECK makes that unsayable rather than merely discouraged.
    await expect(
      admin.query(`INSERT INTO fleet_flags (key, value) VALUES ('bad', 'null'::jsonb)`)
    ).rejects.toThrow(/check constraint/i)
  })

  it('⚠️ does NOT register the write on the public surface', async () => {
    // A fleet flag reaches every tenant within a minute, and the dangerous
    // value is a perfectly VALID one: `* * * * * *` on a scraper cadence would
    // have five factions calling Torn every second on their own pooled keys — a
    // fleet-wide rate-limit ban from one typo, with no undo that gives the keys
    // back. So it 404s here because the route does not exist, not because a
    // guard said no.
    const app = await build('public')
    const res = await app.inject({
      method: 'PUT', url: '/api/admin/local/flags/scraper.schedule.items-sync',
      headers: await auth('public'), payload: { value: '0 0 * * * *' },
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('writes, reads and deletes from the local surface', async () => {
    const local = await build('local')
    const set = await local.inject({
      method: 'PUT', url: '/api/admin/local/flags/scraper.schedule.items-sync',
      headers: await auth('local'),
      payload: { value: '0 0 */12 * * *', description: 'fleet item catalogue cadence' },
    })
    expect(set.statusCode).toBe(200)
    expect(set.json().flag).toMatchObject({
      key: 'scraper.schedule.items-sync', value: '0 0 */12 * * *',
      description: 'fleet item catalogue cadence',
    })

    // Reading is safe from anywhere, so it IS on the public surface.
    const pub = await build('public')
    const list = await pub.inject({
      method: 'GET', url: '/api/admin/flags', headers: await auth('public'),
    })
    expect(list.statusCode).toBe(200)
    expect(list.json().flags[0]).toMatchObject({ key: 'scraper.schedule.items-sync' })
    await pub.close()

    const del = await local.inject({
      method: 'DELETE', url: '/api/admin/local/flags/scraper.schedule.items-sync',
      headers: await auth('local'),
    })
    expect(del.json()).toMatchObject({ ok: true, deleted: true })

    // ⚠️ Deleting an absent flag is reported, not 404'd: "it is not set" is the
    // state the caller asked for, and an error would make a retry after a
    // half-successful run look like a failure.
    const again = await local.inject({
      method: 'DELETE', url: '/api/admin/local/flags/scraper.schedule.items-sync',
      headers: await auth('local'),
    })
    expect(again.json()).toMatchObject({ ok: true, deleted: false })
    await local.close()
  })

  it('⚠️ refuses a null value rather than storing a pretend-unset', async () => {
    const local = await build('local')
    const res = await local.inject({
      method: 'PUT', url: '/api/admin/local/flags/some.flag',
      headers: await auth('local'), payload: { value: null },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('DELETE')
    await local.close()
  })

  it('requires authentication', async () => {
    const pub = await build('public')
    expect((await pub.inject({ method: 'GET', url: '/api/admin/flags' })).statusCode).toBe(401)
    await pub.close()
  })
})
