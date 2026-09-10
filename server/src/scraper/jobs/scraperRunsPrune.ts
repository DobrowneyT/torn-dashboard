/**
 * `scraper_runs` retention.
 *
 * ⚠️ **Why this exists.** The run log has been append-only since the first
 * tenant went live and nothing has ever removed a row. Every tenant writes
 * ~2,250 a day. On 2026-09-10 that turned an inefficient fleet-metrics query
 * into a live outage: the streak query went superlinear on table size, ten
 * abandoned copies piled up on one tenant, and a four-core box that also serves
 * production hit a load average of 13.5. The query is fixed and no longer cares
 * about table size — this is so nothing else inherits the same trap.
 *
 * ⚠️ **What must survive the prune is the whole difficulty.** Two figures the
 * fleet-metrics endpoint reports are computed from history, and a naive
 * "delete older than N days" silently corrupts both:
 *
 *   * `lastSuccessAt` is `null` for a job that has NEVER succeeded, and that is
 *     deliberately distinct from "succeeded a long time ago" (#632). Prune away
 *     an old success and a healthy-but-quiet job starts reporting as one that
 *     has never worked in its life.
 *
 *   * `consecutiveFailures` counts failures back to the last success. Prune any
 *     of them and the count silently shrinks — the alert quietly under-reports
 *     exactly as the outage deepens.
 *
 * So two classes of row are kept regardless of age: each job's newest success,
 * and every failure after it. What that leaves is genuinely dead history — old
 * successes and the failures of streaks that have since recovered. Nothing
 * reads it: every other consumer (`admin.ts`, `runLog.ts`) asks for the most
 * recent N runs.
 *
 * ⚠️ A job that has NEVER succeeded therefore keeps its entire streak, forever,
 * and that is the intended behaviour rather than an oversight. Capping it would
 * mean reporting a number smaller than the truth about the most broken job on
 * the fleet — the one case where the count matters most. It is bounded by
 * fixing the job: one success makes the whole history prunable on the next run.
 * A job failing every five minutes for a year costs ~105k rows, which the
 * rebuilt query answers from an index in milliseconds.
 */
import type { JobDeps } from './itemsSync.js'
import type { RunResult } from '../runLog.js'

/**
 * ⚠️ Comfortably longer than any window the UI offers. `admin.ts` and
 * `runLog.ts` both ask for "the most recent N", never for a date range, so this
 * is bounded by what an operator might scroll back through rather than by
 * anything computed.
 */
export const RETENTION_DAYS = 30

export async function scraperRunsPruneJob({ db }: JobDeps): Promise<RunResult> {
  const res = await db.query(
    `DELETE FROM scraper_runs r
      WHERE r.id IN (
        SELECT x.id
          FROM scraper_runs x
          LEFT JOIN (
            SELECT job_name, max(started_at) AS success_at
              FROM scraper_runs WHERE status = 'success' GROUP BY job_name
          ) ls ON ls.job_name = x.job_name
         WHERE x.started_at < now() - ($1 || ' days')::interval
           -- ⚠️ 'running' is neither outcome and may be a run still in flight;
           -- deleting one would strand the UPDATE that finishes it.
           AND x.status <> 'running'
           -- Keep each job's newest success forever: it is what makes
           -- lastSuccessAt "a long time ago" rather than "never".
           AND NOT (x.status = 'success' AND ls.success_at IS NOT NULL AND x.started_at = ls.success_at)
           -- Keep every failure in the CURRENT streak forever, so
           -- consecutiveFailures stays exact however long the outage runs.
           AND NOT (x.status = 'failure' AND (ls.success_at IS NULL OR x.started_at > ls.success_at))
      )`,
    [String(RETENTION_DAYS)]
  )
  const pruned = res.rowCount ?? 0
  const remaining = await db.query('SELECT count(*)::int AS n FROM scraper_runs')
  return {
    rows: pruned,
    details: { pruned, remaining: remaining.rows[0]?.n ?? 0, retention_days: RETENTION_DAYS },
  }
}
