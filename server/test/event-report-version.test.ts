// "Has the event report changed?" (#972), against real Postgres.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'
import { reportVersion } from '../src/events/eventReport.js'

let stack: TestStack
const US = Number(TEST_FACTION.tornFactionId)
const START = Date.UTC(2026, 9, 1, 10)
const END = START + 7 * 86_400_000
let eventId: number

const attack = (id: number, at: number, faction = US) => stack.db.query(
  `INSERT INTO faction_attacks (attack_id, started, attacker_id, attacker_faction_id, defender_id, defender_faction_id, result, is_incoming)
   VALUES ($1, $2, 1, $3, 50, 777, 'Mugged', false)
   ON CONFLICT (attack_id) DO UPDATE SET result = EXCLUDED.result`,
  [id, Math.floor(at / 1000), faction])
const hash = (h: string) => stack.db.query(
  `INSERT INTO event_chain_report_latest (event_id, chain_id, chain_start, details, attackers, bonuses, non_attackers, content_hash)
   VALUES ($1, 1, now(), '{}', '[]', '[]', '[]', $2)
   ON CONFLICT (event_id) DO UPDATE SET content_hash = EXCLUDED.content_hash`, [eventId, h])
const version = () => reportVersion(stack.db, eventId, US, START, END)

beforeAll(async () => { stack = await startTestStack() }, 30_000)
afterAll(async () => { await stack?.close() })
beforeEach(async () => {
  await stack.db.query('DELETE FROM faction_events')
  await stack.db.query('DELETE FROM faction_attacks')
  eventId = Number((await stack.db.query(
    `INSERT INTO faction_events (name, starts_at, daily_from, min_ends_at)
     VALUES ('Halloween', to_timestamp($1 / 1000.0), to_timestamp($1 / 1000.0), to_timestamp($2 / 1000.0)) RETURNING id`,
    [START, END])).rows[0].id)
})

describe('reportVersion', () => {
  it('changes when attacks-sync inserts a new attack', async () => {
    await attack(100, START + 1000)
    const before = await version()
    await attack(101, START + 2000)
    expect(await version()).not.toBe(before)
  })

  it('⚠️ does NOT change when attacks-sync re-reads the newest attack (rows_written = 1, nothing new)', async () => {
    await attack(100, START + 1000)
    const before = await version()
    await attack(100, START + 1000)
    expect(await version()).toBe(before)
  })

  it('⚠️ changes when an outage backfill lands below the newest id', async () => {
    await attack(100, START + 1000)
    await attack(300, START + 3000)
    const before = await version()
    await attack(200, START + 2000)
    expect(await version()).not.toBe(before)
  })

  it('changes with a changed chain report, not with an identical one', async () => {
    await hash('a')
    const before = await version()
    await hash('a')
    expect(await version()).toBe(before)
    await hash('b')
    expect(await version()).not.toBe(before)
  })

  it('ignores attacks outside the window and between other factions', async () => {
    const before = await version()
    await attack(100, START - 1000)
    await attack(101, START + 1000, 4242)
    expect(await version()).toBe(before)
  })
})

describe('GET /api/events/:id/report/version', () => {
  it('serves the version, reused for a few seconds', async () => {
    const key = 'VERSIONMEMBER7300'
    stack.torn.addKey(key, { id: '7300', factionId: TEST_FACTION.tornFactionId })
    const login = await fetch(`${stack.baseUrl}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey: key }),
    })
    const token = ((await login.json()) as any).token
    const ask = async () => ((await (await fetch(`${stack.baseUrl}/api/events/${eventId}/report/version`,
      { headers: { authorization: `Bearer ${token}` } })).json()) as any).version
    const first = await ask()
    expect(first).toMatch(/^-:0:0:0$/)
    await attack(100, START + 1000)
    // ⚠️ Memoised — a hundred tabs asking within the window cost one query.
    expect(await ask()).toBe(first)
  })
})
