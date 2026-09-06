// War lifecycle automation (slice #73) — port of the 3-minute pg_cron edge
// call. Seam: the job's public API against the fixture + embedded Postgres.
// Detect the matched war → auto-setup an automation-owned session → enable
// at matched+30min (#480) → disable at war end; manual sessions are never
// touched.
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

// deps with spy-stat providers wired (#139) — the TornStats/BSP base URL
// points at the fixture so the mock intercepts.
function spyDeps() {
  return {
    ...deps(),
    spy: { encryptionKey: TEST_KEY_ENCRYPTION_KEY, tornStatsBaseUrl: stack.tornBaseUrl },
  }
}

beforeAll(async () => {
  stack = await startTestStack()
  await stack.db.query(
    `INSERT INTO members (member_id, member_name, tier, is_current) VALUES ('1500', 'Scout', 3, true)`
  )
  const pool = createKeyPool({ db: stack.db, encryptionKey: TEST_KEY_ENCRYPTION_KEY })
  await pool.store('1500', 'LIFEKEY01500AAAA', { consentVersion: 'v2' })

  // Leftovers from the previous war. Live state/dibs/chain are reset by
  // auto-setup; roll call and notes are ARCHIVED per war (#345) and kept.
  // Surge alerting left switched ON by last week's leader, with tuning to
  // match — #598's whole subject. The flags must not survive auto-setup; the
  // tuning behind them must.
  await stack.db.query(`INSERT INTO war_room_config_v2
                          (id, enabled, faction_id, faction_name, auto_managed, managed_war_id,
                           surge_alerts_enabled, surge_revive_alerts_enabled,
                           surge_enemy_threshold, surge_revive_our_window_sec)
                        VALUES (1, false, 88888, 'Last Week Foes', false, NULL,
                                true, true, 7, 900)`)
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
      // #598: alerting from the last war does not carry into this one. Off is
      // the safe default because the failure is asymmetric — a leader who
      // wanted alerts re-arms them in seconds, where a termed war pushing to
      // every subscriber on expected hospital churn costs the channel for the
      // week, and then for the war where it mattered.
      surge_alerts_enabled: false, surge_revive_alerts_enabled: false,
      // ...but the TUNING behind the switches survives. Wiping it would mean
      // re-deriving these numbers every week just to turn alerting back on.
      surge_enemy_threshold: 7, surge_revive_our_window_sec: 900,
    })

    // Roll call is ARCHIVED per war, exactly like notes (#345). War 600's
    // responses survive; war 800 simply has none yet, because every row is
    // keyed by war_id and a new war id is already an empty slate. This used to
    // be an unqualified DELETE that destroyed every past war's responses.
    const rc = await stack.db.query('SELECT war_id, member_id FROM war_room_roll_call_v2 ORDER BY war_id')
    expect(rc.rows).toEqual([{ war_id: 600, member_id: 1500 }])
    const notes = await stack.db.query('SELECT war_id, opponent_faction_id FROM war_room_notes_v2 ORDER BY war_id')
    expect(notes.rows).toEqual([
      { war_id: 600, opponent_faction_id: null },   // last week's, kept
      { war_id: 800, opponent_faction_id: ENEMY },  // this week's fresh seed
    ])
    // The prior week's leads-only note survives for the archive.
    expect((await stack.db.query('SELECT count(*)::int AS n FROM war_room_notes_private_v2')).rows[0].n).toBe(1)

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

  it('does not auto-enable within the 30-minute buffer after being matched (#480)', async () => {
    // matched_detected_at was just stamped by the auto-setup test above.
    // War 800's own start time (2h out) is irrelevant to auto-enable now —
    // only time-since-matched counts.
    const { warLifecycleJob } = await import('../src/scraper/jobs/warLifecycle.js')
    const result = await warLifecycleJob(deps())
    expect(result.details!.actions).toEqual([])
    const cfg = await stack.db.query('SELECT enabled, auto_enabled_at FROM war_room_config_v2 WHERE id = 1')
    expect(cfg.rows[0]).toMatchObject({ enabled: false, auto_enabled_at: null })
  })

  it('auto-enables once the 30-minute buffer has passed, and never re-fires for the same war (#480)', async () => {
    // Simulate the clock: this war was "matched" 31 minutes ago.
    await stack.db.query(
      `UPDATE war_room_config_v2 SET matched_detected_at = now() - interval '31 minutes' WHERE id = 1`
    )
    const { warLifecycleJob } = await import('../src/scraper/jobs/warLifecycle.js')
    const result = await warLifecycleJob(deps())
    expect(result.details!.actions).toEqual(['auto_enable'])
    const cfg = await stack.db.query('SELECT enabled, auto_enabled_at, member_stats_poll_interval_sec FROM war_room_config_v2 WHERE id = 1')
    expect(cfg.rows[0].enabled).toBe(true)
    expect(cfg.rows[0].auto_enabled_at).toBeTruthy()
    // member_stats_poll_interval_sec defaults to 0 (off) — auto-enable fills
    // it in, since the whole point is accumulating overdose_until for #480.
    expect(cfg.rows[0].member_stats_poll_interval_sec).toBe(300)

    // A leader stops it by hand. auto_enabled_at (the one-shot guard) is
    // untouched by a manual stop, so the lifecycle job must not fight them.
    await stack.db.query(`UPDATE war_room_config_v2 SET enabled = false WHERE id = 1`)
    const again = await warLifecycleJob(deps())
    expect(again.details!.actions).toEqual([])
    const cfgAfter = await stack.db.query('SELECT enabled FROM war_room_config_v2 WHERE id = 1')
    expect(cfgAfter.rows[0].enabled).toBe(false)
  })

  it('disables when the managed war ends and releases automation ownership', async () => {
    // A leader started the room by hand — that is the only way it turns on now.
    await stack.db.query('UPDATE war_room_config_v2 SET enabled = true WHERE id = 1')
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

describe('war lifecycle spy auto-fetch (#139)', () => {
  it('pulls spy stats for the new matchup after baselining, when a provider is configured', async () => {
    const { createSecretStore } = await import('../src/secrets.js')
    await createSecretStore({ db: stack.db, encryptionKey: TEST_KEY_ENCRYPTION_KEY })
      .set('tornstats_api_key', 'LIFETSKEY')
    // TornStats faction spy for the enemy member baselined into the board.
    stack.torn.setPath(`/api/v2/LIFETSKEY/spy/faction/${ENEMY}`, {
      faction: {
        members: {
          '90110': { id: 90110, spy: { total: 4_200_000, strength: 1, speed: 1, defense: 1, dexterity: 1, timestamp: Math.floor(Date.now() / 1000) } },
        },
      },
    })

    // Reset to a not-owned session so auto-setup fires again for war 800.
    await stack.db.query(
      `UPDATE war_room_config_v2 SET enabled = false, auto_managed = false,
              managed_war_id = NULL, faction_id = NULL WHERE id = 1`
    )
    warStart = Math.floor(Date.now() / 1000) + 7200
    warEnd = null

    const { warLifecycleJob } = await import('../src/scraper/jobs/warLifecycle.js')
    const result = await warLifecycleJob(spyDeps())

    expect(result.details!.actions).toEqual(['auto_setup'])
    expect(result.details!.spies).toMatchObject({ tornstats: 1 })

    // The enemy member now carries a TornStats spy with a real capture time.
    const row = await stack.db.query(
      `SELECT spy_source, bsp_total, ts_spy_at FROM war_room_state_v2 WHERE member_id = 90110`
    )
    expect(row.rows[0].spy_source).toBe('tornstats')
    expect(Number(row.rows[0].bsp_total)).toBe(4_200_000)
    expect(row.rows[0].ts_spy_at).toBeTruthy()
  })

  it('no-ops the spy step (no provider configured) without failing setup', async () => {
    await stack.db.query(
      `UPDATE war_room_config_v2 SET enabled = false, auto_managed = false,
              managed_war_id = NULL, faction_id = NULL WHERE id = 1`
    )
    warStart = Math.floor(Date.now() / 1000) + 7200
    warEnd = null

    const { warLifecycleJob } = await import('../src/scraper/jobs/warLifecycle.js')
    // deps() has no spy config → the spy step is skipped, setup still succeeds.
    const result = await warLifecycleJob(deps())
    expect(result.details!.actions).toEqual(['auto_setup'])
    expect(result.details!.spies).toEqual({ skipped: 'no_provider' })
  })
})

// ── A week the faction sits out ──────────────────────────────────────────────
//
// MonChoon, 2026-09-06: *"some weeks a faction might not enter matchmaking (take
// a week off from fighting), so I just want to be sure that if the check after
// matchmaking returns no faction or no war or something it won't break — it's
// essentially a no-op."*
//
// It already is, and these pin it there. The behaviour falls out of
// `upcoming = wars.filter(w => w.start > 0 && !w.end)[0] ?? null` followed by
// `if (upcoming)`, which is easy to refactor into something that no longer
// holds — so the guarantee is asserted rather than left implied.
//
// ⚠️ The assertion that matters is not "it did not throw". It is that the war
// room's own configuration is byte-for-byte untouched: a quiet week must not
// arm the room, disarm a room a leader armed by hand, or repoint it at a stale
// opponent.
describe('a week with no matched war (#weeks off)', () => {
  const CONFIG = () => stack.db.query(
    // `faction_id` is the OPPONENT the room points at — the field a stale
    // matchup would corrupt, so it is the one most worth pinning here.
    `SELECT enabled, auto_managed, managed_war_id, faction_id, faction_name,
            matched_detected_at, auto_enabled_at
       FROM war_room_config_v2 WHERE id = 1`
  ).then((r) => r.rows[0])

  /** The state a faction rests in after last week's war ended and automation
   *  released ownership: room off, nothing owned. */
  async function restingState() {
    await stack.db.query(
      `UPDATE war_room_config_v2
          SET enabled = false, auto_managed = false, managed_war_id = NULL,
              matched_detected_at = NULL, auto_enabled_at = NULL
        WHERE id = 1`
    )
  }

  const setWars = (wars: unknown[]) =>
    stack.torn.setHandler(`/v2/faction/${US}/rankedwars`, () => ({ rankedwars: wars }))

  afterAll(() => {
    // Leave the fixture as the rest of the file expects it.
    setWars([{
      id: 800, start: warStart, end: warEnd ?? 0, target: 4000,
      factions: [{ id: US, name: 'Us', score: 0 }, { id: ENEMY, name: 'New Foes', score: 0 }],
    }])
  })

  it('does nothing at all when the faction is in no wars', async () => {
    await restingState()
    setWars([])
    const before = await CONFIG()

    const { warLifecycleJob } = await import('../src/scraper/jobs/warLifecycle.js')
    const result = await warLifecycleJob(deps())

    expect(result.details!.actions).toEqual([])
    expect(await CONFIG()).toEqual(before)
  })

  it('does nothing when every war on record has already ended', async () => {
    // The realistic shape of a week off: last week's war is still returned by
    // the API, finished, and no new one has been matched.
    await restingState()
    const past = Math.floor(Date.now() / 1000) - 7 * 86_400
    setWars([
      { id: 800, start: past, end: past + 86_400, target: 4000,
        factions: [{ id: US, name: 'Us' }, { id: ENEMY, name: 'Old Foes' }] },
      { id: 799, start: past - 7 * 86_400, end: past - 6 * 86_400, target: 4000,
        factions: [{ id: US, name: 'Us' }, { id: 90011, name: 'Older Foes' }] },
    ])
    const before = await CONFIG()

    const { warLifecycleJob } = await import('../src/scraper/jobs/warLifecycle.js')
    expect((await warLifecycleJob(deps())).details!.actions).toEqual([])
    expect(await CONFIG()).toEqual(before)
  })

  it('⚠️ leaves a manually-armed room alone through a quiet week', async () => {
    // A leader can run the room outside a ranked war (a chain, a practice
    // session). Automation not finding a war must not be read as "nothing is
    // happening, switch it off" — the absence of a war says nothing about
    // whether a human wanted the room on.
    await stack.db.query(
      `UPDATE war_room_config_v2
          SET enabled = true, auto_managed = false, managed_war_id = NULL WHERE id = 1`
    )
    setWars([])

    const { warLifecycleJob } = await import('../src/scraper/jobs/warLifecycle.js')
    expect((await warLifecycleJob(deps())).details!.actions).toEqual([])
    const cfg = await CONFIG()
    expect(cfg.enabled).toBe(true)
    expect(cfg.auto_managed).toBe(false)
  })

  it('⚠️ does not set up a war whose opponent it cannot identify', async () => {
    // `factions` carrying only us — a shape Torn has no reason to return, which
    // is exactly why it is worth pinning. Auto-setup gates on `oppId`, so this
    // must stay a no-op rather than seeding a room pointed at nobody.
    await restingState()
    setWars([{
      id: 801, start: Math.floor(Date.now() / 1000) + 3600, end: 0, target: 4000,
      factions: [{ id: US, name: 'Us', score: 0 }],
    }])
    const before = await CONFIG()

    const { warLifecycleJob } = await import('../src/scraper/jobs/warLifecycle.js')
    expect((await warLifecycleJob(deps())).details!.actions).toEqual([])
    expect(await CONFIG()).toEqual(before)
  })

  it('⚠️ survives a response with no rankedwars key at all', async () => {
    // "or something" — an error body, a shape change, a truncated response.
    // `data.rankedwars ?? []` is what carries this, and it is one edit away
    // from becoming a TypeError on a job that runs every three minutes.
    await restingState()
    stack.torn.setHandler(`/v2/faction/${US}/rankedwars`, () => ({}))
    const before = await CONFIG()

    const { warLifecycleJob } = await import('../src/scraper/jobs/warLifecycle.js')
    const result = await warLifecycleJob(deps())

    expect(result.details!.actions).toEqual([])
    expect(await CONFIG()).toEqual(before)
  })
})
