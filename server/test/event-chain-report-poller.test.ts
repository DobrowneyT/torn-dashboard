// The live chain-report poller (#970), against real Postgres and a fake Torn.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, TEST_KEY_ENCRYPTION_KEY, type TestStack } from './harness.js'
import { createKeyPool } from '../src/scraper/keyPool.js'
import { createChainReportPoller } from '../src/events/chainReportPoller.js'
import { currentEvent } from '../src/events/eventRoutes.js'

let stack: TestStack
const US = Number(TEST_FACTION.tornFactionId)
const HOUR = 3_600_000
const KEY = 'POLLERKEY5001AAAA'

// Torn answers with whatever `serve` holds; `seen` records each request's query.
let serve: () => unknown
let seen: URLSearchParams[]
let clock: number

const report = (over: Record<string, unknown> = {}) => ({
  chainreport: {
    id: 900, faction_id: US, start: Math.floor((clock - HOUR) / 1000), end: 0,
    details: { chain: 120, respect: 300 },
    bonuses: [{ attacker_id: 5001, defender_id: 9, chain: 100, respect: 80 }],
    attackers: [{ id: 5001, respect: { total: 300, average: 2.5, best: 80 }, attacks: { total: 120 } }],
    non_attackers: [5002],
    ...over,
  },
})

function poller() {
  return createChainReportPoller({
    db: stack.db,
    pool: createKeyPool({ db: stack.db, encryptionKey: TEST_KEY_ENCRYPTION_KEY }),
    tornBaseUrl: stack.tornBaseUrl,
    now: () => clock,
  })
}

async function liveEvent(over: { starts?: number; minEnd?: number } = {}) {
  const r = await stack.db.query(
    `INSERT INTO faction_events (name, starts_at, daily_from, min_ends_at)
     VALUES ('Halloween', to_timestamp($1 / 1000.0), to_timestamp($1 / 1000.0), to_timestamp($2 / 1000.0))
     RETURNING id`,
    [over.starts ?? clock - 2 * HOUR, over.minEnd ?? clock + 24 * HOUR])
  return Number(r.rows[0].id)
}

const state = async (id: number) =>
  (await stack.db.query('SELECT * FROM event_chain_report_poll_state WHERE event_id = $1', [id])).rows[0]
const count = async (table: string) =>
  Number((await stack.db.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n)

beforeAll(async () => {
  stack = await startTestStack()
  await stack.db.query(`INSERT INTO members (member_id, member_name, is_current) VALUES ('5001', 'Chainer', true)`)
  stack.torn.setHandler('/v2/faction/chainreport', (url) => { seen.push(url.searchParams); return serve() })
}, 30_000)

afterAll(async () => { await stack?.close() })

beforeEach(async () => {
  clock = Date.UTC(2026, 9, 26, 12)
  seen = []
  serve = () => report()
  await stack.db.query('DELETE FROM faction_events')
  await stack.db.query('DELETE FROM member_secrets')
  await createKeyPool({ db: stack.db, encryptionKey: TEST_KEY_ENCRYPTION_KEY })
    .store('5001', KEY, { consentVersion: 'v2' })
})

describe('gating', () => {
  it('makes no Torn call with no live event', async () => {
    expect((await poller().pollOnce()).kind).toBe('idle')
    expect(seen).toHaveLength(0)
  })

  it('makes no Torn call before the event opens', async () => {
    await liveEvent({ starts: clock + HOUR })
    expect((await poller().pollOnce()).kind).toBe('idle')
    expect(seen).toHaveLength(0)
  })
})

describe('storing', () => {
  it('stores details, attackers, bonuses and non-attackers, timestamped', async () => {
    const id = await liveEvent()
    expect(await poller().pollOnce()).toEqual({ kind: 'changed', chainId: 900, snapshot: true })
    const latest = (await stack.db.query(
      `SELECT *, (extract(epoch from sampled_at) * 1000)::bigint AS ms FROM event_chain_report_latest`)).rows[0]
    expect(Number(latest.event_id)).toBe(id)
    expect(latest.details.chain).toBe(120)
    expect(latest.attackers[0].id).toBe(5001)
    expect(latest.bonuses[0].respect).toBe(80)
    expect(latest.non_attackers).toEqual([5002])
    expect(Number(latest.ms)).toBe(clock)
    expect(await count('event_chain_report_samples')).toBe(1)
    expect(await count('event_chain_report_snapshots')).toBe(1)
  })

  it('⚠️ busts Torn\'s ~30 s cache with `timestamp` on every call', async () => {
    await liveEvent()
    await poller().pollOnce()
    expect(seen[0].get('timestamp')).toBe(String(Math.floor(clock / 1000)))
  })

  it('counts an unchanged report as a poll, not a change, and stores nothing new', async () => {
    const id = await liveEvent()
    const p = poller()
    await p.pollOnce()
    clock += 5_000
    expect((await p.pollOnce()).kind).toBe('unchanged')
    const s = await state(id)
    expect([Number(s.polls), Number(s.changes)]).toEqual([2, 1])
    expect(await count('event_chain_report_samples')).toBe(1)
  })

  it('keeps every change as a sample but full snapshots only every few minutes', async () => {
    await liveEvent()
    const p = poller()
    await p.pollOnce()
    clock += 5_000
    serve = () => report({ details: { chain: 121, respect: 302 } })
    expect(await p.pollOnce()).toEqual({ kind: 'changed', chainId: 900, snapshot: false })
    clock += 5 * 60_000
    serve = () => report({ details: { chain: 160, respect: 400 } })
    expect(await p.pollOnce()).toEqual({ kind: 'changed', chainId: 900, snapshot: true })
    expect(await count('event_chain_report_samples')).toBe(3)
    expect(await count('event_chain_report_snapshots')).toBe(2)
  })
})

describe('refusing the wrong report', () => {
  it('⚠️ never stores another faction\'s report (a key whose owner has left)', async () => {
    const id = await liveEvent()
    serve = () => report({ faction_id: US + 1 })
    expect((await poller().pollOnce()).kind).toBe('skipped')
    expect(await count('event_chain_report_latest')).toBe(0)
    expect((await state(id)).last_skip_reason).toMatch(/not 53100/)
  })

  it('⚠️ ignores the faction\'s last ordinary chain from before the event', async () => {
    const id = await liveEvent()
    serve = () => report({ start: Math.floor((clock - 30 * HOUR) / 1000), end: Math.floor((clock - 26 * HOUR) / 1000) })
    expect((await poller().pollOnce()).kind).toBe('skipped')
    expect(await count('event_chain_report_latest')).toBe(0)
    expect((await state(id)).last_skip_reason).toMatch(/waiting for the event chain/)
  })
})

describe('outages', () => {
  it('⚠️ records failures visibly and recovers by itself', async () => {
    const id = await liveEvent()
    const p = poller()
    serve = () => ({ error: { code: 9, error: 'API disabled' } })
    expect((await p.pollOnce()).kind).toBe('failed')
    expect((await p.pollOnce()).kind).toBe('failed')
    let s = await state(id)
    expect([Number(s.failures), s.consecutive_failures]).toEqual([2, 2])
    expect(s.last_error).toMatch(/9/)

    serve = () => report()
    expect((await p.pollOnce()).kind).toBe('changed')
    s = await state(id)
    expect([Number(s.failures), s.consecutive_failures]).toEqual([2, 0])
    expect(await count('event_chain_report_latest')).toBe(1)
  })

  it('disables a key Torn rejects', async () => {
    await liveEvent()
    serve = () => ({ error: { code: 2, error: 'Incorrect key' } })
    await poller().pollOnce()
    const k = (await stack.db.query(`SELECT disabled FROM member_secrets WHERE member_id = '5001'`)).rows[0]
    expect(k.disabled).toBe(true)
  })

  it('records an empty pool as a failure', async () => {
    const id = await liveEvent()
    await stack.db.query('DELETE FROM member_secrets')
    expect((await poller().pollOnce()).kind).toBe('failed')
    expect((await state(id)).last_error).toMatch(/no pooled key/)
    expect(seen).toHaveLength(0)
  })
})

describe('ending the event (#967 rule)', () => {
  it('⚠️ ends at the report\'s exact chain end, once polls run past it', async () => {
    const minEnd = clock - HOUR
    const id = await liveEvent({ starts: clock - 48 * HOUR, minEnd })
    const chainEnd = clock - 10 * 60_000
    // What the poller leaves behind once the chain is over: the report's end,
    // and a successful poll ten minutes past it.
    await stack.db.query(
      `INSERT INTO event_chain_report_latest (event_id, chain_id, chain_start, chain_end, details, attackers, bonuses, non_attackers, content_hash)
       VALUES ($1, 900, now(), to_timestamp($2 / 1000.0), '{}', '[]', '[]', '[]', 'x')`, [id, chainEnd])
    await stack.db.query(
      `INSERT INTO event_chain_report_poll_state (event_id, last_ok_at) VALUES ($1, to_timestamp($2 / 1000.0))`,
      [id, clock])
    expect(await currentEvent(stack.db, clock)).toBeNull()
    const e = (await stack.db.query(
      `SELECT (extract(epoch from ended_at) * 1000)::bigint AS ms FROM faction_events WHERE id = $1`, [id])).rows[0]
    expect(Number(e.ms)).toBe(chainEnd)
  })

  it('⚠️ a report end the polls have NOT run past keeps the event live', async () => {
    const id = await liveEvent({ starts: clock - 48 * HOUR, minEnd: clock - HOUR })
    await stack.db.query(
      `INSERT INTO event_chain_report_latest (event_id, chain_id, chain_start, chain_end, details, attackers, bonuses, non_attackers, content_hash)
       VALUES ($1, 900, now(), to_timestamp($2 / 1000.0), '{}', '[]', '[]', '[]', 'x')`, [id, clock - 5_000])
    await stack.db.query(
      `INSERT INTO event_chain_report_poll_state (event_id, last_ok_at) VALUES ($1, to_timestamp($2 / 1000.0))`,
      [id, clock])
    expect((await currentEvent(stack.db, clock))?.phase).toBe('live')
  })
})
