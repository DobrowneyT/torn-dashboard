// Competitions (#183): leaderboard standings computed from personalstats
// deltas over a fixed window, plus the leadership-gated create. Black-box HTTP
// against the real templated Postgres.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'
import { effectiveWindow, isDueToResolve, advanceNextResolve, runAutoResolve, qualifiedPool, drawWinner, resolveCompetition } from '../src/competitions.js'

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

  // ── #184: rolling windows + per-day-average reducer ──────────────────────

  it('effectiveWindow: fixed uses stored dates; rolling trails rolling_days from today', () => {
    expect(effectiveWindow({ metric_id: 'x', direction: 'desc', window_kind: 'fixed', window_start: '2026-07-01', window_end: '2026-07-07' }))
      .toEqual({ start: '2026-07-01', end: '2026-07-07' })
    const today = new Date('2026-07-23T12:00:00Z')
    expect(effectiveWindow({ metric_id: 'x', direction: 'desc', window_kind: 'rolling', rolling_days: 7 }, today))
      .toEqual({ start: '2026-07-16', end: '2026-07-23' })
  })

  it('per-day-average reducer divides the window delta by the window length', async () => {
    const created = await api('POST', '/api/competitions', leadershipToken, {
      name: 'Xanax per day', metric_id: 'xanax_taken', reducer: 'avg_per_day',
      window_start: '2026-07-01', window_end: '2026-07-07',
    })
    expect(created.status).toBe(201)
    expect(created.body.competition.reducer).toBe('avg_per_day')
    const res = await api('GET', `/api/competitions/${created.body.competition.id}`, memberToken)
    const byId = Object.fromEntries(res.body.standings.map((r: any) => [r.member_id, r]))
    // Ace delta 40 over a 6-day window → 6.67; Bea 15/6 → 2.5.
    expect(byId['10'].value).toBe(6.67)
    expect(byId['11'].value).toBe(2.5)
  })

  it('rolling window computes a live board over the trailing days', async () => {
    // CURRENT_DATE-relative seed, kept a few days inside a 10-day window so the
    // delta is robust to the ±1-day skew between Postgres's local CURRENT_DATE
    // and the UTC window boundary (both snapshots stay in-window either way).
    await stack.db.query(`INSERT INTO members (member_id, member_name, is_current) VALUES ('20','Rolla',true) ON CONFLICT (member_id) DO NOTHING`)
    await stack.db.query(`
      INSERT INTO member_daily_stats (member_id, snapshot_date, personalstats) VALUES
        ('20', CURRENT_DATE - 8, '{"drugs":{"xantaken":100}}'),
        ('20', CURRENT_DATE - 2, '{"drugs":{"xantaken":130}}')
      ON CONFLICT (member_id, snapshot_date) DO NOTHING
    `)
    const created = await api('POST', '/api/competitions', leadershipToken, {
      name: 'Rolling xanax', metric_id: 'xanax_taken', window_kind: 'rolling', rolling_days: 10,
    })
    expect(created.status).toBe(201)
    const res = await api('GET', `/api/competitions/${created.body.competition.id}`, memberToken)
    const rolla = res.body.standings.find((r: any) => r.member_id === '20')
    expect(rolla).toBeTruthy()
    expect(rolla.value).toBe(30)
  })

  it('rejects rolling without a valid rolling_days, and a reducer the metric does not support', async () => {
    expect((await api('POST', '/api/competitions', leadershipToken, {
      name: 'bad rolling', metric_id: 'xanax_taken', window_kind: 'rolling', rolling_days: 0,
    })).status).toBe(400)
    expect((await api('POST', '/api/competitions', leadershipToken, {
      name: 'bad reducer', metric_id: 'xanax_taken', reducer: 'median',
      window_start: '2026-07-01', window_end: '2026-07-07',
    })).status).toBe(400)
  })

  // ── #185: resolve → history ──────────────────────────────────────────────

  async function createFixedXanax(name: string) {
    const c = await api('POST', '/api/competitions', leadershipToken, {
      name, metric_id: 'xanax_taken', window_start: '2026-07-01', window_end: '2026-07-07',
    })
    return c.body.competition.id
  }

  it('resolving materialises the standings and crowns the top-ranked member', async () => {
    const id = await createFixedXanax('Resolve me')
    const resolve = await api('POST', `/api/competitions/${id}/resolve`, leadershipToken)
    expect(resolve.status).toBe(200)
    expect(resolve.body.resolution_seq).toBe(1)
    expect(resolve.body.winner.member_id).toBe('10') // Ace, delta 40
    expect(resolve.body.member_count).toBe(3)

    const history = await api('GET', `/api/competitions/${id}/history`, memberToken)
    expect(history.body.resolutions).toHaveLength(1)
    const r = history.body.resolutions[0]
    expect(r.winner.member_id).toBe('10')
    expect(r.standings).toHaveLength(3)
    // Frozen standings carry their own value/rank (self-contained).
    expect(r.standings.find((s: any) => s.member_id === '10').value).toBe(40)
  })

  it('members cannot resolve; resolving an empty window is refused', async () => {
    const id = await createFixedXanax('No touchy')
    expect((await api('POST', `/api/competitions/${id}/resolve`, memberToken)).status).toBe(403)

    const empty = await api('POST', '/api/competitions', leadershipToken, {
      name: 'Empty window', metric_id: 'xanax_taken', window_start: '2020-01-01', window_end: '2020-01-02',
    })
    expect((await api('POST', `/api/competitions/${empty.body.competition.id}/resolve`, leadershipToken)).status).toBe(409)
  })

  it('a competition can be resolved repeatedly, each resolution its own history row', async () => {
    const id = await createFixedXanax('Repeat resolve')
    await api('POST', `/api/competitions/${id}/resolve`, leadershipToken)
    const second = await api('POST', `/api/competitions/${id}/resolve`, leadershipToken)
    expect(second.body.resolution_seq).toBe(2)
    const history = await api('GET', `/api/competitions/${id}/history`, memberToken)
    expect(history.body.resolutions.map((r: any) => r.resolution_seq)).toEqual([2, 1])
  })

  // ── #186: auto-scheduling ────────────────────────────────────────────────

  it('isDueToResolve gates on auto_resolve, a passed fixed end day, and rolling next_resolve_at', () => {
    const base = { metric_id: 'xanax_taken', direction: 'desc' }
    expect(isDueToResolve({ ...base, auto_resolve: false, window_kind: 'fixed', window_end: '2000-01-01' }, new Date('2020-01-01T00:00:00Z'))).toBe(false)
    expect(isDueToResolve({ ...base, auto_resolve: true, window_kind: 'fixed', window_end: '2000-01-01' }, new Date('2000-01-02T00:00:00Z'))).toBe(true)
    // Same day as the end date is not "strictly after" → not yet due.
    expect(isDueToResolve({ ...base, auto_resolve: true, window_kind: 'fixed', window_end: '2000-01-02' }, new Date('2000-01-02T12:00:00Z'))).toBe(false)
    expect(isDueToResolve({ ...base, auto_resolve: true, window_kind: 'rolling', next_resolve_at: '2999-01-01' }, new Date())).toBe(false)
    expect(isDueToResolve({ ...base, auto_resolve: true, window_kind: 'rolling', next_resolve_at: '2000-01-01' }, new Date())).toBe(true)
  })

  it('advanceNextResolve skips intervals missed while down, landing just past now', () => {
    const dayMs = 86_400_000
    const from = new Date('2026-01-01T00:00:00Z')
    const now = new Date('2026-03-15T00:00:00Z')
    const next = advanceNextResolve(from, 30, now)
    expect(next.getTime()).toBeGreaterThan(now.getTime())
    expect(next.getTime() - now.getTime()).toBeLessThanOrEqual(30 * dayMs)
    expect(((next.getTime() - from.getTime()) / dayMs) % 30).toBe(0)
  })

  it('runAutoResolve closes a due fixed competition exactly once', async () => {
    const c = await api('POST', '/api/competitions', leadershipToken, {
      name: 'Auto fixed', metric_id: 'xanax_taken', auto_resolve: true,
      window_start: '2026-07-01', window_end: '2026-07-07',
    })
    const id = c.body.competition.id
    await runAutoResolve(stack.db)
    let hist = await api('GET', `/api/competitions/${id}/history`, memberToken)
    expect(hist.body.resolutions).toHaveLength(1)
    expect(hist.body.resolutions[0].winner.member_id).toBe('10')
    // A second tick does not re-resolve a fixed competition.
    await runAutoResolve(stack.db)
    hist = await api('GET', `/api/competitions/${id}/history`, memberToken)
    expect(hist.body.resolutions).toHaveLength(1)
  })

  it('runAutoResolve draws a due rolling competition and advances its next_resolve_at', async () => {
    const c = await api('POST', '/api/competitions', leadershipToken, {
      name: 'Auto rolling', metric_id: 'xanax_taken', window_kind: 'rolling',
      rolling_days: 10, auto_resolve: true, resolve_interval_days: 7,
    })
    const id = c.body.competition.id
    // Force it due by moving the next-resolution time into the past.
    await stack.db.query(`UPDATE competitions SET next_resolve_at = now() - interval '1 day' WHERE id = $1`, [id])
    await runAutoResolve(stack.db)
    const hist = await api('GET', `/api/competitions/${id}/history`, memberToken)
    expect(hist.body.resolutions).toHaveLength(1)
    // next_resolve_at advanced into the future (compared in SQL to avoid JS
    // parsing of Postgres's timestamptz text form).
    const row = await stack.db.query('SELECT next_resolve_at > now() AS future FROM competitions WHERE id = $1', [id])
    expect(row.rows[0].future).toBe(true)
    // Not due again on the very next tick.
    await runAutoResolve(stack.db)
    const hist2 = await api('GET', `/api/competitions/${id}/history`, memberToken)
    expect(hist2.body.resolutions).toHaveLength(1)
  })

  // ── #187: lottery type + random draw ─────────────────────────────────────

  it('qualifiedPool filters by comparator; drawWinner picks within the pool', () => {
    const s = [{ member_id: 'a', value: 40 }, { member_id: 'b', value: 15 }, { member_id: 'c', value: 0 }] as any
    expect(qualifiedPool(s, 'gte', 10).map((x: any) => x.member_id)).toEqual(['a', 'b'])
    expect(qualifiedPool(s, 'lte', 15).map((x: any) => x.member_id)).toEqual(['b', 'c'])
    expect(drawWinner(['x', 'y', 'z'], () => 0)).toBe('x')
    expect(drawWinner(['x', 'y', 'z'], () => 0.99)).toBe('z')
  })

  it('lottery requires a valid threshold', async () => {
    expect((await api('POST', '/api/competitions', leadershipToken, {
      name: 'bad comparator', type: 'lottery', metric_id: 'xanax_taken',
      window_start: '2026-07-01', window_end: '2026-07-07', threshold_comparator: 'bogus', threshold_value: 5,
    })).status).toBe(400)
    expect((await api('POST', '/api/competitions', leadershipToken, {
      name: 'nan threshold', type: 'lottery', metric_id: 'xanax_taken',
      window_start: '2026-07-01', window_end: '2026-07-07', threshold_comparator: 'gte', threshold_value: 'abc',
    })).status).toBe(400)
  })

  it('lottery flags the qualified pool and draws it at random', async () => {
    const c = await api('POST', '/api/competitions', leadershipToken, {
      name: 'Xanax lottery', type: 'lottery', metric_id: 'xanax_taken', reducer: 'total',
      threshold_comparator: 'gte', threshold_value: 10,
      window_start: '2026-07-01', window_end: '2026-07-07',
    })
    expect(c.status).toBe(201)
    const id = c.body.competition.id

    // Detail flags who qualifies (Ace 40, Bea 15 qualify; Dan 0 does not).
    const detail = await api('GET', `/api/competitions/${id}`, memberToken)
    const byId = Object.fromEntries(detail.body.standings.map((r: any) => [r.member_id, r]))
    expect(byId['10'].qualified).toBe(true)
    expect(byId['11'].qualified).toBe(true)
    expect(byId['13'].qualified).toBe(false)

    // Deterministic draw: rng→1.98 picks pool index 1 (Bea) of [Ace, Bea].
    const row = (await stack.db.query('SELECT * FROM competitions WHERE id = $1', [id])).rows[0]
    const result = await resolveCompetition(stack.db, row, 'test', () => 0.99)
    expect(result!.winner!.member_id).toBe('11')
    // History records only the pool (2 members), winner flagged.
    const hist = await api('GET', `/api/competitions/${id}/history`, memberToken)
    expect(hist.body.resolutions[0].standings).toHaveLength(2)
    expect(hist.body.resolutions[0].winner.member_id).toBe('11')
  })

  it('a lottery with no qualifiers resolves to nothing (409)', async () => {
    const c = await api('POST', '/api/competitions', leadershipToken, {
      name: 'Impossible lottery', type: 'lottery', metric_id: 'xanax_taken',
      threshold_comparator: 'gte', threshold_value: 100000,
      window_start: '2026-07-01', window_end: '2026-07-07',
    })
    expect((await api('POST', `/api/competitions/${c.body.competition.id}/resolve`, leadershipToken)).status).toBe(409)
  })

  // ── #188: dashboard pins ─────────────────────────────────────────────────

  it('leadership pins a competition; the pinned feed returns compact standings; members cannot pin', async () => {
    const id = await createFixedXanax('Pin me')
    expect((await api('PUT', `/api/competitions/${id}/pin`, memberToken, { pinned: true })).status).toBe(403)

    const pin = await api('PUT', `/api/competitions/${id}/pin`, leadershipToken, { pinned: true })
    expect(pin.status).toBe(200)
    expect(pin.body.competition.pinned).toBe(true)

    const feed = await api('GET', '/api/competitions/pinned', memberToken)
    const found = feed.body.competitions.find((c: any) => c.id === id)
    expect(found).toBeTruthy()
    expect(found.top[0].member_id).toBe('10') // Ace leads the compact board

    // Unpin removes it from the feed.
    await api('PUT', `/api/competitions/${id}/pin`, leadershipToken, { pinned: false })
    const feed2 = await api('GET', '/api/competitions/pinned', memberToken)
    expect(feed2.body.competitions.find((c: any) => c.id === id)).toBeFalsy()
  })

  it('a pinned lottery reports its qualified count', async () => {
    const c = await api('POST', '/api/competitions', leadershipToken, {
      name: 'Pinned lottery', type: 'lottery', metric_id: 'xanax_taken',
      threshold_comparator: 'gte', threshold_value: 10,
      window_start: '2026-07-01', window_end: '2026-07-07',
    })
    const id = c.body.competition.id
    await api('PUT', `/api/competitions/${id}/pin`, leadershipToken, { pinned: true })
    const feed = await api('GET', '/api/competitions/pinned', memberToken)
    const found = feed.body.competitions.find((x: any) => x.id === id)
    expect(found.qualified_count).toBe(2) // Ace (40) + Bea (15) qualify
    await api('PUT', `/api/competitions/${id}/pin`, leadershipToken, { pinned: false })
  })
})
