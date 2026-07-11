// OC read surface (slice #62), black-box at the HTTP seam.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'

let stack: TestStack
let token: string

beforeAll(async () => {
  stack = await startTestStack()

  await stack.db.query(`
    INSERT INTO members (member_id, member_name, tier, tier_override, is_current) VALUES
      ('300', 'Trout', 3, NULL, true),
      ('301', 'Salmon', 5, 2, true),
      ('302', 'OldTimer', 6, NULL, false)
  `)
  await stack.db.query(`
    INSERT INTO crimes (crime_id, name, difficulty, status, created_at, executed_at, rewards_money) VALUES
      ('c1', 'Break the Bank', 8, 'Successful', 1751000000, 1751100000, 5000000),
      ('c2', 'Snow Blind', 4, 'Planning', 1752000000, NULL, 0),
      ('c3', 'Honey Trap', 5, 'Recruiting', NULL, NULL, 0)
  `)
  await stack.db.query(`
    INSERT INTO crime_slots (crime_id, "position", position_id, position_number, user_id, user_name, checkpoint_pass_rate) VALUES
      ('c1', 'Robber', 'P1', 1, '300', NULL, 82.50),
      ('c1', 'Thief #1', 'P4', 4, '302', 'OldTimer', 70.00),
      ('c1', 'Muscle #1', 'P2', 2, NULL, NULL, NULL)
  `)

  stack.torn.addKey('MEMBERKEY1234567', { id: '300', factionId: TEST_FACTION.tornFactionId })
  const res = await fetch(`${stack.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey: 'MEMBERKEY1234567' }),
  })
  expect(res.status).toBe(200)
  token = ((await res.json()) as any).token
})

afterAll(async () => {
  await stack?.close()
})

async function get(path: string) {
  const res = await fetch(`${stack.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  return { status: res.status, body: (await res.json()) as any }
}

describe('GET /api/crimes', () => {
  it('pages through crimes newest-created first, nulls last', async () => {
    const { status, body } = await get('/api/crimes?limit=2&offset=0')
    expect(status).toBe(200)
    expect(body.crimes.map((c: any) => c.crime_id)).toEqual(['c2', 'c1'])
    expect(body.crimes[0].name).toBe('Snow Blind')
    expect(body.crimes[1].rewards_money).toBe(5000000)

    const page2 = await get('/api/crimes?limit=2&offset=2')
    expect(page2.body.crimes.map((c: any) => c.crime_id)).toEqual(['c3'])
  })
})

describe('GET /api/crimes/:id/slots', () => {
  it('returns filled slots with names resolved from the members table', async () => {
    const { status, body } = await get('/api/crimes/c1/slots')
    expect(status).toBe(200)
    // Empty slots are excluded (view shows participants), and user_name is
    // coalesced from members when the slot row lacks it.
    expect(body.slots).toEqual([
      { user_id: '300', user_name: 'Trout', position: 'Robber', position_number: 1, checkpoint_pass_rate: 82.5 },
      { user_id: '302', user_name: 'OldTimer', position: 'Thief #1', position_number: 4, checkpoint_pass_rate: 70 },
    ])
  })
})

describe('GET /api/members/roster', () => {
  it('returns the full member lookup including former members', async () => {
    const { status, body } = await get('/api/members/roster')
    expect(status).toBe(200)
    expect(body.roster).toEqual([
      { member_id: '300', member_name: 'Trout', tier: 3, tier_override: null, is_current: true },
      { member_id: '301', member_name: 'Salmon', tier: 5, tier_override: 2, is_current: true },
      { member_id: '302', member_name: 'OldTimer', tier: 6, tier_override: null, is_current: false },
    ])
  })
})

describe('GET /api/oc-config', () => {
  it('serves tier/CPR/payout policy from faction_settings', async () => {
    // The harness DB carries the seeded defaults (like a real new-faction
    // DB); pin the documents this test asserts against.
    await stack.db.query(`
      INSERT INTO faction_settings (key, value) VALUES
        ('tier_requirements', '{"1": [{"crime": "Break the Bank", "role": "Robber", "minCpr": 60}]}'),
        ('cpr_requirements', '{"Break the Bank": {"difficulty": 8, "positions": {"Robber": 60}}}'),
        ('payout_tickets', '{"1": 40, "2": 30}')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `)
    const { status, body } = await get('/api/oc-config')
    expect(status).toBe(200)
    expect(body.tier_requirements).toEqual({ '1': [{ crime: 'Break the Bank', role: 'Robber', minCpr: 60 }] })
    expect(body.cpr_requirements['Break the Bank'].positions.Robber).toBe(60)
    expect(body.payout_tickets).toEqual({ '1': 40, '2': 30 })
  })
})

describe('GET /api/crimes/current', () => {
  it('proxies the live Torn crimes board using the server-held key', async () => {
    stack.torn.setFactionCrimes({
      crimes: [{ id: 9001, name: 'Break the Bank', difficulty: 8, status: 'Recruiting', slots: [] }],
    })
    const { status, body } = await get('/api/crimes/current')
    expect(status).toBe(200)
    expect(body.crimes).toEqual([
      { id: 9001, name: 'Break the Bank', difficulty: 8, status: 'Recruiting', slots: [] },
    ])
    // The server must use its own configured key — the fixture records it.
    expect(stack.torn.lastFactionCrimesKey()).toBe('SERVERKEY1234567')
  })
})

describe('GET /api/oc-planner/data', () => {
  it('is forbidden for plain members — the planner is role-gated server-side', async () => {
    const { status } = await get('/api/oc-planner/data')
    expect(status).toBe(403)
  })

  it('gives ocmanagers the live board, roster and tier-3 CPR in one call', async () => {
    // Seed the fixture board here too — this test must not depend on ordering.
    stack.torn.setFactionCrimes({
      crimes: [{ id: 9001, name: 'Break the Bank', difficulty: 8, status: 'Recruiting', slots: [] }],
    })
    stack.torn.addKey('OCMANAGERKEY1234', { id: '310', factionId: TEST_FACTION.tornFactionId })
    await stack.db.query(`INSERT INTO role_assignments (torn_user_id, role) VALUES (310, 'ocmanager')`)
    await stack.db.query(`
      INSERT INTO member_cpr_v2 (member_id, crime_name, position_label, cpr_value) VALUES
        ('300', 'Break the Bank', 'Robber', 80),
        ('301', 'Break the Bank', 'Thief #1', 66)
    `)
    const login = await fetch(`${stack.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'OCMANAGERKEY1234' }),
    })
    const ocToken = ((await login.json()) as any).token

    const res = await fetch(`${stack.baseUrl}/api/oc-planner/data`, {
      headers: { authorization: `Bearer ${ocToken}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.live_crimes.crimes[0].id).toBe(9001)
    expect(body.roster.map((m: any) => m.member_id)).toEqual(['300', '301', '302'])
    // Only tier-3 members' CPR is included (planner's Advanced check).
    expect(body.t3_cpr).toEqual({ '300': { 'Break the Bank||Robber': 80 } })
  })
})
