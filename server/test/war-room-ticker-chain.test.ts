// Live chain watch driven by the war-room ticker: while the room is enabled,
// each tick polls our + enemy chains at their configured cadences, stores them
// as absolute-epoch timers, and broadcasts the refreshed singleton.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, TEST_KEY_ENCRYPTION_KEY, type TestStack } from './harness.js'
import { createKeyPool } from '../src/scraper/keyPool.js'
import { createWarRoomTicker } from '../src/warRoomTicker.js'

let stack: TestStack
const OUR = Number(TEST_FACTION.tornFactionId)
const ENEMY = 90055
let ourChainCalls = 0
let enemyChainCalls = 0
const broadcasts: Array<{ channel: string; rows: unknown[] }> = []

const hub: any = {
  broadcast: (channel: string, rows: unknown[]) => { broadcasts.push({ channel, rows }) },
  alert: () => {},
}

function makeTicker() {
  return createWarRoomTicker({
    db: stack.db,
    pool: createKeyPool({ db: stack.db, encryptionKey: TEST_KEY_ENCRYPTION_KEY }),
    hub,
    tornBaseUrl: stack.tornBaseUrl,
  })
}

beforeAll(async () => {
  stack = await startTestStack()
  await stack.db.query(`INSERT INTO members (member_id, member_name, tier, is_current) VALUES ('1700', 'Lead', 2, true)`)
  const pool = createKeyPool({ db: stack.db, encryptionKey: TEST_KEY_ENCRYPTION_KEY })
  await pool.store('1700', 'TICKERKEY1700AAA', { consentVersion: 'v2' })

  // Enabled, manual (auto_managed=false ⇒ no war-window gate), enemy set.
  await stack.db.query(
    `INSERT INTO war_room_config_v2 (id, enabled, faction_id, auto_managed,
       chain_poll_interval_ours_sec, chain_poll_interval_enemy_sec)
     VALUES (1, true, $1, false, 5, 30)`,
    [ENEMY]
  )

  // Empty rosters keep the member-state sync quiet.
  stack.torn.setHandler(`/v2/faction/${OUR}/members`, () => ({ members: [] }))
  stack.torn.setHandler(`/v2/faction/${ENEMY}/members`, () => ({ members: [] }))
  // Chains return RELATIVE timers (as real Torn does), with call counters.
  stack.torn.setHandler(`/v2/faction/${OUR}/chain`, () => {
    ourChainCalls++
    return { chain: { id: 1, current: 42, max: 100, timeout: 240, modifier: 1.4, cooldown: 0, start: 1752200050, end: 0 } }
  })
  stack.torn.setHandler(`/v2/faction/${ENEMY}/chain`, () => {
    enemyChainCalls++
    return { chain: { id: 2, current: 3, max: 10, timeout: 90, modifier: 1.1, cooldown: 0, start: 1752200000, end: 0 } }
  })
}, 30000)

afterAll(async () => {
  await stack?.close()
})

describe('war-room ticker — live chain watch', () => {
  it('polls both chains, stores them as absolute timers, and broadcasts', async () => {
    const nowEpoch = Math.floor(Date.now() / 1000)
    const ticker = makeTicker()
    await ticker.tick()

    expect(ourChainCalls).toBe(1)
    expect(enemyChainCalls).toBe(1)

    const row = (await stack.db.query('SELECT * FROM war_room_chain_v2 WHERE id = 1')).rows[0]
    expect(row).toMatchObject({ current: 42, max: 100 })
    // Relative 240 stored as an absolute epoch (~now+240).
    expect(Number(row.timeout)).toBeGreaterThanOrEqual(nowEpoch + 240 - 5)
    expect(Number(row.timeout)).toBeLessThanOrEqual(nowEpoch + 240 + 5)
    expect(row.cooldown).toBeNull()               // relative 0 ⇒ null
    expect(row.enemy).toMatchObject({ current: 3, max: 10 })
    expect(Number(row.enemy.timeout)).toBeGreaterThanOrEqual(nowEpoch + 90 - 5)

    expect(broadcasts.some((b) => b.channel === 'chain')).toBe(true)
  })

  it('respects the per-side cadence — a second immediate tick does not refetch', async () => {
    const beforeOurs = ourChainCalls
    const beforeEnemy = enemyChainCalls
    await makeTicker().tick()
    // Within the 5s/30s windows, neither side is due again.
    expect(ourChainCalls).toBe(beforeOurs)
    expect(enemyChainCalls).toBe(beforeEnemy)
  })

  it('does nothing while the war room is disabled', async () => {
    await stack.db.query(`UPDATE war_room_config_v2 SET enabled = false WHERE id = 1`)
    const beforeOurs = ourChainCalls
    await makeTicker().tick()
    expect(ourChainCalls).toBe(beforeOurs)
    await stack.db.query(`UPDATE war_room_config_v2 SET enabled = true WHERE id = 1`)
  })
})
