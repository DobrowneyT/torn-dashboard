// The event Report tab's data (#971), against real Postgres.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'

let stack: TestStack
let member: string
const US = Number(TEST_FACTION.tornFactionId)
const DAY = 86_400_000
// Day boundaries in the past so the whole window is "so far".
const START = Date.UTC(2026, 9, 1, 10)
const DAILY = Date.UTC(2026, 9, 2, 0)

async function loginAs(key: string, id: string) {
  stack.torn.addKey(key, { id, factionId: TEST_FACTION.tornFactionId })
  const res = await fetch(`${stack.baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey: key }),
  })
  return ((await res.json()) as any).token as string
}

const get = async (path: string) => {
  const res = await fetch(`${stack.baseUrl}${path}`, { headers: { authorization: `Bearer ${member}` } })
  return { status: res.status, body: (await res.json()) as any }
}

let seq = 1
function attack(o: { at: number; from: number; to: number; result: string; incoming?: boolean; respect?: number; fromName?: string }) {
  return stack.db.query(
    `INSERT INTO faction_attacks (attack_id, started, attacker_id, attacker_name, attacker_faction_id,
       defender_id, defender_name, defender_faction_id, result, respect_gain, is_incoming)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [seq++, Math.floor(o.at / 1000), o.from, o.fromName ?? `p${o.from}`, o.incoming ? 999 : US,
      o.to, `p${o.to}`, o.incoming ? US : 777, o.result, o.respect ?? 0, !!o.incoming])
}

async function event() {
  const r = await stack.db.query(
    `INSERT INTO faction_events (name, starts_at, daily_from, min_ends_at, ended_at)
     VALUES ('Halloween', to_timestamp($1 / 1000.0), to_timestamp($2 / 1000.0),
             to_timestamp($3 / 1000.0), to_timestamp($3 / 1000.0)) RETURNING id`,
    [START, DAILY, DAILY + 3 * DAY])
  return Number(r.rows[0].id)
}

beforeAll(async () => {
  stack = await startTestStack()
  member = await loginAs('REPORTMEMBER7200X', '7200')
  await stack.db.query(
    `INSERT INTO members (member_id, member_name, is_current) VALUES ('1', 'Alice', true), ('2', 'Bob', true), ('3', 'Cara', true)
     ON CONFLICT (member_id) DO NOTHING`)
}, 30_000)
afterAll(async () => { await stack?.close() })
beforeEach(async () => {
  await stack.db.query('DELETE FROM faction_events')
  await stack.db.query('DELETE FROM faction_attacks')
})

describe('chain section (from the chain report)', () => {
  it('⚠️ shows respect raw AND capped, with the deduction named', async () => {
    const id = await event()
    await stack.db.query(
      `INSERT INTO event_chain_report_latest (event_id, chain_id, chain_start, details, attackers, bonuses, non_attackers, content_hash)
       VALUES ($1, 5, now(), $2, $3, $4, $5, 'h')`,
      [id,
        JSON.stringify({ chain: 120, respect: 1100, members: 2, mug: 40 }),
        JSON.stringify([
          { id: 1, respect: { total: 1000, average: 9, best: 320 }, attacks: { total: 100, mug: 30 } },
          { id: 2, respect: { total: 100, average: 5, best: 10 }, attacks: { total: 20, mug: 10 } }]),
        JSON.stringify([{ attacker_id: 1, defender_id: 9, chain: 100, respect: 320 }, { attacker_id: 2, defender_id: 9, chain: 10, respect: 10 }]),
        JSON.stringify([3])])
    const { body } = await get(`/api/events/${id}/report`)
    expect(body.chain.totals.respect).toEqual({ raw: 1100, capped: 790, deduction: 310 })
    expect(body.chain.totals.hits).toBe(120)
    expect(body.chain.totals.bonuses).toBe(2)
    const alice = body.chain.members.find((m: any) => m.id === 1)
    expect(alice.name).toBe('Alice')
    expect(alice.respect).toMatchObject({ total: 1000, capped: 690, deduction: 310 })
    expect(alice.bonus_hits).toBe(1)
    expect(body.chain.non_attackers).toEqual([{ id: 3, name: 'Cara' }])
    expect(body.chain.bonuses.map((b: any) => b.chain)).toEqual([10, 100])
  })

  it('is null until the poller has stored a report', async () => {
    const id = await event()
    expect((await get(`/api/events/${id}/report`)).body.chain).toBeNull()
  })
})

describe('daily (from attacks-sync)', () => {
  it('⚠️ starts at daily_from, not the event start, in TCT days', async () => {
    const id = await event()
    await attack({ at: START + 3_600_000, from: 1, to: 50, result: 'Mugged' })   // before daily_from
    await attack({ at: DAILY + 60_000, from: 1, to: 50, result: 'Mugged', respect: 3 })
    await attack({ at: DAILY + 120_000, from: 1, to: 51, result: 'Assist' })
    await attack({ at: DAILY + DAY - 1_000, from: 2, to: 50, result: 'Lost' })
    await attack({ at: DAILY + DAY + 1_000, from: 2, to: 50, result: 'Hospitalized', respect: 4 })
    await attack({ at: DAILY + 5_000, from: 999, to: 2, result: 'Attacked', incoming: true })
    const { body } = await get(`/api/events/${id}/report`)
    expect(body.daily.map((d: any) => d.day)).toEqual(['2026-10-02', '2026-10-03'])
    const [d1, d2] = body.daily
    expect(d1.totals).toMatchObject({ hits: 1, mug: 1, assists: 1, losses: 1, incoming: 1, beaten: 1 })
    expect(d1.members.find((m: any) => m.id === 1)).toMatchObject({ hits: 1, mug: 1, assists: 1, respect: 3 })
    expect(d2.totals).toMatchObject({ hits: 1, hospitalize: 1, respect: 4 })
  })
})

describe('targets', () => {
  it('lists incoming and outgoing per member, and who was hit most', async () => {
    const id = await event()
    for (let i = 0; i < 3; i++) await attack({ at: START + i * 1000, from: 999, to: 2, result: 'Attacked', incoming: true })
    await attack({ at: START + 9000, from: 998, to: 1, result: 'Lost', incoming: true })
    await attack({ at: START + 10_000, from: 1, to: 50, result: 'Mugged' })
    await attack({ at: START + 11_000, from: 1, to: 50, result: 'Mugged' })
    const { body } = await get(`/api/events/${id}/report`)
    expect(body.targets.most_targeted[0]).toMatchObject({ id: 2, name: 'Bob', incoming: 3, beaten: 3 })
    expect(body.targets.members.find((m: any) => m.id === 1)).toMatchObject({ outgoing: 2, incoming: 1, defended: 1 })
    expect(body.targets.our_top_targets[0]).toMatchObject({ id: 50, hits: 2, by_members: 1 })
    expect(body.targets.top_attackers_on_us[0]).toMatchObject({ id: 999, hits: 3, on_members: 1 })
  })

  it('⚠️ an attack between two of our own members is not incoming', async () => {
    const id = await event()
    await stack.db.query(
      `INSERT INTO faction_attacks (attack_id, started, attacker_id, attacker_name, attacker_faction_id,
         defender_id, defender_name, defender_faction_id, result, is_incoming)
       VALUES (9001, $1, 1, 'Alice', $2, 2, 'Bob', $2, 'Attacked', true)`,
      [Math.floor((START + 5000) / 1000), US])
    const { body } = await get(`/api/events/${id}/report`)
    expect(body.targets.top_attackers_on_us).toEqual([])
    expect(body.targets.most_targeted).toEqual([])
  })

  it('ignores attacks outside the event window', async () => {
    const id = await event()
    await attack({ at: START - 1000, from: 1, to: 50, result: 'Mugged' })
    await attack({ at: DAILY + 4 * DAY, from: 1, to: 50, result: 'Mugged' })
    const { body } = await get(`/api/events/${id}/report`)
    expect(body.targets.members).toEqual([])
    expect(body.daily).toEqual([])
  })
})

it('404s an unknown event', async () => {
  expect((await get('/api/events/999999/report')).status).toBe(404)
})
