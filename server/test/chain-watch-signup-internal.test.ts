// #1007 — signing up from the Discord board.
//
// The bot is trusted with WHO clicked and nothing else. These tests hold the
// endpoint to the website's member rules, case by case, so a Discord sign-up
// can never do what a website one cannot.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'
import { deriveTenantToken } from '../src/fleetMetricsAuth.js'
import { chainWatchScope } from '../../db/chainWatchTokenLib.mjs'

const FLEET_SECRET = 'chain-watch-secret-for-tests'
const TOKEN = deriveTenantToken(FLEET_SECRET, chainWatchScope(TEST_FACTION.slug))
const OTHER = deriveTenantToken(FLEET_SECRET, chainWatchScope('someone-else'))
const HOUR = 3600_000
const NOW = Date.now()
const top = (h: number) => NOW - (NOW % HOUR) + h * HOUR

let stack: TestStack
let eventId: number

async function post(path: string, body: unknown, token: string | null = TOKEN) {
  const res = await fetch(`${stack.baseUrl}/api/internal/chain-watch/signups${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}
const signUp = (member: string, hour: number, token?: string | null) =>
  post('', { member_id: member, hour_start: hour }, token)
const drop = (member: string, hour: number) => post('/drop', { member_id: member, hour_start: hour })

async function makeEvent(over: Record<string, unknown> = {}) {
  await stack.db.query('DELETE FROM chain_watch_signups')
  await stack.db.query('DELETE FROM chain_events')
  const cols = {
    title: 'Halloween 100k Chain',
    starts_at: new Date(top(-3)).toISOString(),
    ends_at: new Date(top(40)).toISOString(),
    slots_per_hour: 2,
    status: 'open',
    ...over,
  } as Record<string, unknown>
  const keys = Object.keys(cols)
  const { rows } = await stack.db.query(
    `INSERT INTO chain_events (${keys.join(',')})
     VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
    keys.map((k) => cols[k]))
  return rows[0].id as number
}

const live = async () => (await stack.db.query(
  `SELECT member_id, slot_index, via, (extract(epoch FROM hour_start) * 1000)::bigint AS h
     FROM chain_watch_signups WHERE removed_at IS NULL ORDER BY hour_start, slot_index`)).rows

beforeAll(async () => {
  stack = await startTestStack(undefined, {}, { chainWatchToken: TOKEN })
  await stack.db.query(`
    INSERT INTO members (member_id, member_name, tier, is_current) VALUES
      ('7001', 'Goosey', 3, true), ('7002', 'Muttley', 3, true),
      ('7003', 'CalliBee', 3, true), ('7009', 'LongGone', 3, false)
    ON CONFLICT (member_id) DO NOTHING`)
}, 60000)

afterAll(async () => { await stack?.close() })

beforeEach(async () => { eventId = await makeEvent() })

describe('auth', () => {
  it('needs this tenant\'s token', async () => {
    expect((await signUp('7001', top(2), null)).status).toBe(401)
    expect((await signUp('7001', top(2), OTHER)).status).toBe(401)
    expect(await live()).toEqual([])
  })
})

describe('sign up', () => {
  it('takes the first free place and records that it came from Discord', async () => {
    const r = await signUp('7001', top(2))
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ ok: true, event_id: eventId, slot_index: 0, member_name: 'Goosey', hour_start: top(2) })
    const second = await signUp('7002', top(2))
    expect(second.body.slot_index).toBe(1)
    expect((await live()).map((s) => s.via)).toEqual(['discord', 'discord'])
  })

  it('refuses anyone not on the roster, before anything else', async () => {
    for (const who of ['7009', '424242']) {
      const r = await signUp(who, top(2))
      expect(r.body).toMatchObject({ ok: false, code: 'not_member' })
    }
    await stack.db.query('DELETE FROM chain_events')
    expect((await signUp('424242', top(2))).body.code).toBe('not_member')
    expect(await live()).toEqual([])
  })

  it('applies the website\'s rules, each with its own code', async () => {
    expect((await signUp('7001', top(2) + 60_000)).body.code).toBe('not_on_hour')
    expect((await signUp('7001', top(60))).body.code).toBe('outside_event')
    expect((await signUp('7001', top(-2))).body.code).toBe('hour_finished')
    // The hour you are in is fine — you are watching it.
    expect((await signUp('7001', top(0))).status).toBe(201)

    await signUp('7001', top(3))
    expect((await signUp('7001', top(3))).body.code).toBe('already_signed_up')
    await signUp('7002', top(3))
    expect((await signUp('7003', top(3))).body.code).toBe('hour_full')

    expect((await post('', { member_id: 'x', hour_start: 'soon' })).body.code).toBe('bad_request')
  })

  it('says so when there is no open event', async () => {
    await makeEvent({ status: 'closed' })
    expect((await signUp('7001', top(2))).body.code).toBe('no_event')
  })

  it('two people racing for the last place: one wins, one is told it is full', async () => {
    await makeEvent({ slots_per_hour: 1 })
    const [a, b] = await Promise.all([signUp('7001', top(5)), signUp('7002', top(5))])
    expect([a.status, b.status].sort()).toEqual([201, 409])
    expect([a.body.code, b.body.code].filter(Boolean)).toEqual(['hour_full'])
    expect(await live()).toHaveLength(1)
  })
})

describe('drop', () => {
  it('drops your own slot before the hour starts', async () => {
    await signUp('7001', top(4))
    const r = await drop('7001', top(4))
    expect(r.body).toMatchObject({ ok: true })
    expect(await live()).toEqual([])
    const row = (await stack.db.query('SELECT removed_by, removed_reason FROM chain_watch_signups')).rows[0]
    expect(row).toEqual({ removed_by: '7001', removed_reason: 'Dropped from Discord' })
  })

  it('cannot drop somebody else\'s, or an hour that has started', async () => {
    await signUp('7001', top(4))
    expect((await drop('7002', top(4))).body.code).toBe('not_signed_up')
    await signUp('7001', top(0))
    expect((await drop('7001', top(0))).body.code).toBe('hour_started')
    expect(await live()).toHaveLength(2)
  })
})
