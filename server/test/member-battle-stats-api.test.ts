// Battle-stats read path (#348): war-lead gate, and the route-ordering trap.
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

async function get(path: string, as?: string) {
  const res = await fetch(`${stack.baseUrl}${path}`, {
    headers: as ? { authorization: `Bearer ${tokens[as]}` } : {},
  })
  return { status: res.status, body: (await res.json().catch(() => null)) as any }
}

beforeAll(async () => {
  stack = await startTestStack()
  await stack.db.query(
    `INSERT INTO members (member_id, member_name, tier, is_current) VALUES
       ('1800','Lead',2,true), ('1801','Grunt',2,true),
       ('1802','Boss',2,true), ('1803','Guest',2,true), ('1804','Gone',2,false)`
  )
  await loginAs('warlead', '1800', ['warlead'])
  await loginAs('member', '1801', [])
  await loginAs('leadership', '1802', ['leadership'])
  await loginAs('visitor', '1803', ['visitor'])

  await stack.db.query(
    `INSERT INTO member_battle_stats
       (member_id, strength, defense, speed, dexterity, total, source, fetched_at)
     VALUES (1800, 1000, 2000, 3000, 4000, 10000, 'torn', now()),
            (1801, 10, 20, 30, 40, 100, 'bsp', now()),
            (1804, 5, 5, 5, 5, 20, 'torn', now())`
  )
})

afterAll(async () => { await stack?.close() })

describe('GET /api/members/battle-stats — war-lead gate', () => {
  it('gives a war lead the stats, best first', () => {
    // Ordering matters for the intended use: who can we field.
    return get('/api/members/battle-stats', 'warlead').then(({ status, body }) => {
      expect(status).toBe(200)
      expect(body.battle_stats.map((r: any) => Number(r.member_id))).toEqual([1800, 1801])
      expect(body.battle_stats[0]).toMatchObject({ total: 10000, source: 'torn' })
    })
  })

  it('gives leadership the stats too', async () => {
    expect((await get('/api/members/battle-stats', 'leadership')).status).toBe(200)
  })

  it('refuses an ordinary member', async () => {
    // The reason this lives in its own table with its own guard: battle stats
    // decide who can hit whom, and /api/members is read by every view.
    expect((await get('/api/members/battle-stats', 'member')).status).toBe(403)
  })

  it('refuses a visitor', async () => {
    expect((await get('/api/members/battle-stats', 'visitor')).status).toBe(403)
  })

  it('refuses an unauthenticated caller', async () => {
    expect((await get('/api/members/battle-stats')).status).toBe(401)
  })

  it('leaks no figure to a member who is refused', async () => {
    const { body } = await get('/api/members/battle-stats', 'member')
    expect(JSON.stringify(body)).not.toContain('10000')
  })

  it('excludes members who have left the faction', async () => {
    // 1804 has stats on file but is_current = false.
    const { body } = await get('/api/members/battle-stats', 'warlead')
    expect(body.battle_stats.map((r: any) => Number(r.member_id))).not.toContain(1804)
  })

  it('does not get swallowed by the /api/members/:id route', async () => {
    // Registration order puts :id first, so this asserts Fastify prefers the
    // static segment — otherwise the guard would be bypassed entirely and the
    // handler would look up a member literally named "battle-stats".
    const { status, body } = await get('/api/members/battle-stats', 'warlead')
    expect(status).toBe(200)
    expect(body).toHaveProperty('battle_stats')
    expect(body).not.toHaveProperty('member')
  })

  it('still serves /api/members/:id for a real id', async () => {
    const { status } = await get('/api/members/1801', 'member')
    expect(status).toBe(200)
  })
})

describe('GET /api/members/revive-history (#358)', () => {
  const nowSec = () => Math.floor(Date.now() / 1000)

  beforeAll(async () => {
    await stack.db.query(
      `INSERT INTO faction_revives
         (revive_id, "timestamp", reviver_id, reviver_name, reviver_skill,
          target_id, target_name, success_chance, result)
       VALUES
         (20001, ${nowSec() - 3600},      900, 'Medic', 96.40, 1800, 'Lead',  92.50, 'success'),
         (20002, ${nowSec() - 40 * 3600}, 901, 'Doc',   50.00, 1801, 'Grunt', 88.00, 'failure'),
         (20003, ${nowSec() - 80 * 3600}, 902, 'Old',   10.00, 1800, 'Lead',  90.00, 'success')`
    )
  })

  it('returns the 48-hour window with what the model needs', async () => {
    const { status, body } = await get('/api/members/revive-history', 'warlead')
    expect(status).toBe(200)
    const ids = body.revives.map((r: any) => Number(r.revive_id))
    expect(ids).toContain(20001)
    // Beyond 24h but inside 48h: worth nothing to the score, and kept anyway
    // as prior history so the model check isn't biased by a truncated window.
    expect(ids).toContain(20002)
    // Older than the window entirely.
    expect(ids).not.toContain(20003)
  })

  it('carries the reviver skill and observed chance the model is checked against', async () => {
    const { body } = await get('/api/members/revive-history', 'warlead')
    const row = body.revives.find((r: any) => Number(r.revive_id) === 20001)
    // Postgres numerics arrive as strings; the client's reading() guard
    // handles that, but the values themselves must survive the round trip.
    expect(Number(row.reviver_skill)).toBe(96.4)
    expect(Number(row.success_chance)).toBe(92.5)
    expect(row.result).toBe('success')
  })

  it('reports the window it actually covers rather than leaving it assumed', async () => {
    const { body } = await get('/api/members/revive-history', 'warlead')
    expect(body.server_now - body.window_start).toBe(48 * 3600)
  })

  it('is newest first', async () => {
    const { body } = await get('/api/members/revive-history', 'warlead')
    const stamps = body.revives.map((r: any) => Number(r.timestamp))
    expect([...stamps].sort((a, b) => b - a)).toEqual(stamps)
  })

  it('is gated to war leads and above', async () => {
    // Same reasoning as battle stats: this says who keeps getting hospitalised
    // and how hard they are to get back up.
    expect((await get('/api/members/revive-history', 'leadership')).status).toBe(200)
    expect((await get('/api/members/revive-history', 'member')).status).toBe(403)
    expect((await get('/api/members/revive-history', 'visitor')).status).toBe(403)
    expect((await get('/api/members/revive-history')).status).toBe(401)
  })

  it('is not swallowed by the /api/members/:id route', async () => {
    const { body } = await get('/api/members/revive-history', 'warlead')
    expect(body).toHaveProperty('revives')
    expect(body).not.toHaveProperty('member')
  })
})
