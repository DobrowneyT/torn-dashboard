// GET /api/faction/upgrades (#458): black-box HTTP against the templated Postgres.
//
// The theme: this endpoint's only job is to say which half of the perk tree is
// actually doing something. Everything asserted below is about that split
// surviving the round trip — and about the empty state, because a faction that
// has just joined the stack has no snapshot until the job next runs and must
// not see an error.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'

let stack: TestStack
let token: string

async function loginAs(key: string, id: string) {
  stack.torn.addKey(key, { id, factionId: TEST_FACTION.tornFactionId })
  const res = await fetch(`${stack.baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey: key }),
  })
  expect(res.status).toBe(200)
  return ((await res.json()) as any).token as string
}

const get = async (path: string, tok?: string) => {
  const res = await fetch(`${stack.baseUrl}${path}`, {
    headers: tok ? { authorization: `Bearer ${tok}` } : {},
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

// The live forge shape, 2026-10-03.
const PAYLOAD = {
  state: 'peace',
  upgrades: {
    core: { upgrades: [{ id: 1, cost: 1000, name: 'Weapon armory', level: 1, ability: 'Unlocks weapon armory', unlocked_at: 1484661886 }] },
    peace: [{ name: 'Steadfast', order: 4, multiplier: 8, upgrades: [
      { id: 38, cost: 11279, name: 'Defense training XVI', level: 16, ability: 'Increases defense gym gains by 16%', unlocked_at: 1790812804 },
    ] }],
    war: [{ name: 'Suppression', order: 2, multiplier: 4, upgrades: [
      { id: 50, cost: 500, name: 'Ambush', level: 1, ability: 'war only', unlocked_at: 1700000000 },
    ] }],
  },
}

beforeAll(async () => { stack = await startTestStack(); token = await loginAs('FUPGRADE1234XXXX', '8200') })
afterAll(async () => { await stack?.close() })

describe('GET /api/faction/upgrades', () => {
  it('⚠️ renders an empty state, not an error, before the job has ever run', async () => {
    // A 404 or a 500 here would make a brand-new tenant look broken when it is
    // merely waiting for 02:10.
    await stack.db.query('DELETE FROM faction_upgrade_snapshots')
    const { status, body } = await get('/api/faction/upgrades', token)
    expect(status).toBe(200)
    expect(body).toMatchObject({ snapshotDate: null, fetchedMs: null, state: null, active: [], inactive: [], core: [] })
  })

  it('requires a session', async () => {
    const { status } = await get('/api/faction/upgrades')
    expect(status).toBe(401)
  })

  it('splits active from inactive and carries Torn\'s own ability text', async () => {
    await stack.db.query(
      `INSERT INTO faction_upgrade_snapshots (snapshot_date, branch_state, payload)
       VALUES ('2026-10-03', 'peace', $1)
       ON CONFLICT (snapshot_date) DO UPDATE SET payload = EXCLUDED.payload`,
      [JSON.stringify(PAYLOAD)]
    )
    const { status, body } = await get('/api/faction/upgrades', token)
    expect(status).toBe(200)
    expect(body.state).toBe('peace')
    expect(body.inactiveState).toBe('war')
    expect(body.active.map((b: any) => b.name)).toEqual(['Steadfast'])
    expect(body.inactive.map((b: any) => b.name)).toEqual(['Suppression'])
    expect(body.active[0].upgrades[0].ability).toBe('Increases defense gym gains by 16%')
    expect(body.core.map((u: any) => u.name)).toEqual(['Weapon armory'])
  })

  it('returns the snapshot day as a plain ISO date', async () => {
    const { body } = await get('/api/faction/upgrades', token)
    expect(body.snapshotDate).toBe('2026-10-03')
  })

  it('⚠️ fetchedMs is a usable number, not a string new Date() chokes on', async () => {
    // The #140 trap: this stack serves timestamptz as `...+00` with a bare
    // two-digit offset, which `new Date()` parses as NaN. The route converts in
    // SQL so the client never meets that string.
    const { body } = await get('/api/faction/upgrades', token)
    expect(typeof body.fetchedMs).toBe('number')
    expect(Number.isFinite(body.fetchedMs)).toBe(true)
    expect(new Date(body.fetchedMs).getUTCFullYear()).toBeGreaterThanOrEqual(2026)
  })

  it('⚠️ unlockedMs is epoch MILLIseconds, so the UI dates it correctly', async () => {
    const { body } = await get('/api/faction/upgrades', token)
    expect(body.active[0].upgrades[0].unlockedMs).toBe(1790812804 * 1000)
  })

  it('serves the newest snapshot when several days exist', async () => {
    const older = { ...PAYLOAD, state: 'war' }
    await stack.db.query(
      `INSERT INTO faction_upgrade_snapshots (snapshot_date, branch_state, payload) VALUES ('2026-09-01', 'war', $1)
       ON CONFLICT (snapshot_date) DO UPDATE SET payload = EXCLUDED.payload`,
      [JSON.stringify(older)]
    )
    const { body } = await get('/api/faction/upgrades', token)
    // Still the October row, still peace — not the war-state September one.
    expect(body.snapshotDate).toBe('2026-10-03')
    expect(body.state).toBe('peace')
  })
})
