// Leadership tools (slice #66): member-overview saved views/thresholds CRUD,
// tier overrides, inventory + pricing — black-box at the HTTP seam against a
// real templated Postgres. Every write is purpose-built and leadership-gated;
// visitors read everything, write nothing.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'

let stack: TestStack
const tokens: Record<string, string> = {}

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

async function call(method: string, path: string, payload?: unknown, as = 'leader') {
  const headers: Record<string, string> = { authorization: `Bearer ${tokens[as]}` }
  if (payload !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(`${stack.baseUrl}${path}`, {
    method,
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}
const get = (path: string, as = 'leader') => call('GET', path, undefined, as)

beforeAll(async () => {
  stack = await startTestStack()
  // Roster before logins: a roster-missing member's login now creates a
  // stub row (fresh-faction bootstrap), which would collide with this insert.
  await stack.db.query(`
    INSERT INTO members (member_id, member_name, tier, is_current) VALUES
      ('700', 'Boss', 2, true)
  `)
  await loginAs('leader', '700', ['leadership'])
  await loginAs('visitor', '701', ['visitor'])
}, 30000)

afterAll(async () => {
  await stack?.close()
})

describe('member-overview saved views', () => {
  it('leadership creates a view; it lists with server-stamped attribution', async () => {
    const { status, body } = await call('POST', '/api/overview/views', {
      name: 'Attack stats',
      columns: ['xanax_taken', 'attacks_won'],
    })
    expect(status).toBe(200)
    expect(body.view.id).toBeTruthy()
    expect(body.view.name).toBe('Attack stats')

    const list = await get('/api/overview/views', 'visitor')
    expect(list.status).toBe(200)
    expect(list.body.views).toHaveLength(1)
    expect(list.body.views[0].columns).toEqual(['xanax_taken', 'attacks_won'])
    // Attribution comes from the session, not the client payload.
    expect(list.body.views[0].created_by_id).toBe('700')
    expect(list.body.views[0].created_by_name).toBe('Boss')
  })

  it('leadership renames and deletes a view; unknown ids 404', async () => {
    const created = await call('POST', '/api/overview/views', { name: 'Temp', columns: ['level'] })
    const id = created.body.view.id

    const updated = await call('PUT', `/api/overview/views/${id}`, { name: 'Drug stats', columns: ['xanax_taken'] })
    expect(updated.status).toBe(200)
    expect(updated.body.view.name).toBe('Drug stats')
    expect(updated.body.view.columns).toEqual(['xanax_taken'])

    const deleted = await call('DELETE', `/api/overview/views/${id}`)
    expect(deleted.status).toBe(200)
    const list = await get('/api/overview/views')
    expect(list.body.views.map((v: any) => v.name)).toEqual(['Attack stats'])

    expect((await call('PUT', `/api/overview/views/${id}`, { name: 'X', columns: [] })).status).toBe(404)
    expect((await call('DELETE', `/api/overview/views/${id}`)).status).toBe(404)
  })

  it('visitors can read but not write; writes validate their payloads', async () => {
    expect((await call('POST', '/api/overview/views', { name: 'V', columns: [] }, 'visitor')).status).toBe(403)
    const existing = (await get('/api/overview/views')).body.views[0]
    expect((await call('PUT', `/api/overview/views/${existing.id}`, { name: 'V', columns: [] }, 'visitor')).status).toBe(403)
    expect((await call('DELETE', `/api/overview/views/${existing.id}`, undefined, 'visitor')).status).toBe(403)
    expect((await call('POST', '/api/overview/views', { columns: [] })).status).toBe(400)
    expect((await call('POST', '/api/overview/views', { name: 'NoCols' })).status).toBe(400)
  })
})

describe('member-overview threshold sets', () => {
  it('full CRUD round-trip with visitor read access', async () => {
    const thresholds = { xanax_taken: { warn: 10, bad: 25 }, attacks_won: { good: 50 } }
    const created = await call('POST', '/api/overview/thresholds', { name: 'Default alerts', thresholds })
    expect(created.status).toBe(200)
    const id = created.body.threshold.id

    const list = await get('/api/overview/thresholds', 'visitor')
    expect(list.status).toBe(200)
    expect(list.body.thresholds).toHaveLength(1)
    expect(list.body.thresholds[0].thresholds).toEqual(thresholds)
    expect(list.body.thresholds[0].created_by_name).toBe('Boss')

    const updated = await call('PUT', `/api/overview/thresholds/${id}`, {
      name: 'Stricter', thresholds: { xanax_taken: { warn: 5 } },
    })
    expect(updated.status).toBe(200)
    expect(updated.body.threshold.name).toBe('Stricter')

    expect((await call('POST', '/api/overview/thresholds', { name: 'NoBody' })).status).toBe(400)
    expect((await call('POST', '/api/overview/thresholds', { name: 'V', thresholds }, 'visitor')).status).toBe(403)

    expect((await call('DELETE', `/api/overview/thresholds/${id}`)).status).toBe(200)
    expect((await get('/api/overview/thresholds')).body.thresholds).toEqual([])
    expect((await call('DELETE', `/api/overview/thresholds/${id}`)).status).toBe(404)
  })
})

describe('GET /api/overview/daily-stats', () => {
  it('returns snapshots since a date (legacy param), newest first, projected to catalog stats', async () => {
    await stack.db.query(`
      INSERT INTO members (member_id, member_name, tier, is_current) VALUES ('702', 'Grinder', 4, true)
    `)
    // Real nested catalog shape + a non-catalog branch that projection must strip.
    await stack.db.query(`
      INSERT INTO member_daily_stats (member_id, snapshot_date, personalstats, gym_strength) VALUES
        ('700', '2026-07-01', '{"drugs": {"xanax": 100}, "secret": {"internal": 9}}', 1000000),
        ('700', '2026-07-05', '{"drugs": {"xanax": 104}, "secret": {"internal": 9}}', 1050000),
        ('702', '2026-07-05', '{"drugs": {"xanax": 3}}',   900000),
        ('702', '2026-06-01', '{"drugs": {"xanax": 1}}',   800000)
    `)
    const { status, body } = await get('/api/overview/daily-stats?since=2026-06-15', 'visitor')
    expect(status).toBe(200)
    // The June 1 snapshot is outside the window.
    expect(body.snapshots).toHaveLength(3)
    expect(body.snapshots.map((s: any) => [s.member_id, s.snapshot_date])).toEqual([
      ['700', '2026-07-05'],
      ['700', '2026-07-01'],
      ['702', '2026-07-05'],
    ])
    // Catalog path kept; the non-catalog "secret" branch is stripped.
    expect(body.snapshots[0].personalstats).toEqual({ drugs: { xanax: 104 } })

    // No window and no since → 400.
    expect((await get('/api/overview/daily-stats')).status).toBe(400)
    // Unknown window → 400.
    expect((await get('/api/overview/daily-stats?window=nonsense')).status).toBe(400)
  })

  it('window=all returns the full history; window=30 bounds it to the last 30 days', async () => {
    // Existing fixture: 702 has snapshots on 2026-07-05 and 2026-06-01.
    const iso = (d: Date) => d.toISOString().slice(0, 10)
    const recent = iso(new Date())
    const old = iso(new Date(Date.now() - 200 * 86400_000))
    await stack.db.query(
      `INSERT INTO member_daily_stats (member_id, snapshot_date, personalstats)
       VALUES ('702', $1, '{"drugs":{"xanax":9}}'), ('702', $2, '{"drugs":{"xanax":2}}')
       ON CONFLICT (member_id, snapshot_date) DO NOTHING`,
      [recent, old]
    )

    const all = await get('/api/overview/daily-stats?window=all', 'visitor')
    const dates702all = all.body.snapshots.filter((s: any) => s.member_id === '702').map((s: any) => s.snapshot_date)
    expect(dates702all).toContain(old)         // 200 days back — only "all" reaches it
    expect(dates702all).toContain('2026-06-01')

    const w30 = await get('/api/overview/daily-stats?window=30', 'visitor')
    const dates702w30 = w30.body.snapshots.filter((s: any) => s.member_id === '702').map((s: any) => s.snapshot_date)
    expect(dates702w30).toContain(recent)      // within 30 days
    expect(dates702w30).not.toContain(old)     // 200 days back — excluded
  })
})

describe('PUT /api/members/:id/tier-override', () => {
  it('leadership sets and clears a tier override; visitors cannot', async () => {
    const set = await call('PUT', '/api/members/702/tier-override', { tier_override: 1 })
    expect(set.status).toBe(200)
    expect(set.body.member.tier_override).toBe(1)

    const cleared = await call('PUT', '/api/members/702/tier-override', { tier_override: null })
    expect(cleared.status).toBe(200)
    expect(cleared.body.member.tier_override).toBeNull()

    expect((await call('PUT', '/api/members/702/tier-override', { tier_override: 2 }, 'visitor')).status).toBe(403)
    expect((await call('PUT', '/api/members/999999/tier-override', { tier_override: 2 })).status).toBe(404)
    expect((await call('PUT', '/api/members/702/tier-override', { tier_override: 'high' })).status).toBe(400)
  })
})

describe('inventory management', () => {
  it('GET /api/inventory returns priced items and the last sync marker', async () => {
    await stack.db.query(`
      INSERT INTO inventory_items (id, name, quantity, available, loaned, loaned_to, category) VALUES
        ('66', 'Morphine', 50, 40, 10, 'Boss [700]', 'medical'),
        ('206', 'Xanax', 200, 200, 0, NULL, 'drugs')
    `)
    await stack.db.query(`
      INSERT INTO pricing_batches (item_id, price, quantity, added_by) VALUES ('206', 800000, 100, 'Boss')
    `)
    await stack.db.query(`
      INSERT INTO sync_metadata (data_type, last_sync, synced_by) VALUES
        ('inventory', '2026-07-01T10:00:00', 'Boss'),
        ('inventory', '2026-07-08T10:00:00', 'Boss'),
        ('crimes',    '2026-07-09T10:00:00', 'Boss')
    `)
    const { status, body } = await get('/api/inventory', 'visitor')
    expect(status).toBe(200)
    expect(body.items).toHaveLength(2)
    const xanax = body.items.find((i: any) => i.item_id === '206')
    expect(xanax.weighted_avg_price).toBe(800000)
    // Latest inventory sync, not the crimes one.
    expect(body.last_sync).toBe('2026-07-08T10:00:00')
  })

  it('leadership adds a pricing batch (attributed from the session); visitors cannot', async () => {
    const { status, body } = await call('POST', '/api/inventory/pricing-batches', {
      item_id: '66', price: 45000, quantity: 25,
    })
    expect(status).toBe(200)
    expect(body.batch.item_id).toBe('66')
    expect(body.batch.added_by).toBe('Boss')

    const inv = await get('/api/inventory')
    const morphine = inv.body.items.find((i: any) => i.item_id === '66')
    expect(morphine.weighted_avg_price).toBe(45000)

    expect((await call('POST', '/api/inventory/pricing-batches', { item_id: '66', price: 1, quantity: 1 }, 'visitor')).status).toBe(403)
    expect((await call('POST', '/api/inventory/pricing-batches', { item_id: '66', price: -5, quantity: 1 })).status).toBe(400)
    expect((await call('POST', '/api/inventory/pricing-batches', { item_id: 'nope', price: 5, quantity: 1 })).status).toBe(404)
  })

  it('PUT /api/inventory/items/:id/price replaces all batches with one at the new price', async () => {
    await stack.db.query(`INSERT INTO pricing_batches (item_id, price, quantity, added_by) VALUES ('66', 99000, 10, 'Boss')`)

    const { status } = await call('PUT', '/api/inventory/items/66/price', { price: 50000 })
    expect(status).toBe(200)

    const inv = await get('/api/inventory')
    const morphine = inv.body.items.find((i: any) => i.item_id === '66')
    // One batch at 50k for the full quantity — the earlier 45k/99k batches are gone.
    expect(morphine.weighted_avg_price).toBe(50000)
    expect(morphine.total_batched_quantity).toBe(50)

    expect((await call('PUT', '/api/inventory/items/66/price', { price: 1 }, 'visitor')).status).toBe(403)
    expect((await call('PUT', '/api/inventory/items/nope/price', { price: 1 })).status).toBe(404)
  })

  it('POST /api/inventory/sync pulls the faction inventory from Torn with the server key', async () => {
    stack.torn.setHandler('/v2/faction/inventory', (url) => {
      const cat = url.searchParams.get('cat')
      if (cat === 'medical') {
        return {
          inventory: [{ id: 66, name: 'Morphine', type: 'Medical', amount: 60, uids: [], loaned: { id: 700, name: 'Bob' } }],
          _metadata: { total: 1 },
        }
      }
      if (cat === 'drugs') {
        return {
          inventory: [
            { id: 206, name: 'Xanax', type: 'Drug', amount: 180, uids: [], loaned: null },
            { id: 197, name: 'Ecstasy', type: 'Drug', amount: 12, uids: [], loaned: null },
          ],
          _metadata: { total: 2 },
        }
      }
      return { inventory: [], _metadata: { total: 0 } }
    })
    const { status, body } = await call('POST', '/api/inventory/sync', {})
    expect(status).toBe(200)
    expect(body.items_synced).toBe(3)

    const inv = await get('/api/inventory')
    const xanax = inv.body.items.find((i: any) => i.item_id === '206')
    expect(xanax.quantity).toBe(180)
    const ecstasy = inv.body.items.find((i: any) => i.item_id === '197')
    expect(ecstasy.item_name).toBe('Ecstasy')
    // The sync marker moved and is attributed to the caller.
    expect(inv.body.last_sync > '2026-07-08T10:00:00').toBe(true)

    expect((await call('POST', '/api/inventory/sync', {}, 'visitor')).status).toBe(403)
  })
})
