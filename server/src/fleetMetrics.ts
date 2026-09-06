/**
 * The authenticated metrics a tenant exposes to the control plane (#632).
 *
 * ⚠️ **Why this exists.** `capacityx` ran zero Torn-backed scraper jobs for
 * thirteen days (#645) and every surface said it was healthy:
 * `/api/health/ready` answered `ok`, Docker's healthcheck was green, and the
 * #609 fleet status page reported `5/5 tenants up`. Those check whether the
 * database is reachable and the scheduler is *armed* — not whether anything
 * *succeeds*. A tenant whose every job has failed for a fortnight is
 * indistinguishable from a healthy one at that endpoint.
 *
 * Two numbers would have caught it on day one: how many keys are claimable, and
 * how many scraper runs are failing.
 *
 * ⚠️ **Counts and job names only — never member ids, never key material.** #609
 * is explicit that publishing key-pool depth is reconnaissance handed over, and
 * that reasoning does not stop applying because the caller is ours. Job names
 * are included after all (the issue's first cut excluded them): they are
 * identical on every tenant and reveal nothing about a faction, and without
 * them an alert can only say "something is failing", which is not actionable at
 * 3am.
 */
import type pg from 'pg'

export interface KeyPoolMetrics {
  /** ⚠️ Mirrors keyPool.claim()'s condition exactly. `disabled = false` alone
   *  would over-report: a key with no faction access is enrolled and useless. */
  claimable: number
  enrolled: number
  disabled: number
}

export interface JobFailure {
  jobName: string
  consecutiveFailures: number
  /** null when the job has NEVER succeeded — distinct from "succeeded long ago". */
  lastSuccessAt: string | null
  lastError: string | null
}

export interface FleetMetrics {
  generatedAt: string
  keys: KeyPoolMetrics
  scrapers: {
    enabledJobs: number
    failing: JobFailure[]
    runsLast24h: number
    failuresLast24h: number
  }
}

const ISO = (col: string) =>
  `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

export async function collectFleetMetrics(db: pg.Pool): Promise<FleetMetrics> {
  const keys = await db.query(
    `SELECT
       count(*) FILTER (
         WHERE disabled = false AND consent_at IS NOT NULL AND cpr_api_key IS NOT NULL
           AND has_faction_access IS NOT FALSE
       )::int AS claimable,
       count(*)::int AS enrolled,
       count(*) FILTER (WHERE disabled)::int AS disabled
     FROM member_secrets`
  )

  // ⚠️ Only ENABLED jobs. A job an admin deliberately switched off is not
  // failing, and reporting it would train someone to ignore this list — the
  // #598 lesson about a channel that cries wolf.
  //
  // `consecutive_failures` counts back from the newest run until a success, so
  // a job that failed once and recovered scores 0. Runs still in flight are
  // excluded: 'running' is neither outcome.
  const failing = await db.query(
    `WITH finished AS (
       SELECT job_name, status, started_at, error,
              row_number() OVER (PARTITION BY job_name ORDER BY started_at DESC) AS rn
         FROM scraper_runs WHERE status <> 'running'
     ), streak AS (
       SELECT f.job_name,
              count(*) FILTER (
                WHERE f.status = 'failure' AND f.rn < COALESCE((
                  SELECT min(s.rn) FROM finished s
                   WHERE s.job_name = f.job_name AND s.status = 'success'
                ), 1e9)
              )::int AS consecutive_failures
         FROM finished f GROUP BY f.job_name
     )
     SELECT j.job_name,
            COALESCE(s.consecutive_failures, 0) AS consecutive_failures,
            (SELECT ${ISO('max(r.started_at)')} FROM scraper_runs r
              WHERE r.job_name = j.job_name AND r.status = 'success') AS last_success_at,
            (SELECT r.error FROM scraper_runs r
              WHERE r.job_name = j.job_name AND r.status = 'failure'
              ORDER BY r.started_at DESC LIMIT 1) AS last_error
       FROM scraper_jobs j
       LEFT JOIN streak s ON s.job_name = j.job_name
      WHERE j.enabled = true AND COALESCE(s.consecutive_failures, 0) > 0
      ORDER BY COALESCE(s.consecutive_failures, 0) DESC, j.job_name`
  )

  const window = await db.query(
    `SELECT count(*)::int AS runs,
            count(*) FILTER (WHERE status = 'failure')::int AS failures
       FROM scraper_runs
      WHERE started_at >= now() - interval '24 hours' AND status <> 'running'`
  )
  const enabled = await db.query(
    `SELECT count(*)::int AS n FROM scraper_jobs WHERE enabled = true`
  )

  return {
    generatedAt: new Date().toISOString(),
    keys: {
      claimable: Number(keys.rows[0]?.claimable ?? 0),
      enrolled: Number(keys.rows[0]?.enrolled ?? 0),
      disabled: Number(keys.rows[0]?.disabled ?? 0),
    },
    scrapers: {
      enabledJobs: Number(enabled.rows[0]?.n ?? 0),
      failing: failing.rows.map((r) => ({
        jobName: String(r.job_name),
        consecutiveFailures: Number(r.consecutive_failures),
        lastSuccessAt: r.last_success_at ? String(r.last_success_at) : null,
        // ⚠️ Truncated. A stack trace in an alert payload is both noise and a
        // way to leak paths; the first line is what identifies the fault.
        lastError: r.last_error ? String(r.last_error).slice(0, 200) : null,
      })),
      runsLast24h: Number(window.rows[0]?.runs ?? 0),
      failuresLast24h: Number(window.rows[0]?.failures ?? 0),
    },
  }
}
