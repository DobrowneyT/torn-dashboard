// #480: pre-war stacks snapshot. war_room_member_stats_v2 is overwritten in
// place on every sweep — this is the only place "what was their energy right
// before the war" survives past the next tick.
//
// ⚠️ The capture window is [start_at - 60s, start_at), so "at the snapshot" and
// "at war start" are the same question to within a minute. That is why the
// activity reading taken here can honestly be labelled against the war start.
//
// ⚠️ All timing comparisons stay in SQL. server/src/db.ts deliberately
// returns timestamptz as a raw string, not a JS Date (to match legacy
// PostgREST payload shapes) — and Postgres's default text offset (`-05`,
// `+00`, no colon) fails `new Date()` parsing outright, regardless of server
// timezone. warLifecycle.ts hit exactly this: a JS-side comparison silently
// never fired because the parse returned NaN. Never construct a JS Date from
// a value that came out of this pool; compare timestamps in the query.
import type pg from 'pg'

export interface StacksSnapshotResult {
  captured: boolean
  warId?: number
  rows?: number
}

/**
 * Capture the stacks snapshot for the currently-managed war, if it is due
 * and not already taken.
 *
 * Due window: [start_at - 60s, start_at) — never before (the point is "right
 * before the war"), never at/after start (the war has begun; a "pre-war"
 * snapshot taken then no longer means what it says, and a ticker outage that
 * straddles the start must not fabricate a stale snapshot hours later).
 *
 * Idempotent: an existence check runs before touching the roster at all, so
 * a war that already has a snapshot costs one cheap query per tick, not a
 * full member scan. The insert itself is also guarded (ON CONFLICT DO
 * NOTHING) as a second line of defence against a race between two checks.
 */
export async function captureStacksSnapshotIfDue(db: pg.Pool): Promise<StacksSnapshotResult> {
  const cfgRes = await db.query(
    `SELECT wrc.managed_war_id, wrc.matched_detected_at
       FROM war_room_config_v2 wrc
       JOIN ranked_wars rw ON rw.id = wrc.managed_war_id
      WHERE wrc.id = 1 AND wrc.auto_managed = true AND wrc.enabled = true
        AND wrc.managed_war_id IS NOT NULL
        AND to_timestamp(rw.start_at) - interval '60 seconds' <= now()
        AND now() < to_timestamp(rw.start_at)`
  )
  const cfg = cfgRes.rows[0]
  if (!cfg) return { captured: false }

  const warId = Number(cfg.managed_war_id)

  const existing = await db.query('SELECT 1 FROM war_stacks_snapshot WHERE war_id = $1 LIMIT 1', [warId])
  if (existing.rows.length > 0) return { captured: false }

  const inserted = await db.query(
    `INSERT INTO war_stacks_snapshot
       (war_id, member_id, member_name, energy_current, energy_maximum, has_reading,
        od_flagged_prewar, last_action_epoch, status_state, captured_at)
     SELECT $1, m.member_id::bigint, m.member_name,
            s.energy_current, s.energy_maximum,
            (s.member_id IS NOT NULL AND s.last_error IS NULL) AS has_reading,
            -- COALESCE guards the NOT NULL column if matched_detected_at were
            -- ever somehow absent (shouldn't happen — AUTO-SETUP always sets
            -- it before AUTO-ENABLE can fire): 'infinity' makes the >= always
            -- false rather than NULL, defaulting to "not flagged".
            (s.overdose_until IS NOT NULL AND s.overdose_until >= COALESCE($2::timestamptz, 'infinity')) AS od_flagged_prewar,
            -- Who was actually awake. ⚠️ Read from war_room_state_v2, which the
            -- ticker already refreshes every sweep — no new Torn call, and
            -- nothing borrowed from Chain Watch's sampler, which is a separate
            -- feature with its own table on purpose.
            --
            -- ⚠️ This row is overwritten in place on every sweep, so THIS is the
            -- only moment the value can be preserved. Miss it and the answer is
            -- gone for that war permanently.
            NULLIF(w.state -> 'last_action' ->> 'timestamp', '')::bigint,
            w.state -> 'status' ->> 'state',
            now()
       FROM members m
       LEFT JOIN war_room_member_stats_v2 s ON s.member_id = m.member_id::bigint
       LEFT JOIN war_room_state_v2 w ON w.member_id = m.member_id::bigint AND w.deleted_at IS NULL
      WHERE m.is_current = true AND COALESCE(m.is_fallen, false) = false
     ON CONFLICT (war_id, member_id) DO NOTHING
     RETURNING member_id`,
    [warId, cfg.matched_detected_at]
  )
  return { captured: true, warId, rows: inserted.rowCount ?? 0 }
}
