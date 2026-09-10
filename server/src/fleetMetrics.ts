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

/**
 * ⚠️ A ceiling on every statement this function runs, and it is not belt and
 * braces — it is the lesson from the outage above. The admin collector gives up
 * on a tenant after TENANT_TIMEOUT_MS (3s), but a Postgres query does not stop
 * because the client walked away: the tenant kept burning CPU on an answer
 * nobody was waiting for, once a minute, forever. Whatever else is wrong, this
 * endpoint now fails fast instead of hanging.
 */
export const METRICS_STATEMENT_TIMEOUT_MS = 5_000

export async function collectFleetMetrics(db: pg.Pool): Promise<FleetMetrics> {
  // ⚠️ On a dedicated connection, and reset in `finally`. `db` is a POOL: a
  // bare `SET statement_timeout` would land on whichever connection the pool
  // handed out and stay there, silently applying this endpoint's ceiling to
  // ordinary application queries that have nothing to do with it.
  const client = await db.connect()
  try {
    await client.query(`SET statement_timeout = ${METRICS_STATEMENT_TIMEOUT_MS}`)
    return await collect(client)
  } finally {
    await client.query('SET statement_timeout = DEFAULT').catch(() => {})
    client.release()
  }
}

async function collect(db: pg.PoolClient): Promise<FleetMetrics> {
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
  //
  // ⚠️ **This query made the endpoint useless in production.** Measured on
  // 2026-09-10 against the live fleet: without a token it 401s in milliseconds;
  // with a valid one it answered in 13.7s, 15.2s and 20.9s on three consecutive
  // calls, and twice exceeded a 25s ceiling outright. The collector's
  // TENANT_TIMEOUT_MS is 3s, so not one measurement had ever landed.
  //
  // The first cut expressed the streak as a correlated `min(rn)` subquery
  // re-evaluated PER ROW over a CTE spanning all of `scraper_runs` — a table
  // that is append-only and has never been pruned. On 504k rows that query was
  // still running when a 60s statement timeout killed it.
  //
  // So the monitoring #632 built to catch #645 was itself down, and the status
  // page said `metricsError` — which reads as "not measured", the exact shape
  // #645 hid in for thirteen days. A health check that cannot answer is worse
  // than no health check, because it occupies the slot where a working one
  // would go.
  //
  // Rebuilt as two INDEXED lookups per job: find that job's newest success,
  // then count the failures after it. That is O(jobs x streak length) instead
  // of O(table), and needs idx_scraper_runs_job_status_started (migration
  // 0061) to stay that way. Measured on the same 504k rows: 60s+ -> 14ms.
  const failing = await db.query(
    `WITH enabled AS (
       SELECT job_name FROM scraper_jobs WHERE enabled = true
     ), last_success AS (
       SELECT e.job_name,
              (SELECT max(r.started_at) FROM scraper_runs r
                WHERE r.job_name = e.job_name AND r.status = 'success') AS success_at
         FROM enabled e
     ), streak AS (
       SELECT ls.job_name, ls.success_at,
              -- ⚠️ NULL success_at means the job has NEVER succeeded, so every
              -- failure it has ever logged is part of the current streak. That
              -- is capacityx's shape in #645, and it must not collapse to 0.
              (SELECT count(*)::int FROM scraper_runs r
                WHERE r.job_name = ls.job_name AND r.status = 'failure'
                  AND (ls.success_at IS NULL OR r.started_at > ls.success_at)
              ) AS consecutive_failures
         FROM last_success ls
     )
     SELECT s.job_name,
            s.consecutive_failures,
            ${ISO('s.success_at')} AS last_success_at,
            (SELECT r.error FROM scraper_runs r
              WHERE r.job_name = s.job_name AND r.status = 'failure'
              ORDER BY r.started_at DESC LIMIT 1) AS last_error
       FROM streak s
      WHERE s.consecutive_failures > 0
      ORDER BY s.consecutive_failures DESC, s.job_name`
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
