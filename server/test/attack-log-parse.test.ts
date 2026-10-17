// Parsing the archive and the report's highlights (#974), against real Postgres.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'
import { parsePendingLogs } from '../src/events/attackLogParse.js'
import { highlightsSection, nameBook } from '../src/events/eventReport.js'

let stack: TestStack
const US = Number(TEST_FACTION.tornFactionId)
const START = Date.UTC(2026, 9, 25, 10)
const DAILY = Date.UTC(2026, 9, 26)
let eventId: number

const line = (action: string, icon: string, text: string, a: number | null, d: number | null) => ({
  text, timestamp: 1, action, icon: `attacking-events-${icon}`,
  attacker: a == null ? null : { id: a, name: `p${a}`, item: null }, defender: d == null ? null : { id: d, name: `p${d}` },
})

let seq = 1
async function archived(o: { from: number; to: number; incoming?: boolean; at?: number; log: any[]; summary?: any[] }) {
  const id = seq++
  await stack.db.query(
    `INSERT INTO faction_attacks (attack_id, code, started, attacker_id, attacker_name, attacker_faction_id,
       defender_id, defender_name, defender_faction_id, result, is_incoming)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Mugged', $10)`,
    [id, `c${id}`, Math.floor((o.at ?? DAILY + 3_600_000) / 1000), o.from, `p${o.from}`, o.incoming ? 999 : US,
      o.to, `p${o.to}`, o.incoming ? US : 777, !!o.incoming])
  await stack.db.query(
    `INSERT INTO event_attack_logs (attack_id, event_id, code, status, raw, lines)
     VALUES ($1, $2, $3, 'archived', $4, $5)`,
    [id, eventId, `c${id}`, JSON.stringify({ pages: [{ attacklog: { log: o.log, summary: o.summary ?? [] } }] }), o.log.length])
  return id
}

beforeAll(async () => {
  stack = await startTestStack()
  await stack.db.query(`INSERT INTO members (member_id, member_name, is_current) VALUES ('1', 'Ann', true), ('2', 'Cal', true) ON CONFLICT DO NOTHING`)
}, 30_000)
afterAll(async () => { await stack?.close() })
beforeEach(async () => {
  await stack.db.query('DELETE FROM faction_events')
  await stack.db.query('DELETE FROM faction_attacks')
  eventId = Number((await stack.db.query(
    `INSERT INTO faction_events (name, starts_at, daily_from, min_ends_at)
     VALUES ('Halloween', to_timestamp($1 / 1000.0), to_timestamp($2 / 1000.0), to_timestamp($2 / 1000.0 + 604800)) RETURNING id`,
    [START, DAILY])).rows[0].id)
})

const highlights = () => highlightsSection(stack.db, eventId, DAILY, nameBook([{ id: 1, name: 'Ann' }, { id: 2, name: 'Cal' }]))

describe('parsePendingLogs', () => {
  it('stores mugs, damage and one row per effect line', async () => {
    const id = await archived({ from: 1, to: 50, log: [
      line('critical hit', 'powerful', 'Ann fired 2 rounds of her Enfield SA-80 critically hitting X in the Head for 2,286', 1, 50),
      line('mug', 'mug', 'Ann mugged X for $1,000 (+2.50)', 1, 50),
      line('mug', 'plunder', 'Plunder increased money mugged by 20.23%', 1, 50),
    ], summary: [{ id: 1, hits: 1, misses: 0, damage: 2286 }, { id: 50, hits: 0, misses: 1, damage: 0 }] })
    expect(await parsePendingLogs(stack.db, US)).toBe(1)
    const p = (await stack.db.query('SELECT * FROM event_attack_log_parsed WHERE attack_id = $1', [id])).rows[0]
    expect([Number(p.member_id), Number(p.mug_amount), p.biggest_hit, p.damage_dealt, p.hit_damages])
      .toEqual([1, 1000, 2286, 2286, [2286]])
    const fx = (await stack.db.query('SELECT effect FROM event_attack_log_effects WHERE attack_id = $1 ORDER BY seq', [id])).rows
    expect(fx.map((r) => r.effect)).toEqual(['powerful', 'plunder'])
  })

  it('⚠️ is idempotent — running again changes nothing and duplicates nothing', async () => {
    await archived({ from: 1, to: 50, log: [line('hosp', 'stricken', "Stricken increased X's hospital time by 68.19%", 1, 50)] })
    await parsePendingLogs(stack.db, US)
    expect(await parsePendingLogs(stack.db, US)).toBe(0)
    // Force a full re-parse, as a parser version bump would.
    await stack.db.query('UPDATE event_attack_log_parsed SET parser_version = 0')
    expect(await parsePendingLogs(stack.db, US)).toBe(1)
    expect(Number((await stack.db.query('SELECT count(*) AS n FROM event_attack_log_effects')).rows[0].n)).toBe(1)
  })

  it('skips logs that are gone', async () => {
    const id = seq++
    await stack.db.query(`INSERT INTO faction_attacks (attack_id, code, started, attacker_faction_id, result) VALUES ($1, 'x', 1, $2, 'Lost')`, [id, US])
    await stack.db.query(`INSERT INTO event_attack_logs (attack_id, event_id, code, status) VALUES ($1, $2, 'x', 'gone')`, [id, eventId])
    expect(await parsePendingLogs(stack.db, US)).toBe(0)
  })
})

describe('highlightsSection', () => {
  it('is null before anything is parsed', async () => {
    expect(await highlights()).toBeNull()
  })

  it('ranks the highest mug, the biggest hit and the most effects — our members only', async () => {
    await archived({ from: 1, to: 50, log: [
      line('hit', 'powerful', 'Ann hit X with his Kodachi in the Chest for 3,000', 1, 50),
      line('mug', 'mug', 'Ann mugged X for $9,000 (+2.50)', 1, 50),
    ] })
    await archived({ from: 2, to: 51, log: [
      line('hit', 'standart-damage', 'Cal hit Y with his Kodachi in the Chest for 500', 2, 51),
      line('hit', 'riot', 'Y hit Cal with his Meat Hook in the Stomach for 9,999', 51, 2),
      line('mug', 'mug', 'Cal mugged Y for $20,000 (+2.50)', 2, 51),
    ] })
    // Incoming: the enemy's mug is not our highest mug.
    await archived({ from: 999, to: 1, incoming: true, log: [
      line('mug', 'mug', 'Z mugged Ann for $5,000,000 (+2.50)', 999, 1),
    ] })
    await parsePendingLogs(stack.db, US)
    const h = (await highlights())!
    expect(h.highest_mugs.map((m) => [m.name, m.amount])).toEqual([['Cal', 20000], ['Ann', 9000]])
    expect(h.biggest_hits[0]).toMatchObject({ name: 'Ann', damage: 3000 })
    // ⚠️ The opponent's 9,999 riot hit is theirs, not Cal's.
    expect(h.biggest_hits.find((b) => b.name === 'Cal')!.damage).toBe(500)
    expect(h.most_effects).toEqual([{ id: 1, name: 'Ann', total: 1, effects: { powerful: 1 } }])
    expect(h.effects_by_day).toEqual([{ day: '2026-10-26', starts_at: DAILY, effects: { powerful: 1 } }])
    expect(h.total_mugged).toBe(29000)
    expect(h.bounties).toEqual({ claimed: 0, total: 0, by_member: [], top: [] })
  })

  it('lists bounties our members claimed, not ones claimed on us', async () => {
    await archived({ from: 1, to: 50, log: [line('hosp', 'hospitalize', 'Ann hospitalized X and claimed a $444,444 bounty (+4.50)', 1, 50)] })
    await archived({ from: 999, to: 2, incoming: true, log: [line('hosp', 'hospitalize', 'Z hospitalized Cal and claimed a $9,000,000 bounty', 999, 2)] })
    await parsePendingLogs(stack.db, US)
    const h = (await highlights())!
    expect(h.bounties).toEqual({ claimed: 1, total: 444444,
      by_member: [{ id: 1, name: 'Ann', claims: 1, total: 444444 }],
      top: [expect.objectContaining({ name: 'Ann', amount: 444444, target: 'p50' })] })
  })

  it('ranks most earned from bounties per member, by total value', async () => {
    for (const amt of ['10', '20']) {
      await archived({ from: 1, to: 50, log: [line('hosp', 'hospitalize', `Ann hospitalized X and claimed a $${amt} bounty`, 1, 50)] })
    }
    await archived({ from: 2, to: 51, log: [line('hosp', 'hospitalize', 'Cal hospitalized Y and claimed a $25 bounty', 2, 51)] })
    await parsePendingLogs(stack.db, US)
    const h = (await highlights())!
    expect(h.bounties.by_member).toEqual([
      { id: 1, name: 'Ann', claims: 2, total: 30 }, { id: 2, name: 'Cal', claims: 1, total: 25 }])
    expect(h.bounties.top[0]).toMatchObject({ name: 'Cal', amount: 25 })
  })
})
