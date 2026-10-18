// #965 — event bingo end to end against real Postgres.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, TEST_KEY_ENCRYPTION_KEY, type TestStack } from './harness.js'
import { createKeyPool } from '../src/scraper/keyPool.js'
import { createTornClient } from '../src/scraper/tornClient.js'
import { eventBingoJob } from '../src/scraper/jobs/eventBingo.js'

let stack: TestStack
let member: string
let other: string
let lead: string
let eventId: number
const HOUR = 3_600_000
const US = Number(TEST_FACTION.tornFactionId)
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64')

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
  let body: any = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { status: res.status, body }
}

const deps = () => ({
  db: stack.db,
  pool: createKeyPool({ db: stack.db, encryptionKey: TEST_KEY_ENCRYPTION_KEY }),
  client: createTornClient({ baseUrl: stack.tornBaseUrl }),
}) as any

const card = (over: Record<string, unknown> = {}) => ({
  enabled: true, rows: 2, cols: 2,
  grid: { left: 5, top: 10, right: 95, bottom: 90 },
  tiles: [
    { idx: 0, label: 'Send a gift', kind: 'proof' },
    { idx: 1, label: 'Over 10 respect', kind: 'auto', rule: 'respect_over_10' },
    { idx: 2, label: 'Free', kind: 'free' },
    { idx: 3, label: 'Chain watch', kind: 'auto', rule: 'chain_watch' },
  ],
  ...over,
})

beforeAll(async () => {
  stack = await startTestStack()
  await stack.db.query(`INSERT INTO role_assignments (torn_user_id, role) VALUES (7201, 'leadership')`)
  await stack.db.query(`INSERT INTO members (member_id, member_name, tier, is_current) VALUES
    ('7200', 'Pumpkin', 3, true), ('7202', 'Ghost', 3, true) ON CONFLICT (member_id) DO NOTHING`)
  member = await loginAs('BINGOMEMBER7200XX', '7200')
  other = await loginAs('BINGOOTHER7202XXX', '7202')
  lead = await loginAs('BINGOLEADER7201XX', '7201')
}, 30_000)

afterAll(async () => { await stack?.close() })

beforeEach(async () => {
  await stack.db.query('DELETE FROM faction_events')
  await stack.db.query('DELETE FROM faction_attacks')
  const { rows } = await stack.db.query(
    `INSERT INTO faction_events (name, starts_at, daily_from, min_ends_at)
     VALUES ('Halloween', now() - interval '2 hours', now() - interval '1 hour', now() + interval '1 day')
     RETURNING id`)
  eventId = Number(rows[0].id)
})

describe('setting the card up', () => {
  it('is leadership only, and members see nothing until it is on', async () => {
    expect((await api('PUT', `/api/events/${eventId}/bingo`, member, card())).status).toBe(403)
    expect((await api('GET', `/api/events/${eventId}/bingo`, member)).status).toBe(404)
    const saved = await api('PUT', `/api/events/${eventId}/bingo`, lead, card())
    expect(saved.status).toBe(200)
    expect(saved.body).toMatchObject({ enabled: true, rows: 2, cols: 2, grid: { left: 5, bottom: 90 } })
    expect(saved.body.tiles).toHaveLength(4)
    expect((await api('GET', '/api/events/current', member)).body.event.bingo_enabled).toBe(true)
  })

  it('refuses an automatic square with no rule', async () => {
    const r = await api('PUT', `/api/events/${eventId}/bingo`, lead, card({
      tiles: [{ idx: 0, label: 'x', kind: 'auto', rule: 'made_up' }] }))
    expect(r.status).toBe(400)
  })

  it('takes a card image and serves it back', async () => {
    await api('PUT', `/api/events/${eventId}/bingo`, lead, card())
    const up = await api('PUT', `/api/events/${eventId}/bingo/image`, lead, { content_type: 'image/png', data_base64: PNG })
    expect(up.body.image_url).toMatch(/\/bingo\/image\?v=/)
    const res = await fetch(`${stack.baseUrl}/api/events/${eventId}/bingo/image`, { headers: { authorization: `Bearer ${member}` } })
    expect(res.headers.get('content-type')).toBe('image/png')
  })

  it('offers the Halloween template', async () => {
    const t = await api('GET', `/api/events/${eventId}/bingo/template`, lead)
    expect(t.body.tiles).toHaveLength(t.body.rows * t.body.cols)
  })
})

describe('proof and review', () => {
  beforeEach(async () => { await api('PUT', `/api/events/${eventId}/bingo`, lead, card()) })

  it('a member asks with proof, leadership approves, and it crosses', async () => {
    expect((await api('POST', `/api/events/${eventId}/bingo/marks`, member, { idx: 0 })).status).toBe(400)
    const asked = await api('POST', `/api/events/${eventId}/bingo/marks`, member, {
      idx: 0, proof_text: 'You sent a Pumpkin to Ghost', proof_image_base64: PNG, proof_image_type: 'image/png' })
    expect(asked.status).toBe(201)
    expect(asked.body).toMatchObject({ status: 'pending', source: 'proof', has_image: true })
    expect((await api('POST', `/api/events/${eventId}/bingo/marks`, member, { idx: 0, proof_text: 'again' })).status).toBe(409)

    const queue = await api('GET', `/api/events/${eventId}/bingo/reviews`, lead)
    expect(queue.body.marks[0]).toMatchObject({ member_name: 'Pumpkin', proof_text: 'You sent a Pumpkin to Ghost' })
    expect((await api('GET', `/api/events/${eventId}/bingo/reviews`, member)).status).toBe(403)

    // Only the sender and leadership see the screenshot.
    const img = `/api/events/${eventId}/bingo/marks/${asked.body.id}/image`
    expect((await api('GET', img, other)).status).toBe(404)
    expect((await api('GET', img, lead)).status).toBe(200)

    const ok = await api('PATCH', `/api/events/${eventId}/bingo/marks/${asked.body.id}`, lead, { decision: 'approved' })
    expect(ok.body.status).toBe('approved')
    expect((await api('PATCH', `/api/events/${eventId}/bingo/marks/${asked.body.id}`, lead, { decision: 'rejected' })).status).toBe(409)

    const mine = await api('GET', `/api/events/${eventId}/bingo`, member)
    expect(mine.body.marks.find((m: any) => m.idx === 0).status).toBe('approved')
    expect(mine.body.standings[0]).toMatchObject({ member_id: '7200', squares: 1 })
  })

  it('a rejected request can be asked again; a member cannot cross for someone else', async () => {
    const a = await api('POST', `/api/events/${eventId}/bingo/marks`, member, { idx: 0, proof_text: 'x' })
    await api('PATCH', `/api/events/${eventId}/bingo/marks/${a.body.id}`, lead, { decision: 'rejected', note: 'No gift in the log' })
    expect((await api('POST', `/api/events/${eventId}/bingo/marks`, member, { idx: 0, proof_text: 'y' })).status).toBe(201)
    expect((await api('POST', `/api/events/${eventId}/bingo/marks`, member, { idx: 0, member_id: '7202' })).status).toBe(403)
  })

  it('leadership can cross a square for a member directly, and see their card', async () => {
    const r = await api('POST', `/api/events/${eventId}/bingo/marks`, lead, { idx: 0, member_id: '7202' })
    expect(r.body).toMatchObject({ status: 'approved', source: 'council' })
    const card7202 = await api('GET', `/api/events/${eventId}/bingo?member=7202`, lead)
    expect(card7202.body.member.member_id).toBe('7202')
    // A member asking for someone else's card gets their own.
    expect((await api('GET', `/api/events/${eventId}/bingo?member=7202`, member)).body.member.member_id).toBe('7200')
  })
})

describe('automatic squares', () => {
  beforeEach(async () => { await api('PUT', `/api/events/${eventId}/bingo`, lead, card()) })

  it('crosses from the data, and approves a waiting request it confirms', async () => {
    const now = Math.floor(Date.now() / 1000)
    await stack.db.query(
      `INSERT INTO faction_attacks (attack_id, started, attacker_id, attacker_faction_id, defender_id, respect_gain, chain)
       VALUES (1, $1, 7200, $2, 1, 12.5, 37), (2, $1, 7202, $2, 1, 30, 50), (3, $1 - 86400, 7202, $2, 1, 20, 3)`,
      [now - 600, US])
    // 7202's only qualifying hit is a bonus (chain 50) or before the event.
    const pending = await api('POST', `/api/events/${eventId}/bingo/marks`, member, { idx: 1, proof_text: 'big hit' })
    const res = await eventBingoJob(deps())
    expect(res.details).toMatchObject({ confirmed: 1, crossed: 0 })
    const mark = (await stack.db.query('SELECT status, evidence FROM event_bingo_marks WHERE id = $1', [pending.body.id])).rows[0]
    expect(mark.status).toBe('approved')
    expect(mark.evidence).toMatchObject({ attack_id: 1 })
    expect((await stack.db.query(`SELECT count(*)::int AS n FROM event_bingo_marks WHERE member_id = '7202'`)).rows[0].n).toBe(0)

    // Idempotent.
    expect((await eventBingoJob(deps())).details).toMatchObject({ confirmed: 0, crossed: 0 })
  })

  it('every rule runs against the real schema', async () => {
    const all = ['ranked_war_attack', 'respect_over_10', 'repeating_chain', 'hit_over_10000', 'hit_1310_1340',
      'mugged_for_1', 'bounties_over_50', 'chain_watch', 'travel']
    await api('PUT', `/api/events/${eventId}/bingo`, lead, card({
      rows: 3, cols: 3, tiles: all.map((rule, idx) => ({ idx, label: rule, kind: 'auto', rule })) }))
    const res = await eventBingoJob(deps())
    expect(res.details).toMatchObject({ events: 1 })
  })
})
