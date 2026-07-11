// Manual war-room setup flow (slice #73 completion): config save, clear
// state, member baseline fetch, chain seed — the endpoints behind the
// leader's "Save & Fetch" button. Same guard as notes (warlead/leadership/
// admin), never visitors.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, TEST_KEY_ENCRYPTION_KEY, type TestStack } from './harness.js'
import { createKeyPool } from '../src/scraper/keyPool.js'

let stack: TestStack
const tokens: Record<string, string> = {}
const US = Number(TEST_FACTION.tornFactionId)
const ENEMY = 90020

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

async function call(method: string, path: string, payload?: unknown, as = 'warlead') {
  const headers: Record<string, string> = { authorization: `Bearer ${tokens[as]}` }
  if (payload !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(`${stack.baseUrl}${path}`, {
    method, headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  })
  return { status: res.status, body: (await res.json()) as any }
}

beforeAll(async () => {
  stack = await startTestStack()
  // Roster before logins: a roster-missing member's login creates a stub
  // row (fresh-faction bootstrap), which would collide with this insert.
  await stack.db.query(`INSERT INTO members (member_id, member_name, tier, is_current) VALUES ('1600', 'Lead', 2, true)`)
  await loginAs('warlead', '1600', ['warlead'])
  await loginAs('member', '1601', [])
  await loginAs('visitor', '1602', ['visitor'])
  const pool = createKeyPool({ db: stack.db, encryptionKey: TEST_KEY_ENCRYPTION_KEY })
  await pool.store('1600', 'SETUPKEY1600AAAA', { consentVersion: 'v2' })

  await stack.db.query(`INSERT INTO war_room_config_v2 (id, enabled, faction_id) VALUES (1, true, 88888)`)
  await stack.db.query(`INSERT INTO war_room_chain_v2 (id, current, max) VALUES (1, 10, 25)`)
  await stack.db.query(`INSERT INTO war_room_state_v2 (member_id, faction_id, member_name, state)
                        VALUES (88801, 88888, 'OldEnemy', '{}')`)

  stack.torn.setHandler(`/v2/faction/${ENEMY}/members`, () => ({
    members: [{ id: 90120, name: 'NextEnemy', level: 42, status: { state: 'Okay' }, last_action: { status: 'Idle', timestamp: 1752200000 } }],
  }))
  stack.torn.setHandler(`/v2/faction/${US}/members`, () => ({
    members: [{ id: 1600, name: 'Lead', level: 40, status: { state: 'Okay' }, last_action: { status: 'Online', timestamp: 1752200100 } }],
  }))
  stack.torn.setHandler(`/v2/faction/${ENEMY}/basic`, () => ({ basic: { id: ENEMY, name: 'Next Foes', tag: 'NF' } }))
  stack.torn.setHandler(`/v2/faction/${ENEMY}/chain`, () => ({ chain: { current: 3, max: 10, timeout: 90, modifier: 1.1, cooldown: 0, start: 1752200000, end: 0 } }))
  stack.torn.setHandler(`/v2/faction/${US}/chain`, () => ({ chain: { current: 42, max: 100, timeout: 240, modifier: 1.4, cooldown: 0, start: 1752200050, end: 0 } }))
}, 30000)

afterAll(async () => {
  await stack?.close()
})

describe('war-room manual setup', () => {
  it('PUT config updates allowlisted fields only; leads only', async () => {
    const { status, body } = await call('PUT', '/api/war-room/config', {
      enabled: false, faction_id: ENEMY, faction_name: null, auto_managed: false,
      started_by: 999999, // not client-settable — must be ignored
    })
    expect(status).toBe(200)
    expect(body.config).toMatchObject({ enabled: false, faction_id: ENEMY, auto_managed: false })
    expect(body.config.started_by).toBeNull()

    expect((await call('PUT', '/api/war-room/config', { enabled: true }, 'member')).status).toBe(403)
    expect((await call('PUT', '/api/war-room/config', { enabled: true }, 'visitor')).status).toBe(403)
  })

  it('clear-state tombstones live rows and resets the chain', async () => {
    const { status } = await call('POST', '/api/war-room/clear-state', {})
    expect(status).toBe(200)
    const state = await stack.db.query('SELECT deleted_at FROM war_room_state_v2 WHERE member_id = 88801')
    expect(state.rows[0].deleted_at).toBeTruthy()
    const chain = await stack.db.query('SELECT current, max FROM war_room_chain_v2 WHERE id = 1')
    expect(chain.rows[0]).toEqual({ current: null, max: null })

    expect((await call('POST', '/api/war-room/clear-state', {}, 'member')).status).toBe(403)
  })

  it('fetch-members baselines both factions with a pooled key and returns the enemy name', async () => {
    const { status, body } = await call('POST', '/api/war-room/fetch-members', { faction_id: ENEMY })
    expect(status).toBe(200)
    expect(body.faction_name).toBe('Next Foes')
    expect(body.members_synced).toBeGreaterThanOrEqual(2)

    const rows = await stack.db.query(
      'SELECT member_id, faction_id FROM war_room_state_v2 WHERE deleted_at IS NULL ORDER BY member_id'
    )
    expect(rows.rows.map((r: any) => Number(r.member_id))).toEqual([1600, 90120])
    // The config's cached enemy name refreshes too.
    const cfg = await stack.db.query('SELECT faction_name FROM war_room_config_v2 WHERE id = 1')
    expect(cfg.rows[0].faction_name).toBe('Next Foes')

    expect((await call('POST', '/api/war-room/fetch-members', { faction_id: ENEMY }, 'member')).status).toBe(403)
  })

  it('fetch-spies fills BSP columns — TornStats faction spies first, BSP for the rest (#100)', async () => {
    // A second enemy member TornStats doesn't know — BSP must cover them.
    await stack.db.query(`INSERT INTO war_room_state_v2 (member_id, faction_id, member_name, state)
                          VALUES (90121, ${ENEMY}, 'Unspied', '{}')`)
    const nowSec = Math.floor(Date.now() / 1000)
    stack.torn.setPath(`/api/v2/TSKEY123/spy/faction/${ENEMY}`, {
      faction: {
        members: {
          '90120': { id: 90120, spy: { total: 1_500_000, strength: 500_000, speed: 400_000, defense: 300_000, dexterity: 300_000, timestamp: nowSec } },
        },
      },
    })
    stack.torn.setPath('/api/battlestats/BSPKEY99/90121/TornForge', {
      Result: 1, TBS: 2_000_000, Strength: 800_000, Speed: 500_000, Defense: 400_000, Dexterity: 300_000,
    })

    const { status, body } = await call('POST', '/api/war-room/fetch-spies', { member_ids: [90120, 90121] })
    expect(status).toBe(200)
    expect(body).toMatchObject({ fetched: 2, tornstats: 1, bsp: 1, requested: 2 })

    const rows = await stack.db.query(
      `SELECT member_id, bsp_total, spy_source, ts_spy_at FROM war_room_state_v2
       WHERE member_id IN (90120, 90121) ORDER BY member_id`
    )
    // TornStats fill carries the spy's real capture time; BSP has none.
    expect(rows.rows[0]).toMatchObject({ bsp_total: 1_500_000, spy_source: 'tornstats' })
    expect(rows.rows[0].ts_spy_at).toBeTruthy()
    expect(rows.rows[1]).toMatchObject({ bsp_total: 2_000_000, spy_source: 'bsp' })
    expect(rows.rows[1].ts_spy_at).toBeNull()

    expect((await call('POST', '/api/war-room/fetch-spies', { member_ids: [90120] }, 'member')).status).toBe(403)
  })

  it('fetch-chains seeds both sides of the chain singleton', async () => {
    const { status } = await call('POST', '/api/war-room/fetch-chains', { enemy_faction_id: ENEMY })
    expect(status).toBe(200)
    const chain = await stack.db.query('SELECT * FROM war_room_chain_v2 WHERE id = 1')
    expect(chain.rows[0]).toMatchObject({ current: 42, max: 100, timeout: 240 })
    expect(chain.rows[0].enemy).toMatchObject({ current: 3, max: 10 })
    expect(chain.rows[0].our_last_fetched_at).toBeTruthy()

    expect((await call('POST', '/api/war-room/fetch-chains', { enemy_faction_id: ENEMY }, 'visitor')).status).toBe(403)
  })
})
