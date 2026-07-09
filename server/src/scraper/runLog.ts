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
  return {
    /**
     * Execute a job body under a run record. Never throws: failures are
     * captured on the row (status/error) and returned, so a crashing job
     * can't take the scheduler down with it.
     */
    async withRun(jobName: string, fn: () => Promise<RunResult>): Promise<RunRecord> {
      const started = await db.query(
        `INSERT INTO scraper_runs (job_name) VALUES ($1) RETURNING id`,
        [jobName]
      )
      const runId = started.rows[0].id
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
