// Battle stats for Book of Grudges targets (#889, slice 5).
//
// ⚠️ **A SEPARATE job from `grudge-refresh`, and deliberately much slower.**
// Status moves every few minutes, which is why the refresh runs quarter-hourly.
// Spy stats move on the order of weeks, and they come from THIRD-PARTY servers
// we do not own — TornStats and BSP. Riding the 15-minute sweep would mean
// hammering somebody else's service ninety-six times a day for a number that
// changes monthly. The same concern is already on record for TornProbability.
//
// ⚠️ **TornStats first, BSP for the rest** — the same precedence the War Room
// uses, via the shared `spyProviders` module. TornStats answers a whole faction
// in ONE call; BSP is one call per player. So the order is not a preference,
// it is the difference between one call and forty.
import type { JobDeps } from './itemsSync.js'
import type { RunResult } from '../runLog.js'
import { resolveSpyProviders } from '../../spyFetch.js'
import {
  fetchTornStatsFaction, readTornStatsFaction, fetchBspStats, BSP_SPACING_MS,
} from '../../spyProviders.js'

/**
 * How stale a reading may be before we refetch it.
 *
 * ⚠️ A stated tunable, not a magic number, per the standing rule. Seven days
 * suits a figure that moves monthly while still catching somebody who has just
 * come back from a training binge.
 */
const REFETCH_AFTER_DAYS = 7

export async function grudgeStatsJob({ db }: JobDeps): Promise<RunResult> {
  const providers = await resolveSpyProviders(db, {
    encryptionKey: process.env.KEY_ENCRYPTION_KEY,
    tornStatsApiKey: process.env.TORNSTATS_API_KEY,
    bspApiKey: process.env.BSP_API_KEY,
  })
  if (!providers.tsKey && !providers.bspKey) {
    // Not an error: a faction that has configured neither provider simply has
    // no battle stats on its board, and the column says so.
    return { rows: 0, details: { note: 'no spy provider configured' } }
  }

  // ⚠️ Only what is actually stale. Most runs should do nothing, which is the
  // point of a job that talks to somebody else's server.
  const due = await db.query(
    `SELECT target_id, faction_id
       FROM grudge_targets
      WHERE removed_at IS NULL
        AND state <> 'rejected'
        AND (bsp_fetched_at IS NULL OR bsp_fetched_at < now() - ($1 || ' days')::interval)
      ORDER BY target_id`,
    [String(REFETCH_AFTER_DAYS)]
  )
  if (due.rows.length === 0) return { rows: 0, details: { note: 'nothing stale' } }

  const ids = due.rows.map((r: any) => Number(r.target_id)).filter(Number.isFinite)
  const wanted = new Set(ids)
  const filled = new Map<number, any>()
  let tsCalls = 0

  // ── TornStats: one call per faction holding stale targets ────────────────
  if (providers.tsKey) {
    const factions = [...new Set(
      due.rows.map((r: any) => r.faction_id).filter((f: any) => f != null && f !== '')
    )]
    for (const factionId of factions) {
      const payload = await fetchTornStatsFaction(
        providers.tsKey, factionId as string, providers.tornStatsBaseUrl
      )
      tsCalls += 1
      for (const [id, reading] of readTornStatsFaction(payload, wanted)) {
        filled.set(id, reading)
      }
    }
  }

  // ── BSP: one call each for whoever TornStats did not cover ───────────────
  const needBsp = ids.filter((id) => !filled.has(id))
  let bspCalls = 0
  if (providers.bspKey) {
    for (let i = 0; i < needBsp.length; i++) {
      const r = await fetchBspStats(providers.bspKey, needBsp[i], providers.bspBaseUrl)
      bspCalls += 1
      if (r) filled.set(needBsp[i], r)
      if (i < needBsp.length - 1) await new Promise((res) => setTimeout(res, BSP_SPACING_MS))
    }
  }

  for (const [id, r] of filled) {
    await db.query(
      `UPDATE grudge_targets SET
         bsp_total = $2, bsp_str = $3, bsp_spd = $4, bsp_def = $5, bsp_dex = $6,
         spy_source = $7, bsp_fetched_at = now(), ts_spy_at = $8
       WHERE target_id = $1`,
      [String(id), r.total, r.str, r.spd, r.def, r.dex, r.source, r.spiedAt]
    )
  }

  return {
    rows: filled.size,
    details: {
      due: ids.length,
      tornstats: [...filled.values()].filter((r) => r.source === 'tornstats').length,
      bsp: [...filled.values()].filter((r) => r.source === 'bsp').length,
      ts_calls: tsCalls,
      bsp_calls: bspCalls,
      refetch_after_days: REFETCH_AFTER_DAYS,
    },
  }
}
