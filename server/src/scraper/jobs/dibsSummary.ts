// #530 — freeze each finished war's dibs activity into `war_dibs_summary`.
//
// ⚠️ **Runs after the war, not during it.** `attacks-sync` runs every 30 minutes
// while the War Room's dibs sweep runs every second, so the attack row that
// explains a claim's death lands up to half an hour after the claim is gone.
// Live attribution is not available at this cadence and chasing it would mean a
// much faster attack scrape during wars — a real call-budget cost for a report
// nobody reads mid-fight.
//
// ⚠️ **It does not prune anything.** Summarising is what makes pruning the raw
// claims possible later; pruning is irreversible, so the raw rows stay until
// these numbers have been checked against them over at least one real war.
import type pg from 'pg'
import type { JobDeps } from './itemsSync.js'
import type { RunResult } from '../runLog.js'
import {
  summariseWarDibs, warAttacksSettled, STEAL_GRACE_SECONDS, DIBS_SUMMARY_VERSION,
} from '../../warDibsSummary.js'

/**
 * Finished wars that still need a summary.
 *
 * ⚠️ Either never computed, or computed by an older classifier — raising
 * `DIBS_SUMMARY_VERSION` must actually cause a recompute, or the fleet keeps
 * numbers produced by rules we have since decided were wrong.
 */
async function warsNeedingSummary(db: pg.Pool) {
  const res = await db.query(
    // ⚠️ `ranked_wars.start_at` / `end_at` are **bigint epoch seconds**, not
     // timestamptz — unlike almost every other timestamp in this schema. An
     // `extract(epoch FROM …)` here throws outright, which is the good outcome;
     // the bad one is assuming milliseconds and dividing a war into the 1970s.
    `SELECT w.id, w.start_at, w.end_at
     FROM ranked_wars w
     LEFT JOIN war_dibs_summary_state s ON s.war_id = w.id
     WHERE w.end_at IS NOT NULL
       AND (s.war_id IS NULL OR s.summary_version < $1)
     ORDER BY w.end_at DESC`,
    [DIBS_SUMMARY_VERSION]
  )
  return res.rows
}

export async function dibsSummaryJob({ db }: JobDeps): Promise<RunResult> {
  const wars = await warsNeedingSummary(db)
  if (wars.length === 0) return { rows: 0, details: { wars: 0 } }

  // ⚠️ Coverage is read from the DATA, not from the run log alone: an
  // attacks-sync that hits a Torn rate limit mid-backlog exits as a SUCCESS, so
  // "the job succeeded" does not imply it caught up. `max(started)` does.
  const cover = await db.query(
    `SELECT (SELECT max(started) FROM faction_attacks) AS newest_attack,
            (SELECT extract(epoch FROM max(started_at)) FROM scraper_runs
              WHERE job_name = 'attacks-sync' AND status = 'success') AS last_sync`
  )
  const newestAttackTs = cover.rows[0].newest_attack != null
    ? Number(cover.rows[0].newest_attack) : null
  const lastSuccessfulSyncTs = cover.rows[0].last_sync != null
    ? Number(cover.rows[0].last_sync) : null

  let written = 0
  const computed: number[] = []
  const waiting: number[] = []

  for (const war of wars) {
    // ⚠️ Epoch SECONDS throughout, and every conversion happens in SQL. The war
    // columns are already bigint seconds; `claimed_at` / `deleted_at` ARE
    // timestamptz and are converted with `extract(epoch …)` below, because pg
    // hands those back as `...+00` strings that `new Date()` reads as NaN (#140).
    // No timestamp parsing exists in this job to get wrong.
    const warEndTs = Number(war.end_at)
    const warStartTs = Number(war.start_at)

    if (!warAttacksSettled({ warEndTs, newestAttackTs, lastSuccessfulSyncTs })) {
      // ⚠️ Wait rather than guess. A war summarised before its attacks land
      // records real conversions as "no swing" against named members, and once
      // the raw claims are pruned there is nothing left to correct it from.
      waiting.push(Number(war.id))
      continue
    }

    // Claims belonging to this war. ⚠️ `war_id` is CLIENT-SUPPLIED and nullable
    // (warRoomWrites passes `body?.war_id ?? null`), so it cannot be the only
    // key — a claim taken from a client that did not send it would vanish from
    // its own war. Falling back to the claim's timestamp inside the war window.
    const claims = await db.query(
      `SELECT id, target_id, claimed_by, claimed_name,
              extract(epoch FROM claimed_at) AS claimed_at,
              extract(epoch FROM deleted_at) AS deleted_at,
              release_reason
       FROM war_room_dibs_v2
       WHERE war_id = $1
          OR (war_id IS NULL AND claimed_at >= to_timestamp($2) AND claimed_at <= to_timestamp($3))
       ORDER BY id`,
      [war.id, warStartTs, warEndTs]
    )

    const attacks = await db.query(
      `SELECT attacker_id, attacker_faction_id, attacker_name, defender_id, started, result
       FROM faction_attacks
       WHERE started >= $1 AND started <= $2`,
      [warStartTs, warEndTs]
    )

    const config = await db.query('SELECT torn_faction_id FROM faction_config LIMIT 1')
    const ourFactionId = Number(config.rows[0]?.torn_faction_id)

    const { members } = summariseWarDibs({
      claims: claims.rows.map((r) => ({
        ...r,
        claimed_at: Number(r.claimed_at),
        deleted_at: r.deleted_at == null ? null : Number(r.deleted_at),
      })),
      attacks: attacks.rows,
      ourFactionId,
      warEndTs,
    })

    const client = await db.connect()
    try {
      await client.query('BEGIN')
      // ⚠️ Replace, not merge: a recompute under new rules must not leave rows
      // for members the new pass no longer produces.
      await client.query('DELETE FROM war_dibs_summary WHERE war_id = $1', [war.id])
      for (const m of members) {
        await client.query(
          `INSERT INTO war_dibs_summary (
             war_id, member_id, member_name, claims, converted, attempted,
             taken_from, no_swing, outside, released, hopped, overridden,
             board_reset, still_open, unknown, swung, took_from_others)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [
            war.id, m.member_id, m.member_name, m.claims, m.converted, m.attempted,
            m.takenFrom, m.noSwing, m.outside, m.released, m.hopped, m.overridden,
            m.boardReset, m.open, m.unknown, m.swung, m.tookFromOthers,
          ]
        )
        written += 1
      }
      await client.query(
        `INSERT INTO war_dibs_summary_state (war_id, claims_seen, grace_seconds, summary_version, computed_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (war_id) DO UPDATE SET
           claims_seen = EXCLUDED.claims_seen,
           grace_seconds = EXCLUDED.grace_seconds,
           summary_version = EXCLUDED.summary_version,
           computed_at = now()`,
        [war.id, claims.rows.length, STEAL_GRACE_SECONDS, DIBS_SUMMARY_VERSION]
      )
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
    computed.push(Number(war.id))
  }

  return { rows: written, details: { computed, waiting } }
}
