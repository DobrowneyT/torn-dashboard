// Competitions (#183): leaderboard standings computed from personalstats
// deltas over a fixed window, plus the leadership-gated create. Black-box HTTP
// against the real templated Postgres.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'

let stack: TestStack
let leadershipToken: string
let memberToken: string

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
    headers: { authorization: `Bearer ${token}`, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

// Xanax-taken competition over 2026-07-01..07-07 with a spread of members:
//  Ace   — full window: 100 -> 140 (delta 40); also snapshots OUTSIDE the
//          window (06-25=50, 07-10=200) that must NOT move the baseline/end.
//  Bea   — joined mid-window: first in-window snapshot 07-03 (delta 15, partial).
//  Cal   — has data but is_current = false: excluded from the board.
//  Dan   — a single in-window snapshot: delta 0, partial (baseline after open).
//  Eve   — personalstats missing the metric path: excluded (never miscounted).
async function seedStandingsFixture() {
  await stack.db.query(`
    INSERT INTO members (member_id, member_name, is_current) VALUES
      ('10','Ace',true),('11','Bea',true),('12','Cal',false),('13','Dan',true),('14','Eve',true)
    ON CONFLICT (member_id) DO NOTHING
  `)
  await stack.db.query(`
    INSERT INTO member_daily_stats (member_id, snapshot_date, personalstats) VALUES
      ('10','2026-06-25','{"drugs":{"xantaken":50}}'),
      ('10','2026-07-01','{"drugs":{"xantaken":100}}'),
      ('10','2026-07-07','{"drugs":{"xantaken":140}}'),
      ('10','2026-07-10','{"drugs":{"xantaken":200}}'),
      ('11','2026-07-03','{"drugs":{"xantaken":10}}'),
      ('11','2026-07-07','{"drugs":{"xantaken":25}}'),
      ('12','2026-07-01','{"drugs":{"xantaken":0}}'),
      ('12','2026-07-07','{"drugs":{"xantaken":999}}'),
      ('13','2026-07-05','{"drugs":{"xantaken":5}}'),
      ('14','2026-07-01','{"medical":{"revives":3}}'),
      ('14','2026-07-07','{"medical":{"revives":9}}')
    ON CONFLICT (member_id, snapshot_date) DO NOTHING
  `)
}

beforeAll(async () => {
  stack = await startTestStack()
  await stack.db.query(`INSERT INTO role_assignments (torn_user_id, role) VALUES (9100, 'leadership')`)
  leadershipToken = await loginAs('COMPLEAD9100XXXX', '9100')
  memberToken = await loginAs('COMPMEMBER9200XX', '9200')
  await seedStandingsFixture()
}, 30000)

afterAll(async () => { await stack?.close() })

describe('competitions (#183)', () => {
  it('exposes the curated metric shortlist for the create form', async () => {
    const res = await api('GET', '/api/competitions/metrics', memberToken)
    expect(res.status).toBe(200)
    const ids = res.body.metrics.map((m: any) => m.id)
    expect(ids).toContain('xanax_taken')
    // No internal path leaks to the client.
    expect(res.body.metrics[0]).not.toHaveProperty('path')
  })

  it('leadership creates a leaderboard competition; members and visitors cannot', async () => {
    const good = await api('POST', '/api/competitions', leadershipToken, {
      name: 'July Xanax Grind', metric_id: 'xanax_taken',
      window_start: '2026-07-01', window_end: '2026-07-07',
    })
    expect(good.status).toBe(201)
    expect(good.body.competition.name).toBe('July Xanax Grind')
    expect(good.body.competition.direction).toBe('desc')

    const forbidden = await api('POST', '/api/competitions', memberToken, {
      name: 'nope', metric_id: 'xanax_taken', window_start: '2026-07-01', window_end: '2026-07-07',
    })
    expect(forbidden.status).toBe(403)
  })

  it('rejects an unknown metric, a backwards window, and a missing name', async () => {
    expect((await api('POST', '/api/competitions', leadershipToken, {
      name: 'x', metric_id: 'not_a_metric', window_start: '2026-07-01', window_end: '2026-07-07',
    })).status).toBe(400)
    expect((await api('POST', '/api/competitions', leadershipToken, {
      name: 'x', metric_id: 'xanax_taken', window_start: '2026-07-07', window_end: '2026-07-01',
    })).status).toBe(400)
    expect((await api('POST', '/api/competitions', leadershipToken, {
      name: '   ', metric_id: 'xanax_taken', window_start: '2026-07-01', window_end: '2026-07-07',
    })).status).toBe(400)
  })

  it('computes a live leaderboard: window-clipped deltas, partial flags, is_current filter, null-path skip', async () => {
    const created = await api('POST', '/api/competitions', leadershipToken, {
      name: 'Standings Xanax', metric_id: 'xanax_taken',
      window_start: '2026-07-01', window_end: '2026-07-07',
    })
    const id = created.body.competition.id
    const res = await api('GET', `/api/competitions/${id}`, memberToken)
    expect(res.status).toBe(200)

    const board = res.body.standings
    // Cal (not current) and Eve (no metric path) are absent.
    expect(board.map((r: any) => r.member_id).sort()).toEqual(['10', '11', '13'])

    const byId = Object.fromEntries(board.map((r: any) => [r.member_id, r]))
    // Ace: 140 - 100 = 40, ignoring the out-of-window 50 and 200. Full window.
    expect(byId['10'].value).toBe(40)
    expect(byId['10'].partial).toBe(false)
    // Bea: 25 - 10 = 15, and flagged partial (first snapshot 07-03 > 07-01).
    expect(byId['11'].value).toBe(15)
    expect(byId['11'].partial).toBe(true)
    // Dan: one snapshot → delta 0, partial.
    expect(byId['13'].value).toBe(0)
    expect(byId['13'].partial).toBe(true)

    // Highest-wins order + ranks.
    expect(board.map((r: any) => r.member_id)).toEqual(['10', '11', '13'])
    expect(board.map((r: any) => r.rank)).toEqual([1, 2, 3])
  })

  it('honors direction=asc (lowest-wins)', async () => {
    const created = await api('POST', '/api/competitions', leadershipToken, {
      name: 'Fewest Xanax', metric_id: 'xanax_taken', direction: 'asc',
      window_start: '2026-07-01', window_end: '2026-07-07',
    })
    const res = await api('GET', `/api/competitions/${created.body.competition.id}`, memberToken)
    expect(res.body.standings.map((r: any) => r.member_id)).toEqual(['13', '11', '10'])
  })

  it('lists created competitions and 404s an unknown id', async () => {
    const list = await api('GET', '/api/competitions', memberToken)
    expect(list.status).toBe(200)
    expect(list.body.competitions.length).toBeGreaterThan(0)
    expect((await api('GET', '/api/competitions/99999', memberToken)).status).toBe(404)
  })
})
