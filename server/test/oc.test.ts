// OC read surface (slice #62), black-box at the HTTP seam.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'
import { ocModelFixture } from './ocModelFixture.js'

/**
 * The scenario model these tests run against (#606).
 *
 * ⚠️ Injected rather than asserted against `src/oc/model/`. Torn adds crimes and
 * revises flowcharts, so coupling the suite to the committed dataset would let
 * a routine model refresh break tests that have nothing to do with the change.
 *
 * The shapes here are the ones the assertions care about: a resolved ending, an
 * ending we could not map (with its reason), and a starved one (#473).
 */
const OC_MODEL = ocModelFixture([
  {
    name: 'Break the Bank',
    parameterCount: 6,
    observedPaths: 411,
    roles: [['P1', 'Robber', 20], ['P2', 'Muscle 1', 20]],
    endings: [
      { key: 'goodEnding1', nodeId: '_A8S_', kind: 'good', resolved: true },
      {
        key: 'goodEnding3', kind: 'good', resolved: false,
        problem: 'goodEnding3: ties between _A9S_ and _A10S_',
      },
      {
        key: 'goodEnding35', kind: 'good', resolved: false, starved: true,
        problem: 'no diagram counterpart — priced at $0 pending an upstream diagram fix',
      },
    ],
  },
  { name: 'Lock Stock', parameterCount: 5, isComplete: false, observedPaths: 126, roles: [['P1', 'Picklock', 50], ['P2', 'Muscle', 50]] },
  // ⚠️ Scenarios the later describe blocks used to INSERT mid-test. The model
  // is no longer per-tenant data, so it cannot be added to from inside an `it`
  // — every scenario a test needs must be declared here up front.
  { name: 'Honey Trap', parameterCount: 3 },        // mirrored, never completed
  { name: 'Painting Job', parameterCount: 3 },
  { name: 'Mystery Job', parameterCount: 3 },
  {
    name: 'Window Job',
    parameterCount: 4,
    endings: [
      { key: 'goodEnding1', nodeId: '_A8S_', kind: 'good', resolved: true },
      { key: 'goodEnding2', nodeId: '_C6S_', kind: 'good', resolved: true },
    ],
    // ⚠️ #606 slice 3: node stats moved OUT of oc_scenario_node_stats and into
    // the model. They were always tornprobability's global aggregates, so they
    // belong here rather than being INSERTed per tenant.
    //
    nodeStats: [
      {
        nodeId: '_A8S_', n: 3718,
        money: { min: 0, max: 0, avg: 0 },
        respect: { min: null, max: null, avg: 290 },
        items: [
          { name: 'Priceless Painting II', occurrences: 3718, qty: { min: 1, max: 1, avg: 1 } },
          { name: 'Shabti Sculpture II', occurrences: 1547, qty: { min: 2, max: 2, avg: 2 } },
        ],
      },
      {
        nodeId: '_C6S_', n: 100,
        money: { min: 0, max: 0, avg: 0 },
        respect: { min: null, max: null, avg: 200 },
        items: [{ name: 'Unrecorded Relic', occurrences: 100, qty: { min: 1, max: 1, avg: 1 } }],
      },
    ],
  },
])

let stack: TestStack
let token: string

beforeAll(async () => {
  stack = await startTestStack(undefined, {}, { ocModel: OC_MODEL })

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

  // #587: `null` is not a payout mode, and three consumers each guessed a
  // different meaning for it — the Payout Management page fell back to
  // flat-weighted while the tier UI stayed optimistically tiered. The server
  // now resolves the absent case once, so every consumer agrees.
  it('resolves an unset payout_mode to the equal default (#587)', async () => {
    await stack.db.query(`DELETE FROM faction_settings WHERE key = 'payout_mode'`)
    const { status, body } = await get('/api/oc-config')
    expect(status).toBe(200)
    expect(body.payout_mode).toBe('equal')
  })

  it('prefers a saved payout_mode over the default (#587)', async () => {
    await stack.db.query(
      `INSERT INTO faction_settings (key, value) VALUES ('payout_mode', '"tiered"')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
    )
    const { status, body } = await get('/api/oc-config')
    expect(status).toBe(200)
    expect(body.payout_mode).toBe('tiered')
    await stack.db.query(`DELETE FROM faction_settings WHERE key = 'payout_mode'`)
  })

  // Reading policy has never been role-gated (`requireAuth` only) — pinned here
  // because #587 was first reported as "maybe only admins can read the
  // setting, and that's why it comes back empty". The harness token belongs to
  // member 300, who holds no role assignment at all, so a pass here is proof
  // the plain-member read sees the same value a leader does.
  it('serves the saved mode to a member with no roles, not just admins (#587)', async () => {
    await stack.db.query(
      `INSERT INTO faction_settings (key, value) VALUES ('payout_mode', '"flat-weighted"')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
    )
    const { status, body } = await get('/api/oc-config')
    expect(status).toBe(200)
    expect(body.payout_mode).toBe('flat-weighted')
    // Leave the shared harness DB as this describe found it.
    await stack.db.query(`DELETE FROM faction_settings WHERE key = 'payout_mode'`)
  })

  // A value that is not one of the three modes must not reach the client: the
  // frontend rejects anything outside PAYOUT_MODES and falls back silently,
  // which is the exact failure #587 was about.
  it('falls back to the default when the stored value is not a mode (#587)', async () => {
    await stack.db.query(
      `INSERT INTO faction_settings (key, value) VALUES ('payout_mode', '"nonsense"')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
    )
    const { status, body } = await get('/api/oc-config')
    expect(status).toBe(200)
    expect(body.payout_mode).toBe('equal')
    await stack.db.query(`DELETE FROM faction_settings WHERE key = 'payout_mode'`)
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

    // ⚠️ #606 slice 3: nothing to seed. Structure, roles, endings,
    // observed_paths and node stats ALL come from OC_MODEL now — the mirror
    // tables this used to INSERT into are dropped by migration 0060.
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

  it('carries starved endings distinctly from merely unresolved ones (#473)', async () => {
    const { body } = await simGet('/api/oc-simulator/scenarios')
    const btb = body.scenarios.find((s: any) => s.name === 'Break the Bank')
    const starved = btb.endings.find((e: any) => e.ending_key === 'goodEnding35')
    expect(starved.starved).toBe(true)
    expect(starved.resolved).toBe(false)
    expect(starved.node_id).toBeNull()
    expect(starved.problem).toMatch(/no diagram counterpart/)
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

// #728 — the faction's own history, beside the model's prediction.
describe('GET /api/oc-simulator/observed/:scenario', () => {
  let obsToken: string

  beforeAll(async () => {
    const login = await fetch(`${stack.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'SIMMANAGERKEY123' }),
    })
    obsToken = ((await login.json()) as any).token

    const now = Math.floor(Date.now() / 1000)
    // 20 runs with a weak crew that mostly fail, 20 with a strong crew that
    // mostly succeed — the shape the whole feature exists to detect.
    for (let i = 0; i < 40; i++) {
      const strong = i >= 20
      // weak crew: 6 of 20 succeed. strong crew: 18 of 20.
      const ok = strong ? i < 38 : i < 6
      const id = `obs-${i}`
      await stack.db.query(
        `INSERT INTO crimes (crime_id, name, difficulty, status, executed_at)
         VALUES ($1, 'Observed Crime', 8, $2, $3) ON CONFLICT DO NOTHING`,
        [id, ok ? 'Successful' : 'Failure', now - 86400 * (i + 1)]
      )
      await stack.db.query(
        `INSERT INTO crime_slots (crime_id, position, position_id, checkpoint_pass_rate)
         VALUES ($1, 'Robber', 'P1', $2), ($1, 'Muscle #1', 'P2', $3)
         ON CONFLICT DO NOTHING`,
        [id, strong ? 82 : 60, strong ? 80 : 62]
      )
    }
  })

  const obsGet = async (path: string) => {
    const res = await fetch(`${stack.baseUrl}${path}`, { headers: { authorization: `Bearer ${obsToken}` } })
    return { status: res.status, body: (await res.json()) as any }
  }

  it('summarises the faction\'s own runs by the crew that ran them', async () => {
    const { status, body } = await obsGet('/api/oc-simulator/observed/Observed%20Crime')
    expect(status).toBe(200)
    expect(body.runs).toBe(40)          // ⚠️ runs, not the 80 slots
    expect(body.enough).toBe(true)
    expect(body.buckets.length).toBeGreaterThan(1)
    const [lo, hi] = [body.buckets[0], body.buckets[body.buckets.length - 1]]
    expect(lo.meanCpr).toBeLessThan(hi.meanCpr)
    expect(lo.rate).toBeLessThan(hi.rate)
  })

  it('⚠️ reports a crime with no history as absent, not as a zero success rate', async () => {
    const { status, body } = await obsGet('/api/oc-simulator/observed/Never%20Run')
    expect(status).toBe(200)
    expect(body.runs).toBe(0)
    expect(body.enough).toBe(false)
    expect(body.rate).toBeNull()
    expect(body.buckets).toEqual([])
  })

  it('honours a shorter window', async () => {
    const { body } = await obsGet('/api/oc-simulator/observed/Observed%20Crime?days=10')
    expect(body.window_days).toBe(10)
    expect(body.runs).toBeLessThan(40)
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

// #448 — item rewards, valued from our own completed runs.
describe('item reward value on the scenarios payload', () => {
  let simToken2: string

  beforeAll(async () => {
    const login = await fetch(`${stack.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'SIMMANAGERKEY123' }),
    })
    simToken2 = ((await login.json()) as any).token

    await stack.db.query(`
      INSERT INTO items (id, name, market_price, sell_price) VALUES
        (500, 'Fancy Car', 40000000, 1000000),
        -- ⚠️ An illiquid item: never trades, so market_price is 0 while
        -- sell_price carries its real worth. Pricing on market alone would
        -- value this at nothing.
        (501, 'Priceless Painting', 0, 70000000),
        -- Absent from the catalogue entirely: unpriceable, and counted.
        (502, 'Mystery Thing', 0, 0)
      ON CONFLICT (id) DO UPDATE SET
        market_price = EXCLUDED.market_price, sell_price = EXCLUDED.sell_price
    `)
    // Four successful runs of Lock Stock; only two dropped items.
    await stack.db.query(`
      INSERT INTO crimes (crime_id, name, difficulty, status, created_at, executed_at) VALUES
        ('lk1', 'Lock Stock', 5, 'Successful', 1700000000, 1700100000),
        ('lk2', 'Lock Stock', 5, 'Successful', 1700200000, 1700300000),
        ('lk3', 'Lock Stock', 5, 'Successful', 1700400000, 1700500000),
        ('lk4', 'Lock Stock', 5, 'Successful', 1700600000, 1700700000)
    `)
    await stack.db.query(`
      INSERT INTO crime_reward_items (crime_id, item_id, item_name, quantity, unit_value, total_value) VALUES
        ('lk1', '500', 'Fancy Car', 1, 1000, 1000),
        ('lk2', '500', 'Fancy Car', 1, 1000, 1000)
    `)
    // A mirrored crime we have never completed, for the "no history" case.
  })

  const get2 = async (path: string) => {
    const res = await fetch(`${stack.baseUrl}${path}`, { headers: { authorization: `Bearer ${simToken2}` } })
    return { status: res.status, body: (await res.json()) as any }
  }

  it('averages over EVERY successful run, not only the ones that dropped items', async () => {
    // ⚠️ 2 drops worth $40M each across 4 runs is $20M a run, not $40M.
    // Averaging only over runs with item rows would double the reward of a
    // crime that drops items occasionally.
    const { body } = await get2('/api/oc-simulator/scenarios')
    const lock = body.scenarios.find((s: any) => s.name === 'Lock Stock')
    expect(lock.item_reward.runs).toBe(4)
    expect(Number(lock.item_reward.avg_value)).toBe(20_000_000)
  })

  it('⚠️ prices an illiquid item on sell_price when market_price is 0', async () => {
    // A Priceless Painting rarely trades, so market_price is 0 while
    // sell_price holds its real worth. Pricing on market alone would value the
    // rarest, most expensive drops at nothing — the opposite of the error worth
    // risking. Payout Management has used max(sell, market) for exactly this.
    await stack.db.query(`
      INSERT INTO crimes (crime_id, name, difficulty, status, created_at) VALUES
        ('pp1', 'Painting Job', 6, 'Successful', 1700000000)
      ON CONFLICT DO NOTHING
    `)
    await stack.db.query(`
      INSERT INTO crime_reward_items (crime_id, item_id, item_name, quantity, unit_value, total_value)
      VALUES ('pp1', '501', 'Priceless Painting', 1, 5, 5)
    `)
    const { body } = await get2('/api/oc-simulator/scenarios')
    const job = body.scenarios.find((s: any) => s.name === 'Painting Job')
    expect(Number(job.item_reward.avg_value)).toBe(70_000_000)
  })

  it('counts an item it cannot price at all, rather than using a stale value', async () => {
    // ⚠️ The row carries a unit_value stored when the crime ran. Falling back
    // to it would present a stale number as a current one, which is the whole
    // thing this feature exists to avoid. It contributes 0 and is counted so
    // the UI can say the estimate is short.
    await stack.db.query(`
      INSERT INTO crimes (crime_id, name, difficulty, status, created_at) VALUES
        ('my1', 'Mystery Job', 6, 'Successful', 1700000000)
      ON CONFLICT DO NOTHING
    `)
    await stack.db.query(`
      INSERT INTO crime_reward_items (crime_id, item_id, item_name, quantity, unit_value, total_value)
      VALUES ('my1', '502', 'Mystery Thing', 1, 999999, 999999)
    `)
    const { body } = await get2('/api/oc-simulator/scenarios')
    const job = body.scenarios.find((s: any) => s.name === 'Mystery Job')
    expect(Number(job.item_reward.avg_value)).toBe(0)
    expect(job.item_reward.unpriced_rows).toBe(1)
  })

  it('prices at CURRENT market, not the value stored at the time', async () => {
    // Payout Management deliberately keeps the stored snapshot — a saved week
    // is a record. This is a forecast, so it uses what the item is worth now:
    // $40,000,000 today against unit_value 1000 stored on the row.
    const { body } = await get2('/api/oc-simulator/scenarios')
    const lock = body.scenarios.find((s: any) => s.name === 'Lock Stock')
    expect(Number(lock.item_reward.avg_value)).toBeGreaterThan(1_000_000)
  })

  // #585 — the chain edges Torn has been telling us about all along.
  it('⚠️ derives chain edges from previous_crime_id, which nothing has ever read', async () => {
    // Verified across the fleet: every successful parent spawns exactly one
    // child and no failed or expired one ever does. That determinism is why the
    // client can treat an edge as fact rather than a probability to model.
    await stack.db.query(`
      INSERT INTO crimes (crime_id, name, difficulty, status, created_at, previous_crime_id) VALUES
        ('mc1', 'Manifest Cruelty', 8, 'Successful', 1700000000, NULL),
        ('gf1', 'Gone Fission',     9, 'Successful', 1700000100, 'mc1'),
        ('cr1', 'Crane Reaction',  10, 'Successful', 1700000200, 'gf1')
      ON CONFLICT DO NOTHING
    `)
    const { body } = await get2('/api/oc-simulator/scenarios')
    const edges = new Map(
      (body.chains as any[]).map((c) => [`${c.parent}->${c.child}`, c.observations])
    )
    expect(edges.get('Manifest Cruelty->Gone Fission')).toBe(1)
    expect(edges.get('Gone Fission->Crane Reaction')).toBe(1)
  })

  it('does not invent an edge for a crime that spawned nothing', async () => {
    // A crime with no previous_crime_id pointing at it is not a chain parent,
    // and a phantom edge would silently attribute somebody else's payout to it.
    const { body } = await get2('/api/oc-simulator/scenarios')
    expect((body.chains as any[]).some((c) => c.parent === 'Honey Trap')).toBe(false)
  })

  it('reports null, not zero, for a crime we have never completed', async () => {
    // ⚠️ "No history" must not read as "drops nothing" — that would rank the
    // crime we know least about as the worst.
    const { body } = await get2('/api/oc-simulator/scenarios')
    const never = body.scenarios.find((s: any) => s.name === 'Honey Trap')
    expect(never.item_reward).toBeNull()
    expect(never.spawn_history).toBeNull()
  })

  it('distinguishes "ran it, dropped nothing" from "never ran it"', async () => {
    // ⚠️ Break the Bank has one successful run that dropped no items, so an
    // average of 0 is a real — if thin — measurement. Honey Trap has no runs at
    // all. Both would render as "0" without the run count travelling alongside.
    const { body } = await get2('/api/oc-simulator/scenarios')
    const observed = body.scenarios.find((s: any) => s.name === 'Break the Bank')
    expect(observed.item_reward).not.toBeNull()
    expect(Number(observed.item_reward.avg_value)).toBe(0)
    expect(observed.item_reward.runs).toBe(1)
  })

  it('carries spawn history so a rate can be measured rather than modelled', async () => {
    const { body } = await get2('/api/oc-simulator/scenarios')
    const lock = body.scenarios.find((s: any) => s.name === 'Lock Stock')
    expect(lock.spawn_history.runs).toBe(4)
    expect(lock.spawn_history.first_at).toBe(1700000000)
  })
})

// #441 follow-up — item drops the MIRROR observed for a specific ending
// (unlike #448's item_reward above, which averages OUR OWN completed runs
// with no ending attribution). This is what turns Window of Opportunity's
// $0-money good endings into a real E(x).
describe('ending item value on the scenarios payload (#441 follow-up)', () => {
  let itemSimToken: string

  beforeAll(async () => {
    const login = await fetch(`${stack.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'SIMMANAGERKEY123' }),
    })
    itemSimToken = ((await login.json()) as any).token

    await stack.db.query(`
      INSERT INTO items (id, name, market_price, sell_price) VALUES
        (600, 'Priceless Painting II', 0, 70000000),
        (601, 'Shabti Sculpture II', 500000, 400000),
        (602, 'Unrecorded Relic', 0, 0)
      ON CONFLICT (id) DO UPDATE SET
        market_price = EXCLUDED.market_price, sell_price = EXCLUDED.sell_price
    `)
  })

  const getItems = async (path: string) => {
    const res = await fetch(`${stack.baseUrl}${path}`, { headers: { authorization: `Bearer ${itemSimToken}` } })
    return { status: res.status, body: (await res.json()) as any }
  }

  it("prices an ending's observed item drops instead of leaving it at $0", async () => {
    const { body } = await getItems('/api/oc-simulator/scenarios')
    const scenario = body.scenarios.find((s: any) => s.name === 'Window Job')
    const ending = scenario.endings.find((e: any) => e.ending_key === 'goodEnding1')
    // Painting: 3718/3718 * 1 * 70,000,000 = 70,000,000
    // Shabti:   1547/3718 * 2 * 500,000 (market beats sell here)
    expect(Number(ending.item_value_avg)).toBeCloseTo(70_000_000 + (1547 / 3718) * 2 * 500_000, 0)
    expect(Number(ending.money_avg)).toBe(0)
  })

  it('reports an item it could not price as unmatched, contributing 0', async () => {
    const { body } = await getItems('/api/oc-simulator/scenarios')
    const scenario = body.scenarios.find((s: any) => s.name === 'Window Job')
    const ending = scenario.endings.find((e: any) => e.ending_key === 'goodEnding2')
    expect(Number(ending.item_value_avg)).toBe(0)
    expect(ending.item_value_unmatched).toEqual(['Unrecorded Relic'])
  })

  it('does not leak the raw items array onto the response', async () => {
    // Internal plumbing only — the client works off item_value_avg.
    const { body } = await getItems('/api/oc-simulator/scenarios')
    const scenario = body.scenarios.find((s: any) => s.name === 'Window Job')
    const ending = scenario.endings.find((e: any) => e.ending_key === 'goodEnding1')
    expect(ending.items).toBeUndefined()
  })

  it('is null, not 0, for an ending with no node stats at all', async () => {
    const { body } = await getItems('/api/oc-simulator/scenarios')
    const btb = body.scenarios.find((s: any) => s.name === 'Break the Bank')
    const unpriced = btb.endings.find((e: any) => e.ending_key === 'goodEnding1')
    expect(unpriced.item_value_avg).toBeNull()
  })
})

// #444 — success chance for every crime at one CPR.
describe('GET /api/oc-simulator/ranking', () => {
  let rankToken: string

  beforeAll(async () => {
    const login = await fetch(`${stack.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'SIMMANAGERKEY123' }),
    })
    rankToken = ((await login.json()) as any).token
  })

  const rank = async (qs: string) => {
    const res = await fetch(`${stack.baseUrl}/api/oc-simulator/ranking${qs}`, {
      headers: { authorization: `Bearer ${rankToken}` },
    })
    return { status: res.status, body: (await res.json()) as any }
  }

  it('rejects a CPR outside 0–100 or missing', async () => {
    expect((await rank('?cpr=101')).status).toBe(400)
    expect((await rank('?cpr=-1')).status).toBe(400)
    expect((await rank('')).status).toBe(400)
  })

  it('is gated like the rest of the simulator', async () => {
    const res = await fetch(`${stack.baseUrl}/api/oc-simulator/ranking?cpr=75`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(403)
  })

  it('marks a crime whose role count disagrees as unrankable, not ranked on a guess', async () => {
    // ⚠️ 'Lock Stock' is mirrored with parameter_count 5 but has no roles, so
    // no defensible CPR vector exists. It must be reported, not given a number.
    const { status, body } = await rank('?cpr=75')
    expect(status).toBe(200)
    const lock = body.crimes.find((c: any) => c.name === 'Lock Stock')
    expect(lock.success).toBeNull()
    expect(lock.error).toMatch(/role count/)
  })
})

describe('⚠️ a faction with no mirror rows still gets the whole model (#606)', () => {
  // THE bug this change removes. `oc-scenarios-mirror` only populated the
  // per-tenant tables where somebody had enabled the job, so on 2026-09-06
  // three of five live tenants held ZERO scenarios and their Simulator was
  // silently empty — an empty table looks exactly like a crime with no data.
  //
  // Scenario structure is Torn game data, identical for every faction, so it
  // now ships in the image where it cannot be present on some tenants and
  // absent on others.
  //
  // ⚠️ Reuses the existing stack rather than booting a
  // second one. A first draft started another embedded Postgres and flaked
  // admin-incident-store.test.ts by pushing concurrent instances past what the
  // runner has — a test that breaks an unrelated suite is not worth the
  // isolation. Rows are restored afterwards so ordering stays irrelevant.
  let token = ''

  const simGet = async (path: string) => {
    const res = await fetch(`${stack.baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } })
    return { status: res.status, body: (await res.json()) as any }
  }

  beforeAll(async () => {
    // The ocmanager key seeded by the earlier block; logging in again is
    // cheaper than another role grant.
    const login = await fetch(`${stack.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'SIMMANAGERKEY123' }),
    })
    token = ((await login.json()) as any).token
  })

  it('⚠️ #606: serves every scenario with NO per-tenant OC data at all', async () => {
    // This used to empty `oc_scenarios` first and assert the model still came
    // through. Since slice 3 that table does not exist — so the property is
    // now true by construction rather than by arrangement, which is the whole
    // point of the migration: the mirror ran only where somebody enabled the
    // job, and on 2026-09-06 three of five live tenants held ZERO scenarios
    // and their Simulator was silently empty.
    const gone = await stack.db.query(
      `SELECT count(*)::int AS n FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'oc_scenarios'`
    )
    expect(gone.rows[0].n).toBe(0)

    const { status, body } = await simGet('/api/oc-simulator/scenarios')
    expect(status).toBe(200)
    expect(body.scenarios.map((s: any) => s.name)).toContain('Break the Bank')
    expect(body.scenarios.length).toBe(OC_MODEL.size)
  })

  it('carries roles, endings and the global path count from the model', async () => {
    const { body } = await simGet('/api/oc-simulator/scenarios')
    const btb = body.scenarios.find((s: any) => s.name === 'Break the Bank')
    expect(btb.roles.map((r: any) => r.role_name)).toEqual(['Robber', 'Muscle 1'])
    expect(btb.endings.length).toBe(3)
    // ⚠️ #606 slice 3 moved this. It used to be null here, and the comment said
    // that was correct because "with no rows there are no observations to
    // derive it from" — but `observed_paths` was never ours to derive. Despite
    // the name it is how many paths TORNPROBABILITY observed, written by the
    // mirror straight from their feed, so it is global game data and now ships
    // in the image. Leaving it per-tenant would have meant a number with no
    // writer, stuck at whatever the last mirror run happened to leave.
    expect(btb.observed_paths).toBe(411)
  })

  it('⚠️ reports NO ending-map quality, because this tenant has run no probe sweep', async () => {
    // The genuinely per-tenant half. `ending_map_*` IS ours — measured by the
    // maintainer probe sweep against a tenant's own data — so it stays in the
    // tenant database (`oc_scenario_quality`) and is absent until measured.
    // null, never 0: reporting zero would state a measurement never made
    // (#351, #441).
    const { body } = await simGet('/api/oc-simulator/scenarios')
    const btb = body.scenarios.find((s: any) => s.name === 'Break the Bank')
    expect(btb.ending_map_residual).toBeNull()
    expect(btb.ending_map_confident).toBeNull()
  })

  it('answers the roster lookup, which also reads the model', async () => {
    // roster-cpr/:scenario used to 404 with "no mirrored roles for X" on a
    // tenant whose mirror had never run — a per-faction gap in data that cannot
    // differ between factions.
    expect((await simGet('/api/oc-simulator/roster-cpr/Break%20the%20Bank')).status).toBe(200)
  })

  it('⚠️ still 404s for a scenario that genuinely does not exist', async () => {
    expect((await simGet('/api/oc-simulator/roster-cpr/Not%20A%20Crime')).status).toBe(404)
  })
})
