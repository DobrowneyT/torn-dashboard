// node-cron scheduler for scraper jobs. Each job has a scraper_jobs row
// (created on registration, schedule/enabled editable in the DB); the
// enabled flag is re-read on every tick so flips take effect without a
// restart. Every execution goes through the run logger, so a crashing job
// is recorded as a failed run instead of killing the process.
import cron, { type ScheduledTask } from 'node-cron'
import type pg from 'pg'
import type { createRunLogger, RunResult } from './runLog.js'

export interface SchedulerOptions {
  db: pg.Pool
  runLogger: ReturnType<typeof createRunLogger>
}

type JobFn = () => Promise<RunResult>

export function createScheduler({ db, runLogger }: SchedulerOptions) {
  const jobs = new Map<string, { fn: JobFn }>()
  const tasks: ScheduledTask[] = []
  let running = false

  async function tick(jobName: string) {
    const flag = await db.query('SELECT enabled FROM scraper_jobs WHERE job_name = $1', [jobName])
    if (!flag.rows[0]?.enabled) return
    await runLogger.withRun(jobName, jobs.get(jobName)!.fn)
  }

  return {
    /**
     * Register a job. Creates its scraper_jobs row with the default schedule
     * on first sight; an existing row's schedule/enabled settings win.
     */
    async register(jobName: string, defaultSchedule: string, fn: JobFn): Promise<void> {
      jobs.set(jobName, { fn })
      await db.query(
        `INSERT INTO scraper_jobs (job_name, cron_schedule) VALUES ($1, $2)
         ON CONFLICT (job_name) DO NOTHING`,
        [jobName, defaultSchedule]
      )
    },

    /** Start cron tasks for every registered job (schedules read from the DB). */
    async start(): Promise<void> {
      if (running) return
      running = true
      const rows = await db.query('SELECT job_name, cron_schedule FROM scraper_jobs')
      for (const { job_name, cron_schedule } of rows.rows) {
        if (!jobs.has(job_name)) continue
        tasks.push(cron.schedule(cron_schedule, () => { void tick(job_name) }))
      }
    },

    stop(): void {
      for (const task of tasks) task.stop()
      tasks.length = 0
      running = false
    },

    /** Manual trigger (admin "run now"); ignores the enabled flag. */
    async runNow(jobName: string) {
      const job = jobs.get(jobName)
      if (!job) throw new Error(`Unknown scraper job: ${jobName}`)
      return runLogger.withRun(jobName, job.fn)
    },
  }
}
