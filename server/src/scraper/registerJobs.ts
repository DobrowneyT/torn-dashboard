// Production wiring: build the scraper core and register every ported job
// with its production cadence (registered disabled — per-job enablement is
// the admin's bring-up step). Called from main.ts; tests drive jobs directly. The admin surface gets the
// same table through createJobRunner (manual triggers share job code).
import type pg from 'pg'
import { createKeyPool } from './keyPool.js'
import { createTornClient } from './tornClient.js'
import { createRunLogger } from './runLog.js'
import { createScheduler } from './scheduler.js'
import { itemsSyncJob, type JobDeps } from './jobs/itemsSync.js'
import { crimesSyncJob } from './jobs/crimesSync.js'
import { cprScanJob } from './jobs/cprScan.js'
import { membersSyncJob } from './jobs/membersSync.js'
import { memberStatsJob } from './jobs/memberStats.js'
import { warsSyncJob } from './jobs/warsSync.js'
import { attacksSyncJob } from './jobs/attacksSync.js'
import { warLifecycleJob } from './jobs/warLifecycle.js'
import { competitionsResolveJob } from './jobs/competitionsResolve.js'

export interface ScraperWiringOptions {
  db: pg.Pool
  tornBaseUrl: string
  /** 32-byte hex secret for key-at-rest encryption (KEY_ENCRYPTION_KEY). */
  encryptionKey: string
  /** Spy-stat providers (#139) so war-lifecycle can auto-fetch spies. Keys
   *  are the deprecated operator-wide env fallback; the faction's own stored
   *  secrets (Global Admin) take precedence. Base URLs are test-injectable. */
  tornStatsApiKey?: string
  bspApiKey?: string
  tornStatsBaseUrl?: string
  bspBaseUrl?: string
}

// Every job with its production cadence. Cadences mirror the Python cron
// setup: nightly items catalog, crimes every 30 minutes, CPR twice a day;
// members hourly (roster transitions feed everything else); stats daily at
// 01:05 UTC, just after the 01:00 snapshot offset the backfill targets;
// wars every 3 hours; attacks every 30 minutes (both also triggerable on
// demand from the war pages); war lifecycle every 3 minutes (the old
// pg_cron cadence): auto-setup, T-1h enable, war-end disable.
const JOB_TABLE: Array<[name: string, schedule: string, job: (deps: JobDeps) => Promise<{ rows: number; details?: Record<string, unknown> }>]> = [
  ['items-sync', '0 15 4 * * *', itemsSyncJob],
  ['crimes-sync', '0 */30 * * * *', crimesSyncJob],
  ['cpr-scan', '0 30 5,17 * * *', cprScanJob],
  ['members-sync', '0 5 * * * *', membersSyncJob],
  ['member-stats', '0 5 1 * * *', memberStatsJob],
  ['wars-sync', '0 10 */3 * * *', warsSyncJob],
  ['attacks-sync', '0 20,50 * * * *', attacksSyncJob],
  ['war-lifecycle', '0 */3 * * * *', warLifecycleJob],
  // Competitions auto-resolve (#186): every 15 min — day-boundary closes and
  // interval draws don't need finer granularity.
  ['competitions-resolve', '0 */15 * * * *', competitionsResolveJob],
]

function buildDeps(opts: ScraperWiringOptions): JobDeps {
  const { db, tornBaseUrl, encryptionKey } = opts
  return {
    db,
    pool: createKeyPool({ db, encryptionKey }),
    // Torn allows 100 req/min per key; stay well inside it pool-wide.
    client: createTornClient({ baseUrl: tornBaseUrl, budget: { requests: 60, perMs: 60_000 } }),
    spy: {
      encryptionKey,
      tornStatsApiKey: opts.tornStatsApiKey,
      bspApiKey: opts.bspApiKey,
      tornStatsBaseUrl: opts.tornStatsBaseUrl,
      bspBaseUrl: opts.bspBaseUrl,
    },
  }
}

export async function startScrapers(opts: ScraperWiringOptions) {
  const deps = buildDeps(opts)
  const runLogger = createRunLogger(opts.db)
  const scheduler = createScheduler({ db: opts.db, runLogger })

  // A previous process may have died mid-run (redeploy, crash, OOM), leaving
  // rows stuck 'running' forever. Close them out before we start so the run
  // history is honest and stale rows can't mask themselves as in-flight.
  const reaped = await runLogger.reapOrphanedRuns()
  if (reaped > 0) console.log(`[scraper] reaped ${reaped} orphaned running run(s) from a prior process`)

  for (const [name, schedule, job] of JOB_TABLE) {
    await scheduler.register(name, schedule, () => job(deps))
  }

  await scheduler.start()
  return scheduler
}

/**
 * The admin surface's handle on the jobs: list them (with default cadence)
 * and trigger one immediately, independent of the cron scheduler. Runs go
 * through the same run logger, so manual and scheduled runs share history.
 */
export function createJobRunner(opts: ScraperWiringOptions) {
  const deps = buildDeps(opts)
  const runLogger = createRunLogger(opts.db)
  const byName = new Map(JOB_TABLE.map(([name, schedule, job]) => [name, { schedule, job }]))

  return {
    jobs: JOB_TABLE.map(([name, schedule]) => ({ job_name: name, default_schedule: schedule })),
    async runNow(jobName: string) {
      const entry = byName.get(jobName)
      if (!entry) return null
      // Background the run: return the 'running' record at once so the admin
      // HTTP request returns immediately (a minutes-long job behind a blocking
      // request 502s at the nginx read timeout). The Global Admin "Recent Runs"
      // view polls for the row to settle.
      return runLogger.startRun(jobName, () => entry.job(deps))
    },
  }
}
