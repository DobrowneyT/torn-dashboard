// Ranked-war read surface (slice #64): war history, contributions, windowed
// attacks (paginated), revives, and saved war-payout history — black-box at
// the HTTP seam against a real templated Postgres.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'

let stack: TestStack
const tokens: Record<string, string> = {}

// War under test: a finished termed war with a bounded window.
const WAR_START = 1748000000
const WAR_END = WAR_START + 259200 // 3 days

async function loginAs(name: string, id: string, roles: string[]) {
  const key = `${name.toUpperCase().padEnd(13, 'K')}${id.slice(0, 3)}`
  stack.torn.addKey(key, { id, factionId: TEST_FACTION.tornFactionId })
  for (const role of roles) {
    await stack.db.query('INSERT INTO role_assignments (torn_user_id, role) VALUES ($1, $2)', [id, role])
  }
  const res = await fetch(`${stack.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey: key }),
  })
  expect(res.status).toBe(200)
  tokens[name] = ((await res.json()) as any).token
}

async function get(path: string, as = 'member') {
  const res = await fetch(`${stack.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${tokens[as]}` },
  })
  return { status: res.status, body: (await res.json()) as any }
}

async function post(path: string, payload: unknown, as = 'leader') {
  const res = await fetch(`${stack.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[as]}` },
    body: JSON.stringify(payload),
  })
  return { status: res.status, body: (await res.json()) as any }
}

beforeAll(async () => {
  stack = await startTestStack()
  await loginAs('member', '500', [])
  await loginAs('leader', '600', ['leadership'])
  await loginAs('visitor', '601', ['visitor'])

  // Three wars, newest first by start_at: 300 (ongoing), 200 (war under
  // test), 100 (oldest).
  await stack.db.query(`
    INSERT INTO ranked_wars (id, start_at, end_at, opponent_id, opponent_name, our_score, opponent_score, winner_faction_id, is_termed) VALUES
      (100, ${WAR_START - 900000}, ${WAR_START - 800000}, 9001, 'Old Rivals',   1000, 900, ${TEST_FACTION.tornFactionId}, false),
      (200, ${WAR_START},          ${WAR_END},            9002, 'Test Dummies', 2500, 1200, ${TEST_FACTION.tornFactionId}, true),
      (300, ${WAR_END + 100000},   NULL,                  9003, 'Fresh Meat',   50,   40, NULL, true)
  `)
}, 30000)

afterAll(async () => {
  await stack?.close()
})

describe('GET /api/wars', () => {
  it('pages wars newest-first and reports the total for pagination', async () => {
    const { status, body } = await get('/api/wars?limit=2&offset=0')
    expect(status).toBe(200)
    expect(body.wars.map((w: any) => w.id)).toEqual([300, 200])
    expect(body.total).toBe(3)

    const page2 = await get('/api/wars?limit=2&offset=2')
    expect(page2.body.wars.map((w: any) => w.id)).toEqual([100])
    expect(page2.body.total).toBe(3)
  })
})

describe('GET /api/wars/:id', () => {
  it('returns the single war, 404 when unknown', async () => {
    const { status, body } = await get('/api/wars/200')
    expect(status).toBe(200)
    expect(body.war.opponent_name).toBe('Test Dummies')
    expect(body.war.our_score).toBe(2500)

    const missing = await get('/api/wars/999999')
    expect(missing.status).toBe(404)
  })
})

describe('GET /api/wars/:id/contributions', () => {
  it('returns reported contributions for both factions ordered by score', async () => {
    await stack.db.query(`
      INSERT INTO war_member_contributions (war_id, member_id, member_name, level, attacks, score, faction_id) VALUES
        (200, 500, 'Member',   40, 30, 410.25, ${TEST_FACTION.tornFactionId}),
        (200, 501, 'Slacker',  22,  1,  12.50, ${TEST_FACTION.tornFactionId}),
        (200, 900, 'EnemyTop', 60, 44, 380.00, 9002),
        (100, 500, 'Member',   40, 10, 100.00, ${TEST_FACTION.tornFactionId})
    `)
    const { status, body } = await get('/api/wars/200/contributions')
    expect(status).toBe(200)
    expect(body.contributions.map((c: any) => c.member_name)).toEqual(['Member', 'EnemyTop', 'Slacker'])
    expect(body.contributions[0].score).toBe(410.25)
    expect(body.contributions[0].faction_id).toBe(Number(TEST_FACTION.tornFactionId))
  })
})

describe('GET /api/attacks (windowed, paginated)', () => {
  beforeAll(async () => {
    // Four attacks inside the war window, one before, one after. The window
    // filter is started >= from AND started <= to (legacy loader semantics).
    await stack.db.query(`
      INSERT INTO faction_attacks (attack_id, started, attacker_id, attacker_name, attacker_faction_id,
                                   defender_id, result, respect_gain, chain, is_ranked_war, is_incoming) VALUES
        (1, ${WAR_START - 100},  500, 'Member',  ${TEST_FACTION.tornFactionId}, 900, 'Attacked',  5.0,  1, false, false),
        (2, ${WAR_START + 10},   500, 'Member',  ${TEST_FACTION.tornFactionId}, 900, 'Attacked', 12.5,  2, true,  false),
        (3, ${WAR_START + 20},   501, 'Slacker', ${TEST_FACTION.tornFactionId}, 901, 'Lost',      0.0,  0, true,  false),
        (4, ${WAR_START + 30},   900, 'EnemyTop', 9002, 500, 'Attacked', 8.0, 0, true, true),
        (5, ${WAR_END - 10},     500, 'Member',  ${TEST_FACTION.tornFactionId}, 902, 'Mugged',    3.25, 0, true,  false),
        (6, ${WAR_END + 100},    500, 'Member',  ${TEST_FACTION.tornFactionId}, 903, 'Attacked',  6.0,  0, false, false)
    `)
  })

  it('pages attacks within [from, to] newest-first and reports the window total', async () => {
    const { status, body } = await get(`/api/attacks?from=${WAR_START}&to=${WAR_END}&limit=3&offset=0`)
    expect(status).toBe(200)
    expect(body.total).toBe(4)
    expect(body.attacks.map((a: any) => a.attack_id)).toEqual([5, 4, 3])

    const page2 = await get(`/api/attacks?from=${WAR_START}&to=${WAR_END}&limit=3&offset=3`)
    expect(page2.body.attacks.map((a: any) => a.attack_id)).toEqual([2])
  })

  it('treats a missing/zero `to` as an open-ended (ongoing war) window', async () => {
    const { status, body } = await get(`/api/attacks?from=${WAR_START}&to=0`)
    expect(status).toBe(200)
    expect(body.total).toBe(5)
    expect(body.attacks[0].attack_id).toBe(6)
  })

  it('rejects a window without a numeric from', async () => {
    const { status } = await get('/api/attacks?to=123')
    expect(status).toBe(400)
  })
})

describe('GET /api/wars/:id/revives', () => {
  it('returns revives stored against the war ordered by timestamp', async () => {
    await stack.db.query(`
      INSERT INTO faction_revives (revive_id, rw_id, "timestamp", reviver_id, reviver_name, target_id, target_name) VALUES
        (11, 200, ${WAR_START + 500}, 700, 'Medic',    500, 'Member'),
        (12, 200, ${WAR_START + 100}, 701, 'Paramedic', 501, 'Slacker'),
        (13, 100, ${WAR_START - 850000}, 700, 'Medic',  500, 'Member')
    `)
    const { status, body } = await get('/api/wars/200/revives')
    expect(status).toBe(200)
    expect(body.revives.map((r: any) => r.revive_id)).toEqual([12, 11])
    expect(body.revives[0].reviver_name).toBe('Paramedic')
  })
})

describe('war payout history', () => {
  beforeAll(async () => {
    // Two saved payouts for war 200 (a re-run supersedes the first) and one
    // for war 100, each with member rows.
    // Insert in chronological order so payout ids grow with created_at,
    // as they do in production.
    const p = await stack.db.query(`
      INSERT INTO war_payouts (war_id, war_type, faction_cut_percent, notes, merc_cost, created_at) VALUES
        (100, 'real',   20, 'old war',     0,       '2026-05-01T10:00:00Z'),
        (200, 'termed', 20, 'first pass',  0,       '2026-06-01T10:00:00Z'),
        (200, 'termed', 25, 'final',       5000000, '2026-06-02T10:00:00Z')
      RETURNING id
    `)
    const [old, first, final] = p.rows.map((r) => r.id)
    await stack.db.query(`
      INSERT INTO war_payout_members (payout_id, member_id, member_name, score, payout_amount, is_eligible, war_hits) VALUES
        (${first}, 500, 'Member',  410.25, 90000000, true,  30),
        (${final}, 500, 'Member',  410.25, 85000000, true,  30),
        (${final}, 501, 'Slacker',  12.50,        0, false,  1),
        (${old},   500, 'Member',  100.00, 20000000, true,  10)
    `)
  })

  it('GET /api/wars/:id/payouts returns saved payouts newest-first with nested members', async () => {
    const { status, body } = await get('/api/wars/200/payouts')
    expect(status).toBe(200)
    expect(body.payouts.map((p: any) => p.notes)).toEqual(['final', 'first pass'])
    expect(body.payouts[0].merc_cost).toBe(5000000)
    // Nested member rows, payout_amount desc, matching the PostgREST shape.
    expect(body.payouts[0].war_payout_members.map((m: any) => m.member_name)).toEqual(['Member', 'Slacker'])
    expect(body.payouts[0].war_payout_members[0].payout_amount).toBe(85000000)
  })

  it('GET /api/war-payouts returns recent payouts across wars with nested members', async () => {
    const { status, body } = await get('/api/war-payouts?limit=2')
    expect(status).toBe(200)
    expect(body.payouts.map((p: any) => p.war_id)).toEqual([200, 200])
    expect(body.payouts[0].notes).toBe('final')
    expect(body.payouts[0].war_payout_members).toHaveLength(2)
  })

  it('GET /api/war-payouts/:id/members returns the payout sheet ordered by amount', async () => {
    const list = await get('/api/wars/200/payouts')
    const finalId = list.body.payouts[0].id
    const { status, body } = await get(`/api/war-payouts/${finalId}/members`)
    expect(status).toBe(200)
    expect(body.members.map((m: any) => m.member_name)).toEqual(['Member', 'Slacker'])
    expect(body.members[1].is_eligible).toBe(false)
  })

  it('GET /api/members/:id/war-payouts carries the fields the RW payouts page renders', async () => {
    const { status, body } = await get('/api/members/500/war-payouts')
    expect(status).toBe(200)
    // Newest payout first; each row joins its payout + war summary.
    expect(body.war_payouts[0].payout_amount).toBe(85000000)
    expect(body.war_payouts[0].war_payouts.war_id).toBe(200)
    expect(body.war_payouts[0].war_payouts.faction_cut_percent).toBe(25)
    expect(body.war_payouts[0].war_payouts.notes).toBe('final')
    expect(body.war_payouts[0].war_payouts.ranked_wars.opponent_name).toBe('Test Dummies')
    expect(body.war_payouts[0].war_payouts.ranked_wars.our_score).toBe(2500)
  })
})

describe('POST /api/war-payouts (save)', () => {
  // The RW payout calculator's output for war 300 (the ongoing war — no
  // saved payouts yet, keeps it independent of the history fixtures).
  const payout = {
    war_id: 300,
    war_type: 'termed',
    faction_cut_percent: 20,
    total_reward: 1000000000,
    total_payout: 800000000,
    member_count: 2,
    termed_mode: 'formula',
    merc_cost: 12000000,
    notes: 'slice-7 save',
  }
  const members = [
    { member_id: 500, member_name: 'Member', score: 410.25, war_hits: 30, payout_amount: 500000000, is_eligible: true, race_breakdown: { pre: null, post: null } },
    { member_id: 501, member_name: 'Slacker', score: 12.5, war_hits: 1, payout_amount: 300000000, is_eligible: true, race_breakdown: null },
  ]

  it('leadership saves a payout; it round-trips through the war payout history', async () => {
    const { status, body } = await post('/api/war-payouts', { payout, members })
    expect(status).toBe(200)
    expect(body.payout_id).toBeGreaterThan(0)
    expect(body.member_count).toBe(2)

    const { body: history } = await get('/api/wars/300/payouts')
    expect(history.payouts).toHaveLength(1)
    const saved = history.payouts[0]
    expect(saved.total_payout).toBe(800000000)
    expect(saved.merc_cost).toBe(12000000)
    expect(saved.created_by).toBe('600')
    expect(saved.war_payout_members.map((m: any) => m.member_name)).toEqual(['Member', 'Slacker'])
    expect(saved.war_payout_members[0].race_breakdown).toEqual({ pre: null, post: null })
  })

  it('re-saving the same war overwrites the latest payout and replaces its members', async () => {
    const { status, body } = await post('/api/war-payouts', {
      payout: { ...payout, total_payout: 750000000, notes: 'corrected' },
      members: [members[0]],
    })
    expect(status).toBe(200)

    const { body: history } = await get('/api/wars/300/payouts')
    expect(history.payouts).toHaveLength(1)
    expect(history.payouts[0].id).toBe(body.payout_id)
    expect(history.payouts[0].total_payout).toBe(750000000)
    expect(history.payouts[0].notes).toBe('corrected')
    expect(history.payouts[0].war_payout_members).toHaveLength(1)
  })

  it('overwrites only the latest payout when a war has several saved', async () => {
    // War 200 has two payouts from the history fixtures ('first pass', 'final').
    const { status } = await post('/api/war-payouts', {
      payout: { ...payout, war_id: 200, notes: 'third pass' },
      members: [members[0]],
    })
    expect(status).toBe(200)

    const { body: history } = await get('/api/wars/200/payouts')
    expect(history.payouts).toHaveLength(2)
    expect(history.payouts.map((p: any) => p.notes).sort()).toEqual(['first pass', 'third pass'])
  })

  it('rejects visitors with the read-only message', async () => {
    const { status, body } = await post('/api/war-payouts', { payout, members }, 'visitor')
    expect(status).toBe(403)
    expect(body.error).toBe('Visitor mode is read-only')
  })

  it('rejects plain members', async () => {
    const { status } = await post('/api/war-payouts', { payout, members }, 'member')
    expect(status).toBe(403)
  })

  it('rejects a payload without payout.war_id or members', async () => {
    expect((await post('/api/war-payouts', { payout: { war_type: 'termed' }, members })).status).toBe(400)
    expect((await post('/api/war-payouts', { payout })).status).toBe(400)
    expect((await post('/api/war-payouts', { payout, members: [{ member_name: 'NoId' }] })).status).toBe(400)
  })
})

describe('POST /api/wars/:id/is-termed', () => {
  it('leadership toggles the Real/Termed classification; visitors and members cannot', async () => {
    const before = await get('/api/wars/300')
    expect(before.body.war.is_termed).toBe(true)

    const { status, body } = await post('/api/wars/300/is-termed', { is_termed: false })
    expect(status).toBe(200)
    expect(body.is_termed).toBe(false)

    const after = await get('/api/wars/300')
    expect(after.body.war.is_termed).toBe(false)

    expect((await post('/api/wars/300/is-termed', { is_termed: true }, 'visitor')).status).toBe(403)
    expect((await post('/api/wars/300/is-termed', { is_termed: true }, 'member')).status).toBe(403)
    expect((await post('/api/wars/300/is-termed', {}, 'leader')).status).toBe(400)
  })
})

describe('GET /api/factions', () => {
  it('returns id/name/tag rows for the requested faction ids', async () => {
    await stack.db.query(`
      INSERT INTO factions (id, name, tag) VALUES (9002, 'Test Dummies', 'TD'), (9003, 'Fresh Meat', NULL)
    `)
    const { status, body } = await get('/api/factions?ids=9002,9003,555')
    expect(status).toBe(200)
    expect(body.factions).toEqual([
      { id: 9002, name: 'Test Dummies', tag: 'TD' },
      { id: 9003, name: 'Fresh Meat', tag: null },
    ])
  })
})
