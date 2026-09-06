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
