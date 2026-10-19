// #1019 — the OC board's feed for Choonbot.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'
import { deriveTenantToken } from '../src/fleetMetricsAuth.js'
import { chainWatchScope } from '../../db/chainWatchTokenLib.mjs'
import { requiredCpr } from '../src/ocWatchInternal.js'
import { storeSnapshot, SNAPSHOT_CRIMES, SNAPSHOT_MEMBERS } from '../src/tornSnapshots.js'

const FLEET_SECRET = 'chain-watch-secret-for-tests'
const TOKEN = deriveTenantToken(FLEET_SECRET, chainWatchScope(TEST_FACTION.slug))
let stack: TestStack

async function get(token: string | null) {
  const res = await fetch(`${stack.baseUrl}/api/internal/oc-watch`, {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

const crime = (over: Record<string, unknown> = {}) => ({
  id: 9001, name: 'Blast from the Past', difficulty: 7, status: 'Planning', ready_at: 1_800_000_000,
  slots: [
    { position: 'Picklock', position_info: { id: 'P1', label: 'Picklock #1' }, checkpoint_pass_rate: 72,
      user: { id: 7001, joined_at: 1_799_000_000, progress: 40 }, item_requirement: { id: 1294, is_reusable: false, is_available: false } },
    { position: 'Picklock', position_info: { id: 'P2', label: 'Picklock #2' }, checkpoint_pass_rate: 48,
      user: { id: 7002, joined_at: 1_799_000_100, progress: 10 }, item_requirement: null },
    { position: 'Hacker', position_info: { id: 'H1', label: 'Hacker' }, checkpoint_pass_rate: null, user: null, item_requirement: null },
  ],
  ...over,
})

beforeAll(async () => {
  stack = await startTestStack(undefined, {}, { chainWatchToken: TOKEN })
  await stack.db.query(`INSERT INTO members (member_id, member_name, tier, is_current) VALUES ('7002', 'Muttley', 3, true)
    ON CONFLICT (member_id) DO NOTHING`)
  await stack.db.query(`INSERT INTO items (id, name) VALUES (1294, 'Glitter Bomb') ON CONFLICT (id) DO NOTHING`)
  await stack.db.query(`INSERT INTO inventory_items (id, name, quantity, available) VALUES ('1294', 'Glitter Bomb', 3, 2)
    ON CONFLICT (id) DO UPDATE SET available = 2`)
  await stack.db.query(`INSERT INTO faction_settings (key, value) VALUES ('cpr_requirements', $1)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify({ 'Blast from the Past': { difficulty: 7, positions: { 'Picklock #1': 70, Picklock: 50, Bomber: 75 } } })])
}, 60000)

afterAll(async () => { await stack?.close() })

beforeEach(async () => { await stack.db.query('DELETE FROM torn_live_snapshots') })

describe('auth', () => {
  it('needs the tenant token', async () => {
    expect((await get(null)).status).toBe(401)
    expect((await get('nope')).status).toBe(401)
    expect((await get(TOKEN)).status).toBe(200)
  })
})

describe('the payload', () => {
  it('is empty, with no ages, before any poll has run', async () => {
    const { body } = await get(TOKEN)
    expect(body).toMatchObject({ crimes: [], members: [], crimes_fetched_at: null, members_fetched_at: null, findings: [] })
  })

  it('serves the snapshot in Torn\'s shape, with names, items, the armoury and each seat\'s minimum', async () => {
    await storeSnapshot(stack.db, SNAPSHOT_CRIMES, [crime(), crime({ id: 9002, status: 'Successful' })])
    await storeSnapshot(stack.db, SNAPSHOT_MEMBERS, [
      { id: 7001, name: 'Goosey', status: { state: 'Hospital', until: 1_800_000_500, description: 'In hospital' } },
    ])
    const { body } = await get(TOKEN)
    // Finished crimes are not on the board.
    expect(body.crimes.map((c: any) => c.id)).toEqual([9001])
    const [p1, p2, hacker] = body.crimes[0].slots
    expect(p1).toMatchObject({
      position_label: 'Picklock #1', required_cpr: 70, checkpoint_pass_rate: 72,
      user: { id: 7001, name: 'Goosey', progress: 40 },
      item_requirement: { id: 1294, name: 'Glitter Bomb', is_available: false, armoury_available: 2 },
    })
    // Numbered label first, then the bare role; name from the members table.
    expect(p2).toMatchObject({ required_cpr: 50, user: { id: 7002, name: 'Muttley' } })
    // No published minimum: not judged.
    expect(hacker).toMatchObject({ required_cpr: null, user: null })
    expect(body.members[0].status.until).toBe(1_800_000_500)
    expect(body.crimes_fetched_at).toBeGreaterThan(Date.now() - 60_000)
  })
})

describe('requiredCpr', () => {
  const reqs = { X: { positions: { 'Muscle #1': 60, Muscle: 55 } } }
  it('numbered label, then bare role, then nothing', () => {
    expect(requiredCpr(reqs, 'X', 'Muscle #1')).toBe(60)
    expect(requiredCpr(reqs, 'X', 'Muscle #3')).toBe(55)
    expect(requiredCpr(reqs, 'X', 'Hacker')).toBeNull()
    expect(requiredCpr(reqs, 'Y', 'Muscle')).toBeNull()
    expect(requiredCpr({}, 'X', '')).toBeNull()
  })
})
