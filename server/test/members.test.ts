// Members + Dashboard read endpoints (slice #61), black-box at the HTTP seam
// against a real templated Postgres. These endpoints establish the read
// pattern (server-side joins, snake_case fields, {resource: [...]}) that
// later view slices copy.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'

let stack: TestStack
let token: string

beforeAll(async () => {
  stack = await startTestStack()

  // Shared fixtures for every endpoint test in this file.
  await stack.db.query(`
    INSERT INTO members (member_id, member_name, tier, tier_override, is_current, last_scraped, total_days_in_faction) VALUES
      ('300', 'Trout',  3, NULL, true,  '2026-07-01T00:00:00', 589),
      ('301', 'Salmon', 5, 2,    true,  '2026-07-02T00:00:00', NULL),
      ('302', 'Gone',   6, NULL, false, NULL, NULL)
  `)
  // 300 has an open stint that began 10 days ago → streak 10; 301 has none.
  await stack.db.query(`
    INSERT INTO member_faction_stints (member_id, joined_at, left_at) VALUES
      ('300', now() - interval '10 days', NULL)
  `)
  await stack.db.query(`
    INSERT INTO member_cpr_v2 (member_id, crime_name, position_label, cpr_value) VALUES
      ('300', 'Break the Bank', 'Robber', 80),
      ('300', 'Break the Bank', 'Thief #1', 60),
      ('301', 'Snow Blind', 'Hustler', 55)
  `)

  // A logged-in plain member (no roles) — reads must work for them.
  stack.torn.addKey('MEMBERKEY1234567', { id: '300', factionId: TEST_FACTION.tornFactionId })
  const res = await fetch(`${stack.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey: 'MEMBERKEY1234567' }),
  })
  expect(res.status).toBe(200)
  token = ((await res.json()) as any).token
  expect(token).toBeTruthy()
})

afterAll(async () => {
  await stack?.close()
})

async function get(path: string) {
  const res = await fetch(`${stack.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  return { status: res.status, body: await res.json() as any }
}

describe('GET /api/members', () => {
  it('lists current members with tier, override flag and CPR aggregates', async () => {
    const { status, body } = await get('/api/members')
    expect(status).toBe(200)
    // Former members are excluded; averages come from member_cpr_v2.
    expect(body.members).toEqual([
      {
        member_id: '300',
        member_name: 'Trout',
        tier: 3,
        tier_override: null,
        last_scraped: '2026-07-01T00:00:00',
        total_days_in_faction: 589,
        streak_days: 10,
        avg_cpr: 70,
        role_count: 2,
      },
      {
        member_id: '301',
        member_name: 'Salmon',
        tier: 5,
        tier_override: 2,
        last_scraped: '2026-07-02T00:00:00',
        total_days_in_faction: null,
        streak_days: null, // no open stint
        avg_cpr: 55,
        role_count: 1,
      },
    ])
  })

  it('requires authentication', async () => {
    const res = await fetch(`${stack.baseUrl}/api/members`)
    expect(res.status).toBe(401)
  })
})

describe('GET /api/members/:id', () => {
  it('returns the member profile with their crime/position CPR list', async () => {
    const { status, body } = await get('/api/members/300')
    expect(status).toBe(200)
    expect(body.member.member_id).toBe('300')
    expect(body.member.member_name).toBe('Trout')
    expect(body.member.tier).toBe(3)
    // True since the login-key-pool enrollment: member 300 logged in above,
    // and a member login enrolls its key into the consented pool.
    expect(body.member.has_cpr_key).toBe(true)
    expect(body.member.is_current).toBe(true)
    expect(body.cpr).toEqual([
      { crime_name: 'Break the Bank', difficulty: null, position_label: 'Robber', cpr_value: 80, observation_count: 1 },
      { crime_name: 'Break the Bank', difficulty: null, position_label: 'Thief #1', cpr_value: 60, observation_count: 1 },
    ])
  })

  it('404s for an unknown member', async () => {
    const { status } = await get('/api/members/424242')
    expect(status).toBe(404)
  })
})

describe('GET /api/members/:id/daily-stats', () => {
  it('returns newest-first snapshots with gym stats as numbers, capped by limit', async () => {
    await stack.db.query(`
      INSERT INTO member_daily_stats (member_id, snapshot_date, personalstats, gym_strength, gym_speed, gym_dexterity, gym_defense, gym_energy) VALUES
        ('300', '2026-07-01', '{"attackswon": 10}', 1000, 2000, 3000, 4000, 150),
        ('300', '2026-07-02', '{"attackswon": 12}', 1100, 2100, 3100, 4100, 150),
        ('300', '2026-07-03', '{"attackswon": 15}', 1200, 2200, 3200, 4200, 150)
    `)
    const { status, body } = await get('/api/members/300/daily-stats?limit=2')
    expect(status).toBe(200)
    expect(body.daily_stats).toHaveLength(2)
    expect(body.daily_stats[0].snapshot_date).toBe('2026-07-03')
    expect(body.daily_stats[0].personalstats).toEqual({ attackswon: 15 })
    expect(body.daily_stats[0].gym_strength).toBe(1200)
    expect(body.daily_stats[1].snapshot_date).toBe('2026-07-02')
  })
})

describe('GET /api/members/:id/crimes', () => {
  it('returns the crimes the member joined, merged with their slot details', async () => {
    await stack.db.query(`
      INSERT INTO crimes (crime_id, name, difficulty, status, executed_at, rewards_money) VALUES
        ('c1', 'Break the Bank', 8, 'Successful', 1751000000, 5000000),
        ('c2', 'Snow Blind', 4, 'Failed', 1750000000, 0)
    `)
    await stack.db.query(`
      INSERT INTO crime_slots (crime_id, "position", position_id, user_id, joined_at, checkpoint_pass_rate, user_outcome) VALUES
        ('c1', 'Robber', 'P1', '300', 1750900000, 82.50, 'success'),
        ('c2', 'Hustler', 'P1', '300', 1749900000, 61.00, 'failure'),
        ('c1', 'Thief #1', 'P4', '301', 1750900001, 70.00, 'success')
    `)
    const { status, body } = await get('/api/members/300/crimes')
    expect(status).toBe(200)
    expect(body.crimes).toHaveLength(2)
    const [first, second] = body.crimes
    // Newest executed first; only this member's slot is merged in.
    expect(first.crime_id).toBe('c1')
    expect(first.name).toBe('Break the Bank')
    expect(first.rewards_money).toBe(5000000)
    expect(first.member_position).toBe('Robber')
    expect(first.member_cpr).toBe(82.5)
    expect(first.member_outcome).toBe('success')
    expect(first.member_joined_at).toBe(1750900000)
    expect(second.crime_id).toBe('c2')
    expect(second.member_position).toBe('Hustler')
  })
})

describe('GET /api/members/:id/payouts', () => {
  it('returns payout rows newest week first with the week summary nested PostgREST-style', async () => {
    await stack.db.query(`
      INSERT INTO oc_payout_weeks (id, week_start, week_end, member_payout_total, crimes_processed) VALUES
        (1, '2026-06-01', '2026-06-07', 100000000, 40),
        (2, '2026-06-08', '2026-06-14', 120000000, 45)
    `)
    await stack.db.query(`
      INSERT INTO oc_payout_members (week_id, week_start, week_end, member_id, member_name, tier, payout, theoretical_payout, time_spent, crimes_count) VALUES
        (1, '2026-06-01', '2026-06-07', '300', 'Trout', 3, 4000000, 4200000, 500000, 6),
        (2, '2026-06-08', '2026-06-14', '300', 'Trout', 3, 5000000, 5100000, 520000, 7)
    `)
    const { status, body } = await get('/api/members/300/payouts')
    expect(status).toBe(200)
    expect(body.payouts).toHaveLength(2)
    expect(body.payouts[0].week_id).toBe(2)
    expect(body.payouts[0].payout).toBe(5000000)
    expect(body.payouts[0].oc_payout_weeks).toEqual({
      week_start: '2026-06-08',
      week_end: '2026-06-14',
      member_payout_total: 120000000,
      crimes_processed: 45,
    })
    expect(body.payouts[1].week_id).toBe(1)
  })
})

describe('GET /api/members/:id/wars', () => {
  it('returns wars the member contributed to, newest first, with their score merged', async () => {
    await stack.db.query(`
      INSERT INTO ranked_wars (id, start_at, end_at, opponent_id, opponent_name, our_score, opponent_score, winner_faction_id) VALUES
        (900, 1750000000, 1750200000, 42, 'Rivals', 3000, 2500, ${TEST_FACTION.tornFactionId}),
        (901, 1751000000, NULL, 43, 'Enemies', 100, 90, NULL)
    `)
    await stack.db.query(`
      INSERT INTO war_member_contributions (war_id, member_id, member_name, score, attacks, faction_id) VALUES
        (900, 300, 'Trout', 250.50, 30, ${TEST_FACTION.tornFactionId}),
        (901, 300, 'Trout', 12.00, 2, ${TEST_FACTION.tornFactionId}),
        (900, 301, 'Salmon', 100.00, 10, ${TEST_FACTION.tornFactionId})
    `)
    const { status, body } = await get('/api/members/300/wars')
    expect(status).toBe(200)
    expect(body.wars).toHaveLength(2)
    expect(body.wars[0].id).toBe(901)
    expect(body.wars[0].opponent_name).toBe('Enemies')
    expect(body.wars[0].my_score).toBe(12)
    expect(body.wars[0].my_attacks).toBe(2)
    expect(body.wars[0].we_won).toBe(false)
    expect(body.wars[1].id).toBe(900)
    expect(body.wars[1].my_score).toBe(250.5)
    // The server owns the "did our faction win" comparison.
    expect(body.wars[1].we_won).toBe(true)
  })
})

describe('GET /api/members/:id/war-payouts', () => {
  it('returns the member war payouts with nested war context, newest first', async () => {
    await stack.db.query(`
      INSERT INTO war_payouts (war_id, war_type, created_at) VALUES
        (900, 'real', '2026-06-20T12:00:00Z')
    `)
    await stack.db.query(`
      INSERT INTO war_payout_members (payout_id, member_id, member_name, payout_amount)
      SELECT id, 300, 'Trout', 25000000 FROM war_payouts WHERE war_id = 900
    `)
    const { status, body } = await get('/api/members/300/war-payouts')
    expect(status).toBe(200)
    expect(body.war_payouts).toHaveLength(1)
    const row = body.war_payouts[0]
    expect(row.payout_amount).toBe(25000000)
    expect(row.war_payouts.war_id).toBe(900)
    // Slice #64 widened the war summary; the original fields must survive.
    expect(row.war_payouts.ranked_wars).toMatchObject({
      start_at: 1750000000,
      end_at: 1750200000,
      opponent_name: 'Rivals',
    })
    expect(row.war_payouts.war_type).toBe('real')
  })
})

describe('GET /api/inventory/loaned', () => {
  it('returns loaned inventory with weighted prices from the pricing view', async () => {
    await stack.db.query(`
      INSERT INTO inventory_items (id, name, quantity, available, loaned, loaned_to, category) VALUES
        ('66', 'Morphine', 50, 40, 10, '[{"member_id":"300","member_name":"Trout","amount":10}]'::jsonb, 'medical'),
        ('67', 'Xanax', 100, 100, 0, NULL, 'drugs')
    `)
    await stack.db.query(`
      INSERT INTO pricing_batches (item_id, price, quantity, added_by) VALUES
        ('66', 20000, 50, 'tester')
    `)
    const { status, body } = await get('/api/inventory/loaned')
    expect(status).toBe(200)
    expect(body.items).toHaveLength(1)
    expect(body.items[0].item_id).toBe('66')
    expect(body.items[0].loaned).toBe(10)
    expect(body.items[0].loaned_to).toEqual([{ member_id: '300', member_name: 'Trout', amount: 10 }])
    expect(body.items[0].weighted_avg_price).toBe(20000)
  })
})

// #422: the Fair Fight column needs the viewer's OWN battle stats, and nothing
// else. The target side comes from the enemy roster the war room already shows
// every member, so this is the only additional read FF requires.
describe('GET /api/members/me/battle-stats', () => {
  it('returns null rather than 404 before the caller has any stats', async () => {
    // A member with no spy on record is the ordinary case, not an error — the
    // FF column shows a dash and the page carries on. Runs first, while the
    // table is still empty for this member.
    const { status, body } = await get('/api/members/me/battle-stats')
    expect(status).toBe(200)
    expect(body.battle_stats).toBeNull()
  })

  it("returns the caller's own row, to a plain member with no roles", async () => {
    // Deliberately NOT leadership-gated: it is the caller's own data, and
    // gating it would make the FF column leadership-only for no security gain.
    await stack.db.query(
      `INSERT INTO member_battle_stats (member_id, strength, defense, speed, dexterity, total, source)
       VALUES ('300', 100, 200, 300, 400, 1000, 'torn'),
              ('301', 9, 9, 9, 9, 36, 'torn')`
    )
    const { status, body } = await get('/api/members/me/battle-stats')
    expect(status).toBe(200)
    expect(body.battle_stats.member_id).toBe('300')
    expect(body.battle_stats.strength).toBe(100)
    expect(body.battle_stats.total).toBe(1000)
  })

  it('never returns anyone else', async () => {
    // The whole safety argument for the column: FF is computed from the
    // viewer's own stats plus the ENEMY's, so no other faction member's stats
    // enter the calculation at any point.
    const { body } = await get('/api/members/me/battle-stats')
    expect(Array.isArray(body.battle_stats)).toBe(false)
    expect(body.battle_stats.member_id).toBe('300')
  })

  it('is not shadowed by the /api/members/:id route', async () => {
    // `me` is a static segment and must win over the :id param; if it did not,
    // this would 404 or try to look up a member literally called "me".
    const { status } = await get('/api/members/me/battle-stats')
    expect(status).toBe(200)
  })
})
