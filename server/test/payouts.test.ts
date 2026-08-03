// OC payout flow (slice #63): window reads + leadership-gated save, black-box
// at the HTTP seam against a real templated Postgres.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'

let stack: TestStack
const tokens: Record<string, string> = {}

// Payout window under test: [1750000000, 1750604800) (one week).
const FROM = 1750000000
const TO = FROM + 604800

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

async function get(path: string, as = 'leader') {
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

async function del(path: string, as = 'leader') {
  const res = await fetch(`${stack.baseUrl}${path}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${tokens[as]}` },
  })
  return { status: res.status, body: (await res.json()) as any }
}

beforeAll(async () => {
  stack = await startTestStack()
  await loginAs('leader', '400', ['leadership'])
  await loginAs('visitor', '401', ['visitor'])
  await loginAs('member', '402', [])

  // Crimes spanning every payout-window category (and the exclusions).
  await stack.db.query(`
    INSERT INTO crimes (crime_id, name, difficulty, status, created_at, executed_at) VALUES
      ('in-window',    'Executed inside the window',        8, 'Successful', ${FROM - 1000},   ${FROM + 100}),
      ('lookback',     'Created before, executed nowhere',  6, 'Successful', ${FROM - 100000}, ${FROM - 50000}),
      ('in-progress',  'Still recruiting',                  5, 'Recruiting', ${FROM - 5000},   NULL),
      ('post-window',  'Created inside, executed after',    7, 'Successful', ${FROM + 200},    ${TO + 500}),
      ('too-old',      'Created before the lookback',       4, 'Successful', ${FROM - 604800 * 4}, ${FROM - 604800 * 4 + 100}),
      ('after-window', 'Executed after, created after',     4, 'Successful', ${TO + 1000},     ${TO + 2000})
  `)
  await stack.db.query(`
    INSERT INTO crime_slots (crime_id, "position", position_id, user_id, joined_at) VALUES
      ('in-window', 'Robber', 'P1', '400', ${FROM - 500}),
      ('in-progress', 'Hustler', 'P1', '402', ${FROM + 50})
  `)
  await stack.db.query(`
    INSERT INTO crime_reward_items (crime_id, item_id, quantity, unit_value) VALUES
      ('in-window', '66', 2, 1000000)
  `)
  await stack.db.query(`
    INSERT INTO crime_required_items (crime_id, "position", position_id, item_id, was_consumed, unit_value) VALUES
      ('in-window', 'Robber', 'P1', '206', true, 50000)
  `)
})

afterAll(async () => {
  await stack?.close()
})

describe('GET /api/payouts/crime-data', () => {
  it('returns the four-category union of crimes for the window with related rows', async () => {
    const { status, body } = await get(`/api/payouts/crime-data?from=${FROM}&to=${TO}`)
    expect(status).toBe(200)
    // Executed in window + created in 3-week lookback + still in progress +
    // created inside but executed after. Not: older than lookback, created after.
    expect(body.crimes.map((c: any) => c.crime_id).sort()).toEqual(
      ['in-progress', 'in-window', 'lookback', 'post-window']
    )
    expect(body.slots.map((s: any) => s.crime_id).sort()).toEqual(['in-progress', 'in-window'])
    expect(body.reward_items).toHaveLength(1)
    expect(body.reward_items[0].unit_value).toBe(1000000)
    expect(body.required_items).toHaveLength(1)
    expect(body.required_items[0].was_consumed).toBe(true)
  })
})

describe('POST /api/payouts/weeks (save)', () => {
  const week = {
    week_start: '2026-06-15',
    week_end: '2026-06-21',
    week_start_timestamp: FROM,
    week_end_timestamp: TO,
    total_money_reward: 90000000,
    faction_cut_percent: 20,
    faction_cut_amount: 18000000,
    member_payout_total: 72000000,
    crimes_processed: 2,
  }
  const members = [
    { member_id: '400', member_name: 'Leader', tier: 2, base_tickets: 30, payout: 40000000, crimes_count: 1 },
    { member_id: '402', member_name: 'Member', tier: 4, base_tickets: 7, payout: 32000000, crimes_count: 1 },
  ]

  it('leadership saves a week; it round-trips through the read endpoints', async () => {
    const { status, body } = await post('/api/payouts/weeks', {
      // week.crime_ids is client-tampered — the server must stamp the week
      // row from the top-level crime_ids it actually links.
      week: { ...week, crime_ids: ['client-tampered'] },
      members, crime_ids: ['in-window', 'post-window'],
    })
    expect(status).toBe(200)
    expect(body.week_id).toBeGreaterThan(0)
    expect(body.member_count).toBe(2)

    const weeks = await get('/api/payouts/weeks')
    expect(weeks.body.weeks).toHaveLength(1)
    expect(weeks.body.weeks[0].member_payout_total).toBe(72000000)
    expect(weeks.body.weeks[0].saved_by).toBe('400')
    expect(weeks.body.weeks[0].saved_at).toBeTruthy()
    expect(weeks.body.weeks[0].crime_ids).toEqual(['in-window', 'post-window'])

    const wm = await get(`/api/payouts/weeks/${body.week_id}/members`)
    // Ordered by payout desc.
    expect(wm.body.members.map((m: any) => m.member_id)).toEqual(['400', '402'])
    expect(wm.body.members[0].payout).toBe(40000000)

    const wc = await get(`/api/payouts/weeks/${body.week_id}/crimes`)
    expect(wc.body.crimes.map((c: any) => c.crime_id).sort()).toEqual(['in-window', 'post-window'])
  })

  it('saving the same window again updates in place and replaces member rows', async () => {
    const { status, body } = await post('/api/payouts/weeks', {
      week: { ...week, member_payout_total: 80000000 },
      members: [members[0]],
      crime_ids: [],
    })
    expect(status).toBe(200)

    const weeks = await get('/api/payouts/weeks')
    expect(weeks.body.weeks).toHaveLength(1)
    expect(weeks.body.weeks[0].member_payout_total).toBe(80000000)

    const wm = await get(`/api/payouts/weeks/${body.week_id}/members`)
    expect(wm.body.members).toHaveLength(1)
  })

  it('rejects visitors with a clear read-only message', async () => {
    const { status, body } = await post('/api/payouts/weeks', { week, members, crime_ids: [] }, 'visitor')
    expect(status).toBe(403)
    expect(body.error).toBe('Visitor mode is read-only')
  })

  it('rejects plain members', async () => {
    const { status } = await post('/api/payouts/weeks', { week, members, crime_ids: [] }, 'member')
    expect(status).toBe(403)
  })

  it('rejects a payload without week or members', async () => {
    const { status } = await post('/api/payouts/weeks', { week }, 'leader')
    expect(status).toBe(400)
  })

  it('rejects a member row missing required fields with a 400 before saving anything', async () => {
    const { status, body } = await post('/api/payouts/weeks', {
      week: { ...week, week_start: '2026-06-22', week_end: '2026-06-28' },
      members: [{ member_id: '400', payout: 1 }],
      crime_ids: [],
    })
    expect(status).toBe(400)
    expect(body.error).toMatch(/member_name/)
    // Nothing persisted: still just the one week from the earlier saves.
    const weeks = await get('/api/payouts/weeks')
    expect(weeks.body.weeks).toHaveLength(1)
  })
})

describe('week lookups', () => {
  it('GET /api/payouts/weeks filters to the exact week by week_start/week_end', async () => {
    const { status, body } = await get('/api/payouts/weeks?week_start=2026-06-15&week_end=2026-06-21')
    expect(status).toBe(200)
    expect(body.weeks).toHaveLength(1)
    expect(body.weeks[0].week_start).toBe('2026-06-15')

    const none = await get('/api/payouts/weeks?week_start=2020-01-01&week_end=2020-01-07')
    expect(none.status).toBe(200)
    expect(none.body.weeks).toEqual([])
  })

  it('GET /api/payouts/weeks/:id returns the single week, 404 when unknown', async () => {
    const list = await get('/api/payouts/weeks')
    const id = list.body.weeks[0].id
    const { status, body } = await get(`/api/payouts/weeks/${id}`)
    expect(status).toBe(200)
    expect(body.week.id).toBe(id)
    expect(body.week.week_end).toBe('2026-06-21')

    const missing = await get('/api/payouts/weeks/999999')
    expect(missing.status).toBe(404)
  })
})

describe('GET /api/payouts/members', () => {
  it('returns every member payout row across weeks, newest week first', async () => {
    const { status, body } = await get('/api/payouts/members')
    expect(status).toBe(200)
    // Seeded by the save tests above: the re-save left one row for week 1.
    expect(body.members).toHaveLength(1)
    expect(body.members[0].member_id).toBe('400')
    expect(body.members[0].week_end).toBe('2026-06-21')
  })
})

describe('GET /api/items/lookup', () => {
  it('returns names/sell prices and inventory weighted prices for the requested ids', async () => {
    await stack.db.query(`
      INSERT INTO items (id, name, sell_price) VALUES (66, 'Morphine', 45000), (206, 'Xanax', 745000)
      ON CONFLICT (id) DO NOTHING
    `)
    await stack.db.query(`
      INSERT INTO inventory_items (id, name, quantity) VALUES ('206', 'Xanax', 10)
      ON CONFLICT (id) DO NOTHING
    `)
    await stack.db.query(`
      INSERT INTO pricing_batches (item_id, price, quantity, added_by) VALUES ('206', 800000, 5, 'tester')
    `)
    const { status, body } = await get('/api/items/lookup?ids=66,206')
    expect(status).toBe(200)
    expect(body.items).toEqual([
      { id: 66, name: 'Morphine', sell_price: 45000 },
      { id: 206, name: 'Xanax', sell_price: 745000 },
    ])
    expect(body.inventory_prices).toEqual([
      { item_id: '206', weighted_avg_price: 800000 },
    ])
  })
})

describe('GET /api/members/with-cpr', () => {
  it('returns full member rows plus all CPR rows for the payout calculator', async () => {
    await stack.db.query(`
      INSERT INTO members (member_id, member_name, tier) VALUES ('400', 'Leader', 2)
      ON CONFLICT (member_id) DO NOTHING
    `)
    await stack.db.query(`
      INSERT INTO member_cpr_v2 (member_id, crime_name, position_label, difficulty, cpr_value)
      VALUES ('400', 'Break the Bank', 'Robber', 8, 77)
    `)
    const { status, body } = await get('/api/members/with-cpr')
    expect(status).toBe(200)
    expect(body.members[0].member_id).toBe('400')
    // True since the fresh-faction bootstrap: the leader's login stubbed
    // their roster row and enrolled their key into the pool.
    expect(body.members[0].has_cpr_key).toBe(true)
    expect(body.cpr).toEqual([
      { member_id: '400', crime_name: 'Break the Bank', position_label: 'Robber', difficulty: 8, cpr_value: 77 },
    ])
  })
})

describe('DELETE /api/payouts/weeks/:id', () => {
  async function saveWeek(crimeIds: string[]) {
    const { body } = await post('/api/payouts/weeks', {
      week: {
        week_start: '2026-06-29', week_end: '2026-07-05',
        week_start_timestamp: FROM, week_end_timestamp: TO,
        total_money_reward: 1000, faction_cut_percent: 20,
        faction_cut_amount: 200, member_payout_total: 800, crimes_processed: crimeIds.length,
      },
      members: [{ member_id: '400', member_name: 'Leader', tier: 2, base_tickets: 1, payout: 800, crimes_count: 1 }],
      crime_ids: crimeIds,
    })
    return body.week_id as number
  }

  it('leadership deletes a week: members removed, crimes unlinked, week gone', async () => {
    const weekId = await saveWeek(['lookback'])
    expect(Number((await stack.db.query(`SELECT payout_week_id FROM crimes WHERE crime_id = 'lookback'`)).rows[0].payout_week_id)).toBe(weekId)

    // Non-leadership is refused; the week survives.
    expect((await del(`/api/payouts/weeks/${weekId}`, 'member')).status).toBe(403)
    expect((await del(`/api/payouts/weeks/${weekId}`, 'visitor')).status).toBe(403)

    const res = await del(`/api/payouts/weeks/${weekId}`)
    expect(res.status).toBe(200)
    expect(res.body.deleted_week_id).toBe(weekId)
    expect((await get(`/api/payouts/weeks/${weekId}`)).status).toBe(404)
    expect((await stack.db.query('SELECT count(*)::int AS n FROM oc_payout_members WHERE week_id = $1', [weekId])).rows[0].n).toBe(0)
    // The FK-linked crime is unlinked, not deleted.
    expect((await stack.db.query(`SELECT payout_week_id FROM crimes WHERE crime_id = 'lookback'`)).rows[0].payout_week_id).toBeNull()
  })

  it('404 for a missing week', async () => {
    expect((await del('/api/payouts/weeks/999999')).status).toBe(404)
  })
})
