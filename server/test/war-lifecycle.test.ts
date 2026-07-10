// War lifecycle automation (slice #73) — port of the 3-minute pg_cron edge
// call. Seam: the job's public API against the fixture + embedded Postgres.
// Detect the matched war → auto-setup an automation-owned session → enable
// at T-1h → disable at war end; manual sessions are never touched.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, TEST_KEY_ENCRYPTION_KEY, type TestStack } from './harness.js'
import { createKeyPool } from '../src/scraper/keyPool.js'
import { createTornClient } from '../src/scraper/tornClient.js'
import { createRunLogger } from '../src/scraper/runLog.js'

let stack: TestStack
const US = Number(TEST_FACTION.tornFactionId)
const ENEMY = 90010

// The fixture's mutable war list.
let warStart = 0
let warEnd: number | null = null

function deps() {
  return {
    db: stack.db,
    pool: createKeyPool({ db: stack.db, encryptionKey: TEST_KEY_ENCRYPTION_KEY }),
    client: createTornClient({ baseUrl: stack.tornBaseUrl, budget: { requests: 200, perMs: 1000 } }),
  }
}

beforeAll(async () => {
  stack = await startTestStack()
  await stack.db.query(
    `INSERT INTO members (member_id, member_name, tier, is_current) VALUES ('1500', 'Scout', 3, true)`
  )
  const pool = createKeyPool({ db: stack.db, encryptionKey: TEST_KEY_ENCRYPTION_KEY })
  await pool.store('1500', 'LIFEKEY01500AAAA', { consentVersion: 'v2' })

  // Leftovers from the previous war that auto-setup must wipe.
  await stack.db.query(`INSERT INTO war_room_config_v2 (id, enabled, faction_id, faction_name, auto_managed, managed_war_id)
                        VALUES (1, false, 88888, 'Last Week Foes', false, NULL)`)
  await stack.db.query(`INSERT INTO war_room_chain_v2 (id, current, max, save_claimed_by, save_claimed_name) VALUES (1, 20, 25, 1500, 'Scout')`)
  await stack.db.query(`INSERT INTO war_room_state_v2 (member_id, faction_id, member_name, state)
                        VALUES (88801, 88888, 'OldEnemy', '{}')`)
  await stack.db.query(`INSERT INTO war_room_dibs_v2 (target_id, claimed_by, claimed_name) VALUES (88801, 1500, 'Scout')`)
  await stack.db.query(`INSERT INTO war_room_roll_call_v2 (war_id, member_id, member_name, on_at_start)
                        VALUES (600, 1500, 'Scout', true)`)
  await stack.db.query(`INSERT INTO war_room_notes_v2 (war_id, notes_public) VALUES (600, 'old plan')`)
  await stack.db.query(`INSERT INTO war_room_notes_private_v2 (war_id, notes) VALUES (600, 'old secret')`)

  stack.torn.setHandler(`/v2/faction/${US}/rankedwars`, () => ({
    rankedwars: [{
      id: 800, start: warStart, end: warEnd ?? 0, target: 4000,
      factions: [
        { id: US, name: 'Us', score: 0 },
        { id: ENEMY, name: 'New Foes', score: 0 },
      ],
    }],
  }))
  stack.torn.setHandler(`/v2/faction/${ENEMY}/members`, () => ({
    members: [{ id: 90110, name: 'FreshEnemy', level: 44, status: { state: 'Okay' }, last_action: { status: 'Online', timestamp: 1752100000 } }],
  }))
  stack.torn.setHandler(`/v2/faction/${US}/members`, () => ({
    members: [{ id: 1500, name: 'Scout', level: 40, status: { state: 'Okay' }, last_action: { status: 'Online', timestamp: 1752100100 } }],
  }))
}, 30000)

afterAll(async () => {
  await stack?.close()
})

describe('war lifecycle job', () => {
  it('auto-sets-up a fresh automation-owned session for a newly matched war (still disabled at T-2h)', async () => {
    warStart = Math.floor(Date.now() / 1000) + 7200 // 2h out
    warEnd = null

    const { warLifecycleJob } = await import('../src/scraper/jobs/warLifecycle.js')
    const result = await warLifecycleJob(deps())
    expect(result.details!.actions).toEqual(['auto_setup'])

    const cfg = await stack.db.query('SELECT * FROM war_room_config_v2 WHERE id = 1')
    expect(cfg.rows[0]).toMatchObject({
      faction_id: ENEMY, faction_name: 'New Foes',
      auto_managed: true, managed_war_id: 800, enabled: false,
    })

    // Prior week wiped: roll call + notes gone, notes reseeded for war 800.
    expect((await stack.db.query('SELECT count(*)::int AS n FROM war_room_roll_call_v2')).rows[0].n).toBe(0)
    const notes = await stack.db.query('SELECT war_id, opponent_faction_id FROM war_room_notes_v2')
    expect(notes.rows).toEqual([{ war_id: 800, opponent_faction_id: ENEMY }])
    expect((await stack.db.query('SELECT count(*)::int AS n FROM war_room_notes_private_v2')).rows[0].n).toBe(0)

    // Old state/dibs tombstoned; chain reset (no inherited save claim).
    const oldState = await stack.db.query('SELECT deleted_at FROM war_room_state_v2 WHERE member_id = 88801')
    expect(oldState.rows[0].deleted_at).toBeTruthy()
    expect((await stack.db.query('SELECT deleted_at FROM war_room_dibs_v2 WHERE target_id = 88801')).rows[0].deleted_at).toBeTruthy()
    const chain = await stack.db.query('SELECT current, save_claimed_by FROM war_room_chain_v2 WHERE id = 1')
    expect(chain.rows[0]).toEqual({ current: null, save_claimed_by: null })

    // Members baselined for the new matchup (board warm before enable).
    const baseline = await stack.db.query(
      'SELECT member_id FROM war_room_state_v2 WHERE deleted_at IS NULL ORDER BY member_id'
    )
    expect(baseline.rows.map((r: any) => Number(r.member_id))).toEqual([1500, 90110])

    // Idempotent: running again does nothing new.
    const again = await warLifecycleJob(deps())
    expect(again.details!.actions).toEqual([])
  })

  it('enables the room at T-1h', async () => {
    warStart = Math.floor(Date.now() / 1000) + 1800 // 30 min out
    const { warLifecycleJob } = await import('../src/scraper/jobs/warLifecycle.js')
    const result = await warLifecycleJob(deps())
    expect(result.details!.actions).toEqual(['auto_enable'])
    const cfg = await stack.db.query('SELECT enabled FROM war_room_config_v2 WHERE id = 1')
    expect(cfg.rows[0].enabled).toBe(true)
  })

  it('disables when the managed war ends and releases automation ownership', async () => {
    warEnd = Math.floor(Date.now() / 1000) - 60
    const { warLifecycleJob } = await import('../src/scraper/jobs/warLifecycle.js')
    const result = await warLifecycleJob(deps())
    expect(result.details!.actions).toEqual(['auto_disable'])
    const cfg = await stack.db.query('SELECT enabled, auto_managed FROM war_room_config_v2 WHERE id = 1')
    expect(cfg.rows[0]).toEqual({ enabled: false, auto_managed: false })
  })

  it('never clobbers a manually-configured session', async () => {
    // A leader has hand-configured a session against a different faction.
    await stack.db.query(
      `UPDATE war_room_config_v2 SET enabled = true, auto_managed = false,
              faction_id = 77777, faction_name = 'Manual Foes', managed_war_id = NULL WHERE id = 1`
    )
    await stack.db.query(`INSERT INTO war_room_notes_v2 (war_id, notes_public) VALUES (801, 'manual plan')
                          ON CONFLICT (war_id) DO NOTHING`)
    // A fresh matched war is upcoming — automation must stand down.
    warStart = Math.floor(Date.now() / 1000) + 7200
    warEnd = null

    const { warLifecycleJob } = await import('../src/scraper/jobs/warLifecycle.js')
    const result = await warLifecycleJob(deps())
    expect(result.details!.actions).toEqual([])

    const cfg = await stack.db.query('SELECT * FROM war_room_config_v2 WHERE id = 1')
    expect(cfg.rows[0]).toMatchObject({
      enabled: true, auto_managed: false, faction_id: 77777, faction_name: 'Manual Foes',
    })
    const notes = await stack.db.query(`SELECT notes_public FROM war_room_notes_v2 WHERE war_id = 801`)
    expect(notes.rows[0].notes_public).toBe('manual plan')
  })

  it('lifecycle actions land in the run log', async () => {
    const { warLifecycleJob } = await import('../src/scraper/jobs/warLifecycle.js')
    const runs = createRunLogger(stack.db)
    const run = await runs.withRun('war-lifecycle', () => warLifecycleJob(deps()))
    expect(run.status).toBe('success')
    expect(run.details).toHaveProperty('actions')
    const recent = await runs.recentRuns(1)
    expect(recent[0].job_name).toBe('war-lifecycle')
  })
})
