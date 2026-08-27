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
import { inventorySyncJob } from './jobs/inventorySync.js'
import { crimesSyncJob } from './jobs/crimesSync.js'
import { crimeOccupancyJob } from './jobs/crimeOccupancy.js'
import { cprScanJob } from './jobs/cprScan.js'
import { membersSyncJob } from './jobs/membersSync.js'
import { memberStatsJob } from './jobs/memberStats.js'
import { memberProfileJob } from './jobs/memberProfile.js'
import { memberBattleStatsJob } from './jobs/memberBattleStats.js'
import { statsSamplesPruneJob } from './jobs/statsSamplesPrune.js'
import { warsSyncJob } from './jobs/warsSync.js'
import { attacksSyncJob } from './jobs/attacksSync.js'
import { revivesContinuousJob } from './jobs/revivesSync.js'
import { factionsSyncJob } from './jobs/factionsSync.js'
import { warLifecycleJob } from './jobs/warLifecycle.js'
import { competitionsResolveJob } from './jobs/competitionsResolve.js'
import { ocScenariosMirrorJob } from './jobs/ocScenariosMirror.js'
import { factionUpgradesSyncJob } from './jobs/factionUpgradesSync.js'
import { memberEventWindowsJob } from './jobs/memberEventWindows.js'

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
// pg_cron cadence): auto-setup, matched+30min auto-enable (#480), war-end
// disable.
const JOB_TABLE: Array<[name: string, schedule: string, job: (deps: JobDeps) => Promise<{ rows: number; details?: Record<string, unknown> }>]> = [
  // Every 6 hours (#448). Was once daily at 04:15 — bumped because the OC
  // Simulator now values item rewards at CURRENT prices, and MonChoon wants
  // re-running a simulation to pick up price movement. The whole catalogue is
  // one API call, so 4/day costs nothing worth counting.
  ['items-sync', '0 15 */6 * * *', itemsSyncJob],
  // Faction armory snapshot hourly (top of the hour) — keeps loaned-item
  // tracking and payout valuations fresh; the manual Leadership "Sync" button
  // still works and writes the same sync_metadata row.
  ['inventory-sync', '0 0 * * * *', inventorySyncJob],
  ['crimes-sync', '0 */30 * * * *', crimesSyncJob],
  // #389: observed OC occupancy — every minute, at the :30 second mark.
  //
  // Torn never says when a member LEFT a crime, so the only way to know is to
  // keep looking. One page of `cat=all` covers the working set (a faction
  // never has more than 100 crimes in flight), which makes a per-minute poll
  // cheap: 1,440 calls/day against a pool that rotates keys.
  //
  // The :30 offset is deliberate — every other job here fires on :00, and
  // stacking a per-minute job on the same second would have it queue behind
  // the half-hourly sweeps once every 30 runs.
  ['crime-occupancy', '30 * * * * *', crimeOccupancyJob],
  ['cpr-scan', '0 30 5,17 * * *', cprScanJob],
  ['members-sync', '0 5 * * * *', membersSyncJob],
  // Member stats every 4h (#227): fresh competition leaderboards. Each run
  // appends a slim sample to member_stat_samples and refreshes the daily blob.
  ['member-stats', '0 5 */4 * * *', memberStatsJob],
  // Profile denorms (donator/property/last-action) change slowly — once daily,
  // just after the first member-stats run (#226). Composes via COALESCE.
  ['member-profile', '0 20 1 * * *', memberProfileJob],
  // Our own members' battle stats (#348) — daily. Pass 1 spends one Torn call
  // per enrolled member (their OWN key; battlestats is self-only), then
  // TornStats and BSP fill anyone without a key. Stats move slowly, so daily
  // is ample. Offset from member-profile so the two don't overlap.
  ['member-battle-stats', '0 45 2 * * *', memberBattleStatsJob],
  // Prune the intraday sample series past its retention window (#227) — daily,
  // keeping samples still needed to resolve unresolved competitions.
  ['stats-samples-prune', '0 40 1 * * *', statsSamplesPruneJob],
  ['wars-sync', '0 10 */3 * * *', warsSyncJob],
  ['attacks-sync', '0 20,50 * * * *', attacksSyncJob],
  // Standing revives feed (#358), on the attacks cadence and offset from it so
  // the two don't contend for a key. Feeds the rolling 24h revive history the
  // War Room's revive-chance estimate is computed from — a target's score
  // decays continuously, so the history has to stay current, not war-scoped.
  ['revives-sync', '0 5,35 * * * *', revivesContinuousJob],
  // Faction-name backfill (hourly, offset from attacks): resolves names for any
  // faction id referenced by an attack that we don't have yet, so the payout
  // opposing-faction filter shows names instead of "Faction #id".
  ['factions-sync', '0 40 * * * *', factionsSyncJob],
  ['war-lifecycle', '0 */3 * * * *', warLifecycleJob],
  // Competitions auto-resolve (#186): every 15 min — day-boundary closes and
  // interval draws don't need finer granularity.
  ['competitions-resolve', '0 */15 * * * *', competitionsResolveJob],
  // #390: mirror the OC probability model. ONCE A DAY, and that is a ceiling
  // rather than a compromise — the source is a model someone is slowly
  // extending, so it changes on the order of weeks, while a full run costs
  // ~150 calls to a small third-party server (1 baseline + N role probes per
  // scenario, plus a diagram each). Nothing about the simulator needs fresher.
  // 03:50 keeps it clear of the 01:xx–02:xx daily cluster above.
  ['oc-scenarios-mirror', '0 50 3 * * *', ocScenariosMirrorJob],
  // #395/#458: one snapshot of the faction's upgrades per day, so the calendar
  // can say what Steadfast was giving on a given date rather than repainting
  // history with today's numbers. Perks change on the order of weeks, so daily
  // is ample resolution and costs exactly one call. 02:10 sits in a gap between
  // the 01:xx cluster and member-battle-stats at 02:45.
  ['faction-upgrades', '0 10 2 * * *', factionUpgradesSyncJob],
  // #459: each opted-in member's Torn event start hour. One string per member
  // that changes rarely, so daily is generous — and it costs one call per
  // OPTED-IN member, not per member, which is why it sits well clear of the
  // 01:xx–02:xx cluster rather than riding an existing sweep.
  ['member-event-windows', '0 35 4 * * *', memberEventWindowsJob],
]

function buildDeps(opts: ScraperWiringOptions): JobDeps {
  const { db, tornBaseUrl, encryptionKey } = opts
  return {
    db,
    pool: createKeyPool({ db, encryptionKey }),
    encryptionKey,
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
