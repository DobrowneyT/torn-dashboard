// The faction event API, end to end against real Postgres (#969).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'

let stack: TestStack
let member: string
let lead: string

async function loginAs(key: string, id: string) {
  stack.torn.addKey(key, { id, factionId: TEST_FACTION.tornFactionId })
  const res = await fetch(`${stack.baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey: key }),
  })
  expect(res.status).toBe(200)
  return ((await res.json()) as any).token as string
}

async function api(method: string, path: string, token: string, payload?: unknown) {
  const res = await fetch(`${stack.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

const HOUR = 3_600_000
const current = async () => (await api('GET', '/api/events/current', member)).body.event

/** An event positioned relative to now, so phases are deterministic. */
const make = (over: Record<string, unknown> = {}) => ({
  name: 'Halloween',
  theme_color: '#f97316',
  starts_at: Date.now() - 2 * HOUR,
  daily_from: Date.now() - HOUR,
  min_ends_at: Date.now() + 24 * HOUR,
  ends_with_chain: true,
  ...over,
})

beforeAll(async () => {
  stack = await startTestStack()
  await stack.db.query(`INSERT INTO role_assignments (torn_user_id, role) VALUES (7101, 'leadership')`)
  member = await loginAs('EVENTMEMBER7100XX', '7100')
  lead = await loginAs('EVENTLEADER7101XX', '7101')
}, 30_000)

afterAll(async () => { await stack?.close() })

beforeEach(async () => {
  await stack.db.query('DELETE FROM faction_events')
  await stack.db.query('DELETE FROM chain_samples')
})

const sample = (msAgo: number, current: number | null) =>
  stack.db.query(
    `INSERT INTO chain_samples (sampled_at, chain_current) VALUES (now() - make_interval(secs => $1), $2)`,
    [msAgo / 1000, current])

describe('reading', () => {
  it('is null when there is no event', async () => {
    expect(await current()).toBeNull()
  })

  it('needs a signed-in session', async () => {
    const res = await fetch(`${stack.baseUrl}/api/events/current`)
    expect(res.status).toBe(401)
  })

  it('shows an upcoming event before it starts', async () => {
    await api('POST', '/api/events', lead, make({ starts_at: Date.now() + HOUR, daily_from: Date.now() + 2 * HOUR }))
    expect((await current()).phase).toBe('upcoming')
  })

  it('shows it live once started, with times as epoch ms', async () => {
    const body = make()
    await api('POST', '/api/events', lead, body)
    const e = await current()
    expect(e.phase).toBe('live')
    expect(e.name).toBe('Halloween')
    expect(e.theme_color).toBe('#f97316')
    // ⚠️ Numbers, not timestamptz strings with a bare `+00` offset.
    expect(typeof e.starts_at).toBe('number')
    expect(Math.abs(e.starts_at - (body.starts_at as number))).toBeLessThan(1000)
  })
})

describe('⚠️ the end is not a date', () => {
  it('a chain dying BEFORE the minimum end does not end it', async () => {
    await api('POST', '/api/events', lead, make())
    await sample(HOUR, 0)
    expect((await current()).phase).toBe('live')
  })

  it('past the minimum, it stays live while there is no sign the chain ended', async () => {
    await api('POST', '/api/events', lead, make({
      starts_at: Date.now() - 10 * HOUR, daily_from: Date.now() - 9 * HOUR, min_ends_at: Date.now() - HOUR,
    }))
    await sample(10 * 60_000, 48_000)
    expect((await current()).phase).toBe('live')
  })

  it('⚠️ past the minimum with NO samples at all — an outage — it stays live', async () => {
    await api('POST', '/api/events', lead, make({
      starts_at: Date.now() - 10 * HOUR, daily_from: Date.now() - 9 * HOUR, min_ends_at: Date.now() - HOUR,
    }))
    expect((await current()).phase).toBe('live')
  })

  it('ends at the first dead sample past the minimum, and stamps THAT time', async () => {
    const created = await api('POST', '/api/events', lead, make({
      starts_at: Date.now() - 10 * HOUR, daily_from: Date.now() - 9 * HOUR, min_ends_at: Date.now() - 3 * HOUR,
    }))
    await sample(2 * HOUR, 99_000)
    await sample(HOUR, 0)          // ← the end
    await sample(30 * 60_000, 0)
    expect(await current()).toBeNull()
    const row = await stack.db.query(
      `SELECT now() - ended_at AS ago FROM faction_events WHERE id = $1`, [created.body.id])
    // ⚠️ The DERIVED end — about an hour ago — not the moment of this request.
    const agoMs = (row.rows[0].ago.hours ?? 0) * HOUR + (row.rows[0].ago.minutes ?? 0) * 60_000
    expect(agoMs).toBeGreaterThan(50 * 60_000)
  })

  it('⚠️ once ended it STAYS ended when a new chain starts later', async () => {
    await api('POST', '/api/events', lead, make({
      starts_at: Date.now() - 10 * HOUR, daily_from: Date.now() - 9 * HOUR, min_ends_at: Date.now() - 3 * HOUR,
    }))
    await sample(2 * HOUR, 0)
    expect(await current()).toBeNull()       // stamped here
    await stack.db.query('DELETE FROM chain_samples')
    await sample(60_000, 1_200)               // an ordinary chain next week
    expect(await current()).toBeNull()
  })

  it('a chain reaching 100k ends it', async () => {
    await api('POST', '/api/events', lead, make({
      starts_at: Date.now() - 10 * HOUR, daily_from: Date.now() - 9 * HOUR, min_ends_at: Date.now() - 3 * HOUR,
    }))
    await sample(HOUR, 100_000)
    expect(await current()).toBeNull()
  })

  it('a lead marking the Chain Watch event ended wins', async () => {
    const ce = await stack.db.query(
      `INSERT INTO chain_events (title, starts_at, ends_at, actually_ended_at)
       VALUES ('Halloween chain', now() - interval '10 hours', now() + interval '1 day', now() - interval '1 hour')
       RETURNING id`)
    await api('POST', '/api/events', lead, make({
      starts_at: Date.now() - 10 * HOUR, daily_from: Date.now() - 9 * HOUR,
      min_ends_at: Date.now() - 3 * HOUR, chain_event_id: Number(ce.rows[0].id),
    }))
    await sample(30 * 60_000, 50_000)      // the sampler still sees a chain
    expect(await current()).toBeNull()
  })

  it('without ends_with_chain it ends exactly at the minimum', async () => {
    await api('POST', '/api/events', lead, make({
      starts_at: Date.now() - 10 * HOUR, daily_from: Date.now() - 9 * HOUR,
      min_ends_at: Date.now() - HOUR, ends_with_chain: false,
    }))
    await sample(10 * 60_000, 48_000)
    expect(await current()).toBeNull()
  })
})

describe('writing', () => {
  it('rejects a member who is not leadership', async () => {
    expect((await api('POST', '/api/events', member, make())).status).toBe(403)
  })

  it('rejects a colour that is not a hex', async () => {
    const res = await api('POST', '/api/events', lead, make({ theme_color: 'orange' }))
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/hex/)
  })

  it('turns a constraint violation into a message a lead can act on', async () => {
    const res = await api('POST', '/api/events', lead, make({ daily_from: Date.now() - 5 * HOUR }))
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/daily_from cannot be before starts_at/)
  })

  it('requires the times on create', async () => {
    const res = await api('POST', '/api/events', lead, { name: 'Halloween' })
    expect(res.status).toBe(400)
  })

  it('a lead can end it by hand', async () => {
    const created = await api('POST', '/api/events', lead, make())
    const res = await api('PATCH', `/api/events/${created.body.id}`, lead, { ended_at: 'now' })
    expect(res.status).toBe(200)
    expect(await current()).toBeNull()
  })

  it('a lead can rename and recolour it', async () => {
    const created = await api('POST', '/api/events', lead, make())
    await api('PATCH', `/api/events/${created.body.id}`, lead, { name: 'Halloween 2026', theme_color: '#ea580c' })
    const e = await current()
    expect(e.name).toBe('Halloween 2026')
    expect(e.theme_color).toBe('#ea580c')
  })

  it('a member cannot edit it', async () => {
    const created = await api('POST', '/api/events', lead, make())
    expect((await api('PATCH', `/api/events/${created.body.id}`, member, { name: 'x' })).status).toBe(403)
  })
})
