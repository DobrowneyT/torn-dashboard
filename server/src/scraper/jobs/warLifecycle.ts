// War lifecycle automation — port of war-room-fetch's handleCronWarLifecycle
// (formerly a 3-minute pg_cron edge call). Detects the matched ranked war,
// auto-sets-up an automation-owned session (wipe prior week → point config
// at the new opponent, disabled → baseline both factions' members), enables
// at T-1h, and disables when the managed war ends. Only automation-owned
// sessions (auto_managed) are ever touched — a manually-configured session
// makes automation stand down entirely.
import type { JobDeps } from './itemsSync.js'
import type { RunResult } from '../runLog.js'
import { syncWarRoomMemberStates } from '../../warRoomTicker.js'
import { clearWarRoomState } from '../../warRoomSetup.js'
import { resolveSpyProviders, fetchSpiesForMembers } from '../../spyFetch.js'

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
  const now = Math.floor(Date.now() / 1000)
  const actions: string[] = []
  let rows = 0

  // Upcoming/active war = has a start, no end yet. Pick the soonest.
  const upcoming = wars
    .filter((w) => (w.start ?? 0) > 0 && !(w.end ?? 0))
    .sort((a, b) => (a.start ?? 0) - (b.start ?? 0))[0] ?? null

  if (upcoming) {
    const opp = (upcoming.factions ?? []).find((f: any) => Number(f.id) !== us)
    const oppId = opp?.id != null ? Number(opp.id) : null
    const startAt = Number(upcoming.start ?? 0)
    const alreadyOwn = cfg?.managed_war_id != null && Number(cfg.managed_war_id) === Number(upcoming.id)
    const manualActive = !!cfg?.enabled && !cfg?.auto_managed

    // AUTO-SETUP: a new matched war we don't already own, and no manual session.
    if (oppId && !alreadyOwn && !manualActive) {
      const dbc = await db.connect()
      try {
        await dbc.query('BEGIN')
        // Roll call is per-war availability — reset it each week. Notes are
        // ARCHIVED (#145): prior wars' rows are keyed by war_id and kept so
        // leadership can browse past strategy/negotiations; only the new war's
        // row is seeded (idempotently) as a fresh slate to edit.
        await dbc.query('DELETE FROM war_room_roll_call_v2')
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
        // Point config at the new opponent — automation-owned, disabled
        // until T-1h.
        await dbc.query(
          `INSERT INTO war_room_config_v2 (id, faction_id, faction_name, auto_managed, managed_war_id, enabled, updated_at)
           VALUES (1, $1, $2, true, $3, false, now())
           ON CONFLICT (id) DO UPDATE SET
             faction_id = EXCLUDED.faction_id, faction_name = EXCLUDED.faction_name,
             auto_managed = true, managed_war_id = EXCLUDED.managed_war_id,
             enabled = false, updated_at = now()`,
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

    // AUTO-ENABLE at T-1h (only for the war we own).
    if (alreadyOwn && cfg?.auto_managed && !cfg?.enabled && now >= startAt - 3600) {
      await db.query('UPDATE war_room_config_v2 SET enabled = true, updated_at = now() WHERE id = 1')
      actions.push('auto_enable')
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
