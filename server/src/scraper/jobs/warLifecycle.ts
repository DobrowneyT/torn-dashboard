// War lifecycle automation — port of war-room-fetch's handleCronWarLifecycle
// (formerly a 3-minute pg_cron edge call). Detects the matched ranked war,
// auto-sets-up an automation-owned session (wipe prior week → point config
// at the new opponent, disabled → baseline both factions' members), auto-
// enables at matched+30min (#480), and disables when the managed war ends.
// Only automation-owned sessions (auto_managed) are ever touched — a
// manually-configured session makes automation stand down entirely.
//
// #480 reintroduces auto-enable, which #345 deliberately removed — but on
// different footing: #345's problem was the OLD ticker's second gate (an
// auto-managed session refused to poll outside its war's start/end window,
// so "enabled" could be true while the board sat frozen for days, looking
// live while doing nothing). `enabled` is now the ONLY gate (#345), so
// turning it on early means the board really is live early, not lying about
// it. Reasons to run from matched+30min rather than close to start:
// war_room_member_stats_v2's overdose_until latch (#357) is the only signal
// that can answer "did anyone OD in the run-up to this war", and it only
// accumulates while the room is enabled.
import type { JobDeps } from './itemsSync.js'
import type { RunResult } from '../runLog.js'
import { syncWarRoomMemberStates } from '../../warRoomTicker.js'
import { clearWarRoomState } from '../../warRoomSetup.js'
import { resolveSpyProviders, fetchSpiesForMembers } from '../../spyFetch.js'

// #480: how long after a war is first detected as matched before the room
// auto-enables. 30 minutes gives Torn's own API a buffer to settle (fresh
// matchups have shown stale/partial data immediately after being posted) and
// gives the spy fetch that already runs at auto-setup a head start before
// the room starts polling continuously.
export const AUTO_ENABLE_DELAY_SEC = 30 * 60

export async function warLifecycleJob(deps: JobDeps): Promise<RunResult> {
  const { db, pool, client } = deps
  const cfgRes = await db.query('SELECT * FROM war_room_config_v2 WHERE id = 1')
  const cfg = cfgRes.rows[0] ?? null

  const claimed = await pool.claim()
  if (!claimed) return { rows: 0, details: { actions: [], note: 'no pooled key available' } }

  const usRes = await db.query('SELECT torn_faction_id FROM faction_config LIMIT 1')
  const us = Number(usRes.rows[0].torn_faction_id)

  const data = await client.fetch(`/v2/faction/${us}/rankedwars?limit=100`, claimed.key)
  const wars: any[] = data.rankedwars ?? []
  const actions: string[] = []
  let rows = 0

  // Upcoming/active war = has a start, no end yet. Pick the soonest.
  const upcoming = wars
    .filter((w) => (w.start ?? 0) > 0 && !(w.end ?? 0))
    .sort((a, b) => (a.start ?? 0) - (b.start ?? 0))[0] ?? null

  if (upcoming) {
    const opp = (upcoming.factions ?? []).find((f: any) => Number(f.id) !== us)
    const oppId = opp?.id != null ? Number(opp.id) : null
    const alreadyOwn = cfg?.managed_war_id != null && Number(cfg.managed_war_id) === Number(upcoming.id)
    const manualActive = !!cfg?.enabled && !cfg?.auto_managed

    // AUTO-SETUP: a new matched war we don't already own, and no manual session.
    if (oppId && !alreadyOwn && !manualActive) {
      const dbc = await db.connect()
      try {
        await dbc.query('BEGIN')
        // Roll call and notes are BOTH archived per war (#345). Every row is
        // keyed by war_id, so a new war id is already an empty slate — there is
        // nothing to reset. This used to run an unqualified
        // `DELETE FROM war_room_roll_call_v2`, which destroyed every past war's
        // responses (and, if the lifecycle re-ran auto-setup for a war already
        // underway, the current war's too). The notes row is still seeded
        // idempotently so leadership has something to edit.
        await dbc.query(
          `INSERT INTO war_room_notes_v2 (war_id, opponent_faction_id) VALUES ($1, $2)
           ON CONFLICT (war_id) DO NOTHING`,
          [upcoming.id, oppId]
        )
        await dbc.query('COMMIT')
        // Fresh slate: same clear the manual endpoint uses (tombstone live
        // state + dibs, reset the chain singleton).
        await clearWarRoomState(db)
        await dbc.query('BEGIN')
        // Point config at the new opponent — automation-owned, disabled until
        // auto-enable fires (below). matched_detected_at/auto_enabled_at are
        // reset for the new war: a fresh matchup starts its own 30-minute
        // clock and its own one-shot auto-enable attempt.
        await dbc.query(
          `INSERT INTO war_room_config_v2
             (id, faction_id, faction_name, auto_managed, managed_war_id, enabled,
              matched_detected_at, auto_enabled_at, updated_at)
           VALUES (1, $1, $2, true, $3, false, now(), NULL, now())
           ON CONFLICT (id) DO UPDATE SET
             faction_id = EXCLUDED.faction_id, faction_name = EXCLUDED.faction_name,
             auto_managed = true, managed_war_id = EXCLUDED.managed_war_id,
             enabled = false, matched_detected_at = now(), auto_enabled_at = NULL,
             updated_at = now()`,
          [oppId, opp?.name ?? null, upcoming.id]
        )
        await dbc.query('COMMIT')
      } catch (err) {
        await dbc.query('ROLLBACK')
        throw err
      } finally {
        dbc.release()
      }

      // Baseline both factions so the board is warm before enable.
      const changed = await syncWarRoomMemberStates(db, client, claimed.key, oppId, us)
      rows += changed.length
      actions.push('auto_setup')

      // Then — linearly, once the board is baselined — pull spy stats for the
      // new matchup (#139), the same enrichment the manual Fetch Spies button
      // runs. No-op (logged) when no spy provider is configured; leaders can
      // still refresh manually after a fresh spy exchange / TornStats sync.
      let spies: { fetched: number; tornstats: number; bsp: number } | { skipped: string } = { skipped: 'no_provider' }
      if (deps.spy) {
        const providers = await resolveSpyProviders(db, deps.spy)
        if (providers.tsKey || providers.bspKey) {
          const board = await db.query(
            'SELECT member_id FROM war_room_state_v2 WHERE deleted_at IS NULL'
          )
          const memberIds = board.rows.map((r: { member_id: string | number }) => Number(r.member_id))
          const result = await fetchSpiesForMembers({ db, memberIds, providers })
          spies = result.ok
            ? { fetched: result.fetched, tornstats: result.tornstats, bsp: result.bsp }
            : { skipped: result.reason }
        }
      }

      return { rows, details: { actions, war_id: upcoming.id, opponent: oppId, spies } }
    }

    // AUTO-ENABLE (#480): the war we already own, still off, never yet
    // auto-enabled, and past its 30-minute buffer. The whole gate lives in
    // SQL — comparing matched_detected_at against now() in JS meant parsing
    // Postgres's timestamptz text back into a Date, and its default text
    // format (`...-05`, no minutes on the offset) is not valid ISO-8601:
    // `new Date(...)` silently returns Invalid Date/NaN for it, which made
    // every comparison false. auto_enabled_at is the one-shot guard, checked
    // in the same WHERE — set the moment this fires, so a leader who
    // manually stops the room afterwards is never fought on a later tick.
    if (alreadyOwn) {
      const enabled = await db.query(
        `UPDATE war_room_config_v2
           SET enabled = true, auto_enabled_at = now(), started_at = now(), updated_at = now(),
               -- member_stats_poll_interval_sec defaults to 0 (off) — the
               -- whole point of auto-enabling early is to accumulate the
               -- overdose_until latch (#357) for #480, which needs this sweep
               -- actually running. Only fill it in when it's off; a leader's
               -- own configured cadence is never overridden. 300s (5 min) is
               -- far tighter than needed for a cooldown lasting 10h+, kept
               -- cheap on purpose.
               member_stats_poll_interval_sec =
                 CASE WHEN member_stats_poll_interval_sec = 0 THEN 300 ELSE member_stats_poll_interval_sec END
         WHERE id = 1 AND auto_managed = true AND enabled = false AND auto_enabled_at IS NULL
           AND matched_detected_at IS NOT NULL
           AND matched_detected_at <= now() - ($1 || ' seconds')::interval
         RETURNING id`,
        [AUTO_ENABLE_DELAY_SEC]
      )
      if ((enabled.rowCount ?? 0) > 0) actions.push('auto_enable')
    }
  }

  // AUTO-DISABLE when the war we own has ended. Never touches manual sessions.
  if (cfg?.auto_managed && cfg?.managed_war_id) {
    const managed = wars.find((w) => Number(w.id) === Number(cfg.managed_war_id))
    if (managed && Number(managed.end ?? 0) > 0 && cfg.enabled) {
      await db.query(
        'UPDATE war_room_config_v2 SET enabled = false, auto_managed = false, updated_at = now() WHERE id = 1'
      )
      actions.push('auto_disable')
    }
  }

  return { rows, details: { actions } }
}
