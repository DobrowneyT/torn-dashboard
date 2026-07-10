// Production wiring: build the scraper core and register every ported job
// with its production cadence. Called from main.ts when SCRAPERS_ENABLED is
// set; tests drive the jobs directly instead.
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

export interface ScraperWiringOptions {
  db: pg.Pool
  tornBaseUrl: string
  /** 32-byte hex secret for key-at-rest encryption (KEY_ENCRYPTION_KEY). */
  encryptionKey: string
}

export async function startScrapers({ db, tornBaseUrl, encryptionKey }: ScraperWiringOptions) {
  const deps: JobDeps = {
    db,
    pool: createKeyPool({ db, encryptionKey }),
    // Torn allows 100 req/min per key; stay well inside it pool-wide.
    client: createTornClient({ baseUrl: tornBaseUrl, budget: { requests: 60, perMs: 60_000 } }),
  }
  const runLogger = createRunLogger(db)
  const scheduler = createScheduler({ db, runLogger })

  // Cadences mirror the Python cron setup: nightly items catalog, crimes
  // every 30 minutes, CPR twice a day.
  await scheduler.register('items-sync', '0 15 4 * * *', () => itemsSyncJob(deps))
  await scheduler.register('crimes-sync', '0 */30 * * * *', () => crimesSyncJob(deps))
  await scheduler.register('cpr-scan', '0 30 5,17 * * *', () => cprScanJob(deps))
  // Members hourly (roster transitions feed everything else); stats daily
  // at 01:05 UTC, just after the 01:00 snapshot offset the backfill targets.
  await scheduler.register('members-sync', '0 5 * * * *', () => membersSyncJob(deps))
  await scheduler.register('member-stats', '0 5 1 * * *', () => memberStatsJob(deps))

  await scheduler.start()
  return scheduler
}
