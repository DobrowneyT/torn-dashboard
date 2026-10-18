// #996 — turn our own hits into measured target battle-stat scores.
//
// ⚠️ **Runs after attacks-sync, never during it.** It reads only what is
// already in `faction_attacks` and `member_battle_stats`, so it spends no Torn
// calls at all. It is offset five minutes behind attacks-sync (:20/:50) so it
// never reads the table mid-write.
//
// ⚠️ **Only hitters whose stats are EXACT.** A hitter's stats from their own key
// (`source = 'torn'`) are measured; a TornStats or BSP figure is a guess, and a
// guess multiplied through the formula is a guess about somebody else.
//
// What it does each run:
//   1. read the hits that landed since the last run, oldest first;
//   2. for each, compare Torn's FF with the FF the current belief predicts for
//      that hitter — outside the deadband, store the new measurement; inside,
//      only confirm the existing one;
//   3. drop measurements past their expiry;
//   4. copy each live measurement onto the War Room roster row, where it beats
//      the spy, so it rides the existing live channel.
import type pg from 'pg'
import type { JobDeps } from './itemsSync.js'
import type { RunResult } from '../runLog.js'
import {
  battleStatsScore, decide, deadbandFrom, maxAgeDaysFrom,
  DEADBAND_SETTING, MAX_AGE_SETTING, MEASUREMENT_BEATS_SPY_SQL,
} from '../../statMeasurement.js'

export const WATERMARK_SETTING = 'stat_measure_watermark'

async function setting(db: pg.Pool, key: string): Promise<unknown> {
  const { rows } = await db.query(`SELECT value #>> '{}' AS v FROM faction_settings WHERE key = $1`, [key])
  return rows[0]?.v ?? null
}

interface Belief {
  score: number
  /** Set only when the belief IS a measurement. */
  measuredAtMs: number | null
}

export async function statMeasurementsJob({ db }: JobDeps): Promise<RunResult> {
  const deadband = deadbandFrom(await setting(db, DEADBAND_SETTING))
  const maxAgeDays = maxAgeDaysFrom(await setting(db, MAX_AGE_SETTING))
  const watermark = await setting(db, WATERMARK_SETTING)

  const cfg = await db.query('SELECT torn_faction_id FROM faction_config LIMIT 1')
  const ourFid = Number(cfg.rows[0]?.torn_faction_id ?? 0)

  // ⚠️ Bounded ABOVE by a snapshot of the newest insert, so a row landing while
  // this runs is picked up next time rather than skipped by the new watermark.
  const hiRes = await db.query('SELECT max(created_at)::text AS hi FROM faction_attacks')
  const hi = hiRes.rows[0]?.hi ?? null

  let stored = 0
  let confirmed = 0
  let considered = 0

  if (hi) {
    // ⚠️ First run: no backfill past the expiry window — anything older would
    // be dropped by step 3 straight away.
    const { rows: hits } = await db.query(
      `SELECT a.attack_id, a.started, a.attacker_id, a.defender_id, a.fair_fight::float8 AS ff,
              b.strength, b.speed, b.defense, b.dexterity
         FROM faction_attacks a
         JOIN member_battle_stats b ON b.member_id = a.attacker_id::text AND b.source = 'torn'
        WHERE a.created_at <= $1
          AND ($2::timestamptz IS NULL OR a.created_at > $2::timestamptz)
          AND a.started >= extract(epoch FROM now() - make_interval(days => $3::int))::bigint
          AND a.is_incoming = false
          AND a.attacker_faction_id = $4
          AND a.defender_id IS NOT NULL
          AND a.defender_faction_id IS DISTINCT FROM $4
          AND a.respect_gain > 0
          AND a.fair_fight > 1
        ORDER BY a.started, a.attack_id`,
      [hi, watermark, Math.ceil(maxAgeDays), ourFid],
    )
    considered = hits.length

    const targets = [...new Set(hits.map((h) => Number(h.defender_id)))]
    const beliefs = new Map<number, Belief | null>()
    if (targets.length > 0) {
      const spy = await db.query(
        // ⚠️ Times as epoch ms from SQL: pg hands timestamptz back as `…+00`
        // text, which `new Date` reads as NaN (#140).
        `SELECT member_id AS id, bsp_total, bsp_str, bsp_spd, bsp_def, bsp_dex, spy_source,
                (extract(epoch FROM ts_spy_at) * 1000)::float8 AS spy_ms
           FROM war_room_state_v2 WHERE member_id = ANY($1::bigint[])
         UNION ALL
         SELECT target_id::bigint, bsp_total, bsp_str, bsp_spd, bsp_def, bsp_dex, spy_source,
                (extract(epoch FROM ts_spy_at) * 1000)::float8
           FROM grudge_targets
          WHERE target_id ~ '^[0-9]+$' AND target_id::bigint = ANY($1::bigint[])
            AND target_id::bigint NOT IN (SELECT member_id FROM war_room_state_v2)`,
        [targets],
      )
      const meas = await db.query(
        `SELECT target_id, score,
                (extract(epoch FROM measured_at) * 1000)::float8 AS measured_ms,
                (extract(epoch FROM greatest(measured_at, coalesce(confirmed_at, measured_at))) * 1000)::float8 AS fresh_ms
           FROM target_stat_measurements WHERE target_id = ANY($1::bigint[])`,
        [targets],
      )
      const measById = new Map(meas.rows.map((r) => [Number(r.target_id), r]))
      for (const r of spy.rows) {
        const id = Number(r.id)
        const spyScore = battleStatsScore({
          str: r.bsp_str, spd: r.bsp_spd, def: r.bsp_def, dex: r.bsp_dex, total: r.bsp_total,
        })
        const m = measById.get(id)
        const spyAtMs = r.spy_source === 'tornstats' && r.spy_ms != null ? Number(r.spy_ms) : null
        const measurementWins = m && (spyAtMs === null || Number(m.fresh_ms) >= spyAtMs)
        beliefs.set(id, measurementWins
          ? { score: Number(m.score), measuredAtMs: Number(m.measured_ms) }
          : spyScore === null ? null : { score: spyScore, measuredAtMs: null })
      }
      for (const [id, m] of measById) {
        if (!beliefs.has(id)) beliefs.set(id, { score: Number(m.score), measuredAtMs: Number(m.measured_ms) })
      }
    }

    for (const h of hits) {
      const target = Number(h.defender_id)
      const hitMs = Number(h.started) * 1000
      const attackerScore = battleStatsScore({
        str: h.strength, spd: h.speed, def: h.defense, dex: h.dexterity,
      })
      if (attackerScore === null) continue
      const belief = beliefs.get(target) ?? null
      // ⚠️ Never let an older hit overwrite a newer measurement — a late sync
      // can hand us yesterday's hit after today's.
      if (belief?.measuredAtMs != null && hitMs < belief.measuredAtMs) continue

      const d = decide({ ff: Number(h.ff), attackerScore, current: belief?.score ?? null, deadband })
      if (d.action === 'store') {
        await db.query(
          `INSERT INTO target_stat_measurements
             (target_id, score, bound, fair_fight, attacker_id, attacker_score, attack_id, measured_at, confirmed_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8), NULL, now())
           ON CONFLICT (target_id) DO UPDATE SET
             score = EXCLUDED.score, bound = EXCLUDED.bound, fair_fight = EXCLUDED.fair_fight,
             attacker_id = EXCLUDED.attacker_id, attacker_score = EXCLUDED.attacker_score,
             attack_id = EXCLUDED.attack_id, measured_at = EXCLUDED.measured_at,
             confirmed_at = NULL, updated_at = now()`,
          [target, d.measurement.score, d.measurement.bound, h.ff, h.attacker_id,
           attackerScore, h.attack_id, Number(h.started)],
        )
        beliefs.set(target, { score: d.measurement.score, measuredAtMs: hitMs })
        stored += 1
      } else if (d.action === 'confirm' && belief?.measuredAtMs != null) {
        // Agreeing with a SPY needs no row: there is nothing measured to keep fresh.
        await db.query(
          `UPDATE target_stat_measurements
              SET confirmed_at = greatest(coalesce(confirmed_at, measured_at), to_timestamp($2)), updated_at = now()
            WHERE target_id = $1`,
          [target, Number(h.started)],
        )
        confirmed += 1
      }
    }

    await db.query(
      `INSERT INTO faction_settings (key, value) VALUES ($1, to_jsonb($2::text))
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [WATERMARK_SETTING, hi],
    )
  }

  // ── Expiry ────────────────────────────────────────────────────────────
  // ⚠️ From the latest AGREEING hit, not the one that set the value: a target
  // hit every day at the same FF is still being measured, however old the
  // first reading is.
  const expired = await db.query(
    `DELETE FROM target_stat_measurements
      WHERE greatest(measured_at, coalesce(confirmed_at, measured_at))
            < now() - make_interval(days => $1::int)`,
    [Math.ceil(maxAgeDays)],
  )

  // ── Onto the War Room roster ──────────────────────────────────────────
  // ⚠️ Only rows whose value CHANGES get a new `updated_at`, or every run would
  // push the whole roster down the live channel for nothing.
  const synced = await db.query(
    `UPDATE war_room_state_v2 s
        SET measured_score = v.score, measured_bound = v.bound, measured_at = v.measured_at,
            updated_at = now()
       FROM (
         SELECT s2.member_id, m.score, m.bound, m.measured_at
           FROM war_room_state_v2 s2
           LEFT JOIN target_stat_measurements m
             ON m.target_id = s2.member_id
            AND ${MEASUREMENT_BEATS_SPY_SQL('m', 's2.spy_source', 's2.ts_spy_at')}
       ) v
      WHERE v.member_id = s.member_id
        AND (s.measured_score IS DISTINCT FROM v.score
             OR s.measured_bound IS DISTINCT FROM v.bound
             OR s.measured_at IS DISTINCT FROM v.measured_at)`,
  )

  return {
    rows: stored,
    details: {
      considered, stored, confirmed,
      expired: expired.rowCount ?? 0,
      roster_rows_updated: synced.rowCount ?? 0,
      deadband, max_age_days: maxAgeDays,
    },
  }
}
