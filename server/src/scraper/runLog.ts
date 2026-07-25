// Structured run logging for scraper jobs. Every job execution gets a
// scraper_runs row — success or failure — so operators can see what ran,
// when, how many rows it wrote, and why it failed.
import type pg from 'pg'

export interface RunResult {
  rows: number
  details?: Record<string, unknown>
}

export interface RunRecord {
  id: number
  job_name: string
  started_at: string
  finished_at: string | null
  status: 'running' | 'success' | 'failure'
  rows_written: number
  error: string | null
  details: Record<string, unknown> | null
}

export function createRunLogger(db: pg.Pool) {
  // Open a run row in the 'running' state, returning the full record.
  async function openRun(jobName: string): Promise<RunRecord> {
    const res = await db.query(
      `INSERT INTO scraper_runs (job_name) VALUES ($1) RETURNING *`,
      [jobName]
    )
    return res.rows[0]
  }

  // Run the body and close the row (success or failure). Never throws: a
  // crashing job is captured on the row, so it can't take the scheduler — or a
  // background settle — down with it.
  async function settleRun(runId: number, fn: () => Promise<RunResult>): Promise<RunRecord> {
    try {
      const result = await fn()
      const done = await db.query(
        `UPDATE scraper_runs
         SET status = 'success', rows_written = $2, details = $3, finished_at = now()
         WHERE id = $1 RETURNING *`,
        [runId, result.rows, result.details ? JSON.stringify(result.details) : null]
      )
      return done.rows[0]
    } catch (err) {
      const done = await db.query(
        `UPDATE scraper_runs
         SET status = 'failure', error = $2, finished_at = now()
         WHERE id = $1 RETURNING *`,
        [runId, err instanceof Error ? err.message : String(err)]
      )
      return done.rows[0]
    }
  }

  return {
    /**
     * Execute a job body under a run record, awaiting completion. Never throws:
     * failures are captured on the row (status/error) and returned. Used by the
     * cron scheduler, where the tick already runs off the request path.
     */
    async withRun(jobName: string, fn: () => Promise<RunResult>): Promise<RunRecord> {
      const run = await openRun(jobName)
      return settleRun(run.id, fn)
    },

    /**
     * Start a run WITHOUT awaiting the body: opens the run row, kicks the job
     * off in the background, and returns the fresh 'running' record immediately.
     * For manual (admin) triggers, whose job may run for minutes — the HTTP
     * caller must not block or a reverse-proxy read timeout (nginx: 60s) returns
     * a 502 while the job keeps running. Consumers watch the run log for the
     * row to settle. settleRun never rejects; the extra catch guards a DB error
     * inside the background UPDATE itself.
     */
    async startRun(jobName: string, fn: () => Promise<RunResult>): Promise<RunRecord> {
      const run = await openRun(jobName)
      void settleRun(run.id, fn).catch(() => {})
      return run
    },

    /**
     * Close out any run still marked 'running'. A running row can only be left
     * behind by a process that died mid-run (redeploy, crash, OOM) — nothing
     * will ever finish it — so at boot it's an orphan. Marks each as a failure
     * with a restart marker and returns how many were reaped.
     */
    async reapOrphanedRuns(): Promise<number> {
      const res = await db.query(
        `UPDATE scraper_runs
         SET status = 'failure',
             error = COALESCE(error, 'interrupted by restart'),
             finished_at = now()
         WHERE status = 'running' RETURNING id`
      )
      return res.rowCount ?? 0
    },

    /** Most recent runs, newest first. */
    async recentRuns(limit = 50): Promise<RunRecord[]> {
      const res = await db.query(
        'SELECT * FROM scraper_runs ORDER BY started_at DESC, id DESC LIMIT $1',
        [limit]
      )
      return res.rows
    },
  }
}
