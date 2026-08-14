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
  it('proxies the live Torn crimes board using a pooled key', async () => {
    stack.torn.setFactionCrimes({
      crimes: [{ id: 9001, name: 'Break the Bank', difficulty: 8, status: 'Recruiting', slots: [] }],
    })
    const { status, body } = await get('/api/crimes/current')
    expect(status).toBe(200)
    expect(body.crimes).toEqual([
      { id: 9001, name: 'Break the Bank', difficulty: 8, status: 'Recruiting', slots: [] },
    ])
    // The server claims from the consented key pool (#98) — member 300's
    // login in beforeAll enrolled their key; TORN_API_KEY no longer exists.
    expect(stack.torn.lastFactionCrimesKey()).toBe('MEMBERKEY1234567')
  })

  it('an empty pool tells the operator how to fix it', async () => {
    await stack.db.query(`UPDATE member_secrets SET disabled = true`)
    const { status, body } = await get('/api/crimes/current')
    expect(status).toBe(503)
    expect(body.error).toMatch(/log in|members-sync/i)
    await stack.db.query(`UPDATE member_secrets SET disabled = false`)
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
    // '310' is the ocmanager's own stub roster row, created by their login
    // (fresh-faction bootstrap: roster-missing member logins stub the roster).
    expect(body.roster.map((m: any) => m.member_id)).toEqual(['300', '301', '302', '310'])
    // Only tier-3 members' CPR is included (planner's Advanced check).
    expect(body.t3_cpr).toEqual({ '300': { 'Break the Bank||Robber': 80 } })
  })
})

// OC Simulator (#390). The simulator reads our MIRROR, so these tests seed the
// mirror tables directly — the mirror job itself is covered in
// oc-scenarios-mirror.test.ts.
describe('OC Simulator endpoints', () => {
  let ocToken: string

  beforeAll(async () => {
    stack.torn.addKey('SIMMANAGERKEY123', { id: '320', factionId: TEST_FACTION.tornFactionId })
    await stack.db.query(`INSERT INTO role_assignments (torn_user_id, role) VALUES (320, 'ocmanager')`)
    const login = await fetch(`${stack.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'SIMMANAGERKEY123' }),
    })
    ocToken = ((await login.json()) as any).token

    await stack.db.query(`
      INSERT INTO oc_scenarios (name, parameter_count, is_complete, observed_paths, diagram_valid)
      VALUES ('Break the Bank', 6, true, 411, true),
             ('Lock Stock', 5, false, 126, true)
    `)
    await stack.db.query(`
      INSERT INTO oc_scenario_roles (scenario_name, position_id, role_name, weight) VALUES
        ('Break the Bank', 'P1', 'Robber', 20),
        ('Break the Bank', 'P2', 'Muscle 1', 20)
    `)
    await stack.db.query(`
      INSERT INTO oc_scenario_endings (scenario_name, ending_key, node_id, kind, resolved, problem) VALUES
        ('Break the Bank', 'goodEnding1', '_A8S_', 'good', true, NULL),
        ('Break the Bank', 'goodEnding3', NULL, 'good', false, 'goodEnding3: ties between _A9S_ and _A10S_')
    `)
  })

  const simGet = async (path: string) => {
    const res = await fetch(`${stack.baseUrl}${path}`, { headers: { authorization: `Bearer ${ocToken}` } })
    return { status: res.status, body: (await res.json()) as any }
  }
  const simPost = async (path: string, payload: unknown, tok = ocToken) => {
    const res = await fetch(`${stack.baseUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return { status: res.status, body: (await res.json()) as any }
  }

  it('is gated — a plain member gets 403 on both routes', async () => {
    // MonChoon: the simulator is for OC managers, leadership and admin.
    expect((await get('/api/oc-simulator/scenarios')).status).toBe(403)
    const res = await fetch(`${stack.baseUrl}/api/oc-simulator/calculate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ scenario: 'Break the Bank', parameters: [1, 1, 1, 1, 1, 1] }),
    })
    expect(res.status).toBe(403)
  })

  it('serves the mirrored scenarios with roles and endings', async () => {
    const { status, body } = await simGet('/api/oc-simulator/scenarios')
    expect(status).toBe(200)
    const btb = body.scenarios.find((s: any) => s.name === 'Break the Bank')
    expect(btb.parameter_count).toBe(6)
    expect(btb.roles.map((r: any) => r.role_name)).toEqual(['Robber', 'Muscle 1'])
  })

  it('carries completeness, which the upstream API does not', async () => {
    // ⚠️ Lock Stock answers with numbers that look exactly as authoritative as
    // a finished model. The page has to be able to say otherwise.
    const { body } = await simGet('/api/oc-simulator/scenarios')
    const lock = body.scenarios.find((s: any) => s.name === 'Lock Stock')
    expect(lock.is_complete).toBe(false)
    expect(lock.observed_paths).toBe(126)
  })

  it('carries UNRESOLVED endings with their reason, not just the resolved ones', async () => {
    // Dropping them would make "we could not work this out" indistinguishable
    // from "this ending does not exist".
    const { body } = await simGet('/api/oc-simulator/scenarios')
    const btb = body.scenarios.find((s: any) => s.name === 'Break the Bank')
    const unresolved = btb.endings.find((e: any) => e.ending_key === 'goodEnding3')
    expect(unresolved.resolved).toBe(false)
    expect(unresolved.node_id).toBeNull()
    expect(unresolved.problem).toMatch(/ties between/)
  })

  it('rejects a CPR vector of the wrong length for that crime', async () => {
    // ⚠️ The upstream service answers a wrong-length vector with perfectly
    // ordinary numbers — for a crime nobody is running.
    const { status, body } = await simPost('/api/oc-simulator/calculate', {
      scenario: 'Break the Bank', parameters: [99, 99, 99],
    })
    expect(status).toBe(400)
    expect(body.error).toMatch(/takes 6 roles, got 3/)
  })

  it('rejects CPRs outside 0–100 and missing input', async () => {
    expect((await simPost('/api/oc-simulator/calculate', {
      scenario: 'Break the Bank', parameters: [99, 99, 99, 99, 99, 900],
    })).status).toBe(400)
    expect((await simPost('/api/oc-simulator/calculate', { scenario: 'Break the Bank' })).status).toBe(400)
    expect((await simPost('/api/oc-simulator/calculate', { parameters: [1] })).status).toBe(400)
  })

  it('404s a scenario we have not mirrored, rather than forwarding it', async () => {
    const { status } = await simPost('/api/oc-simulator/calculate', {
      scenario: 'Not A Real Crime', parameters: [99],
    })
    expect(status).toBe(404)
  })
})

// #442 — who on our roster can fill each role.
describe('GET /api/oc-simulator/roster-cpr/:scenario', () => {
  let simToken: string

  beforeAll(async () => {
    const login = await fetch(`${stack.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'SIMMANAGERKEY123' }),
    })
    simToken = ((await login.json()) as any).token

    // oc_crime_positions.crime_name is FK'd to oc_crime_types.
    await stack.db.query(
      `INSERT INTO oc_crime_types (name, difficulty) VALUES ('Break the Bank', 8)
       ON CONFLICT DO NOTHING`
    )
    await stack.db.query(`
      INSERT INTO oc_crime_positions (crime_name, position_label, position_id) VALUES
        ('Break the Bank', 'Robber', 'P1'),
        ('Break the Bank', 'Muscle #1', 'P2')
      ON CONFLICT DO NOTHING
    `)
    await stack.db.query(`
      INSERT INTO member_cpr_v2 (member_id, crime_name, position_label, cpr_value) VALUES
        ('300', 'Break the Bank', 'Robber', 91),
        ('301', 'Break the Bank', 'Robber', 64),
        ('302', 'Break the Bank', 'Robber', 88)
      ON CONFLICT (member_id, crime_name, position_label) DO UPDATE SET cpr_value = EXCLUDED.cpr_value
    `)
  })

  const rosterGet = async (path: string) => {
    const res = await fetch(`${stack.baseUrl}${path}`, { headers: { authorization: `Bearer ${simToken}` } })
    return { status: res.status, body: (await res.json()) as any }
  }

  it('joins CPR readings to the mirrored role across the "#" spelling', async () => {
    const { status, body } = await rosterGet('/api/oc-simulator/roster-cpr/Break%20the%20Bank')
    expect(status).toBe(200)
    // 'Muscle 1' upstream vs 'Muscle #1' in Torn's payload.
    expect(body.unmatched_roles).toEqual([])
    // Highest first, and 302's reading of 88 is absent — they are a leaver,
    // which the next test pins explicitly.
    expect(body.readings.P1.map((r: any) => r.cpr)).toEqual([91, 64])
  })

  it('excludes members who have left the faction', async () => {
    // '302' is is_current = false in the fixture roster — their CPR is not
    // capacity we have, and counting it would overstate every headcount.
    const { body } = await rosterGet('/api/oc-simulator/roster-cpr/Break%20the%20Bank')
    expect(body.readings.P1.map((r: any) => r.member_id)).not.toContain('302')
  })

  it('returns an empty list for a role nobody has been observed in', async () => {
    const { body } = await rosterGet('/api/oc-simulator/roster-cpr/Break%20the%20Bank')
    expect(body.readings.P2).toEqual([])
  })

  it('404s a scenario with no mirrored roles', async () => {
    const { status } = await rosterGet('/api/oc-simulator/roster-cpr/Not%20A%20Crime')
    expect(status).toBe(404)
  })

  it('is gated to the same roles as the rest of the simulator', async () => {
    const res = await fetch(`${stack.baseUrl}/api/oc-simulator/roster-cpr/Break%20the%20Bank`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(403)
  })
})
