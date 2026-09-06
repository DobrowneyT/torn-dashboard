// node-cron scheduler for scraper jobs. Each job has a scraper_jobs row
// (created on registration, schedule/enabled editable in the DB); the
// enabled flag is re-read on every tick so flips take effect without a
// restart. Every execution goes through the run logger, so a crashing job
// is recorded as a failed run instead of killing the process.
import cron, { type ScheduledTask } from 'node-cron'
import type pg from 'pg'
import type { createRunLogger, RunResult } from './runLog.js'
import type { FlagResolver } from '../featureFlags.js'
import { resolveJobSchedule, type ScheduleResolution } from './scheduleResolution.js'

export interface SchedulerOptions {
  db: pg.Pool
  runLogger: ReturnType<typeof createRunLogger>
  /** Fleet defaults (#609 slice 5). Absent means code defaults only, which is
   *  exactly how this behaved before the control plane existed. */
  flags?: FlagResolver
}

type JobFn = () => Promise<RunResult>

export function createScheduler({ db, runLogger, flags }: SchedulerOptions) {
  const jobs = new Map<string, { fn: JobFn; codeDefault: string }>()
  const resolutions = new Map<string, ScheduleResolution>()
  const tasks: ScheduledTask[] = []
  let running = false

  async function tick(jobName: string) {
    const flag = await db.query('SELECT enabled FROM scraper_jobs WHERE job_name = $1', [jobName])
    if (!flag.rows[0]?.enabled) return
    await runLogger.withRun(jobName, jobs.get(jobName)!.fn)
  }

  return {
    /**
     * Register a job. Creates its scraper_jobs row on first sight — DISABLED,
     * because enabling each job is the faction admin's explicit bring-up step.
     *
     * ⚠️ New rows are created with `cron_schedule = NULL`, meaning "follow the
     * fleet default" (#609 slice 5). It used to be seeded with the code
     * default, which made every job look permanently customised and left the
     * fleet layer with nothing to say.
     *
     * ⚠️ **One-time adoption of previously-seeded rows.** A row whose schedule
     * exactly equals the code default was written by that old seeding and never
     * touched by anyone, so it is cleared to NULL and follows the fleet from
     * now on. A row that differs was edited by an operator and is left alone.
     *
     * That inference — "equal to the default means nobody chose it" — is the
     * kind this project usually refuses (see featureFlags.ts on never inferring
     * unset from a value). It is sound in this ONE case because the only two
     * ways that column could hold exactly the default string are the old seed
     * and an operator deliberately typing the default; and for the second, the
     * outcome is identical behaviour, because the fleet layer is unset by
     * default and falls through to the same code default. Doing it in the
     * application rather than in migration 0058 is what makes it possible at
     * all: SQL has no idea what the code default is.
     */
    async register(jobName: string, defaultSchedule: string, fn: JobFn): Promise<void> {
      jobs.set(jobName, { fn, codeDefault: defaultSchedule })
      await db.query(
        `INSERT INTO scraper_jobs (job_name, cron_schedule, enabled) VALUES ($1, NULL, false)
         ON CONFLICT (job_name) DO NOTHING`,
        [jobName]
      )
      await db.query(
        'UPDATE scraper_jobs SET cron_schedule = NULL WHERE job_name = $1 AND cron_schedule = $2',
        [jobName, defaultSchedule]
      )
    },

    /** Start cron tasks for every registered job (schedules read from the DB). */
    async start(): Promise<void> {
      if (running) return
      running = true
      const rows = await db.query('SELECT job_name, cron_schedule FROM scraper_jobs')
      const configured = new Map<string, string | null>(
        rows.rows.map((r: { job_name: string; cron_schedule: string | null }) => [r.job_name, r.cron_schedule])
      )
      for (const [job_name, { codeDefault }] of jobs) {
        const resolution = await resolveJobSchedule({
          jobName: job_name,
          codeDefault,
          tenantValue: configured.get(job_name) ?? null,
          flags,
        })
        resolutions.set(job_name, resolution)
        if (resolution.rejected !== undefined) {
          console.error(
            `[scraper] "${job_name}" has an invalid cron expression ${JSON.stringify(resolution.rejected)} ` +
            `(${resolution.tenantValue !== null ? 'this faction' : 'fleet default'}) — ` +
            `falling back to ${resolution.effective}`
          )
        }
        tasks.push(cron.schedule(resolution.effective, () => {
          // A tick must never crash the process. stop() can't cancel a tick
          // already in flight, so a transient DB error — or the pool being
          // torn down under a live scheduler (shutdown, tests) — lands here
          // as a logged failure instead of an unhandled rejection.
          tick(job_name).catch((err) => {
            console.error(`[scraper] scheduled tick for "${job_name}" failed:`, err)
          })
        }))
      }
    },

    /** What each job actually got, and where it came from. For Global Admin. */
    schedules(): ScheduleResolution[] {
      return [...resolutions.values()]
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
