// Production wiring: build the scraper core and register every ported job
// with its production cadence (registered disabled — per-job enablement is
// the admin's bring-up step). Called from main.ts; tests drive jobs directly. The admin surface gets the
// same table through createJobRunner (manual triggers share job code).
import type pg from 'pg'
import type { FlagResolver } from '../featureFlags.js'
import { createKeyPool } from './keyPool.js'
import { createTornClient } from './tornClient.js'
import { createRunLogger } from './runLog.js'
import { createScheduler } from './scheduler.js'
import { itemsSyncJob, type JobDeps } from './jobs/itemsSync.js'
import { warWrapUpJob } from './jobs/warWrapUp.js'
import { inventorySyncJob } from './jobs/inventorySync.js'
import { crimesSyncJob } from './jobs/crimesSync.js'
import { crimeOccupancyJob } from './jobs/crimeOccupancy.js'
import { cprScanJob } from './jobs/cprScan.js'
import { membersSyncJob } from './jobs/membersSync.js'
import { memberStatsJob } from './jobs/memberStats.js'
import { memberProfileJob } from './jobs/memberProfile.js'
import { memberBattleStatsJob } from './jobs/memberBattleStats.js'
import { statsSamplesPruneJob } from './jobs/statsSamplesPrune.js'
import { scraperRunsPruneJob } from './jobs/scraperRunsPrune.js'
import { warsSyncJob } from './jobs/warsSync.js'
import { attacksSyncJob } from './jobs/attacksSync.js'
import { dibsSummaryJob } from './jobs/dibsSummary.js'
import { statMeasurementsJob } from './jobs/statMeasurements.js'
import { eventBingoJob } from './jobs/eventBingo.js'
import { ocSuggestionsJob } from './jobs/ocSuggestionsJob.js'
import { memberThreadSweepJob } from './jobs/memberThreadSweep.js'
import { revivesContinuousJob } from './jobs/revivesSync.js'
import { factionsSyncJob } from './jobs/factionsSync.js'
import { warLifecycleJob } from './jobs/warLifecycle.js'
import { competitionsResolveJob } from './jobs/competitionsResolve.js'
import { chainSampleJob } from './jobs/chainSample.js'
import { activitySampleJob } from './jobs/activitySample.js'
import { factionUpgradesSyncJob } from './jobs/factionUpgradesSync.js'
import { memberHofSyncJob } from './jobs/memberHofSync.js'
import { grudgeRefreshJob } from './jobs/grudgeRefresh.js'
import { grudgeStatsJob } from './jobs/grudgeStats.js'
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
  /** Fleet defaults for job cadence (#609 slice 5). Shared with the admin
   *  routes so a flag write invalidates the same cache the scheduler reads. */
  flags?: FlagResolver
  /** Read-only pool on the shared `global` database (#609 slice 7). Absent
   *  means items-sync uses this faction's key pool, exactly as before. */
  globalDb?: pg.Pool
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
  // #1022/#1023 — the OC action feed's producers, 15 s behind the occupancy
  // poll whose snapshot they read. ⚠️ No Torn calls.
  ['oc-suggestions', '45 * * * * *', ocSuggestionsJob],
  // #774 — Chain Watch sampling. Both append-only, both OFF by default in the
  // sense that they cost nothing useful outside an event; leadership edits the
  // cadence in Global Admin (#756) when a chain starts.
  //
  // ⚠️ 4 minutes is enough for the chain BECAUSE PAYOUT IS HOURLY: a detection
  // error only changes what anybody is paid when the chain dies within four
  // minutes of an hour boundary. The War Room's 5-second poll would cost
  // ~200,000 calls over a twelve-day event to answer the same question.
  //
  // Offset off :00 and off each other so a 5-minute roster sweep and a
  // 4-minute chain poll never claim a key in the same second.
  ['chain-sample', '10 */4 * * * *', chainSampleJob],
  ['activity-sample', '40 */5 * * * *', activitySampleJob],
  ['cpr-scan', '0 30 5,17 * * *', cprScanJob],
  ['members-sync', '0 5 * * * *', membersSyncJob],
  // Member stats ONCE A DAY. Each run appends a slim sample to
  // member_stat_samples and refreshes the daily blob.
  //
  // ⚠️ This was every 4h from #227 until 2026-09-06, and the cost is what
  // changed it: the job spends ONE Torn call PER MEMBER per run, so a ~90-member
  // faction costs ~90 calls a run — 540/day at four-hourly against 90/day here,
  // and roughly 2,700 against 450 across the five tenants, all on the same
  // pooled keys every other job shares.
  //
  // ⚠️ The intraday cadence is NOT what makes competition results correct, which
  // is the reason it looked load-bearing. #230 added `captureBoundarySamples`:
  // a one-off timer fires at a competition's exact start and end and stamps a
  // sample at that instant (re-armed after a restart by `rearmAll`), and that
  // is what resolution reads. What a coarser cadence actually costs is (a)
  // mid-competition standings refreshing daily rather than six times a day, and
  // (b) a wider fallback if a boundary capture ever misses — the resolver
  // already flags such a row `partial`.
  ['member-stats', '0 5 1 * * *', memberStatsJob],
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
  // Prune the run log itself. ⚠️ Append-only since launch at ~2,250 rows a day
  // per tenant, and on 2026-09-10 that growth turned an inefficient
  // fleet-metrics query into a live outage. Keeps each job's newest success and
  // every failure since it, so neither figure the metrics endpoint reports can
  // silently shrink — see the job for why that is the hard part.
  ['scraper-runs-prune', '0 50 1 * * *', scraperRunsPruneJob],
  ['wars-sync', '0 10 */3 * * *', warsSyncJob],
  // #530 — freeze each finished war's dibs activity. ⚠️ Hourly, and cheap: it
  // does nothing at all unless a war has ended whose attacks have landed, and a
  // war it is not yet confident about simply waits for the next run. Offset into
  // the half-hour gap between the two attacks-sync runs (:20 and :50) so it
  // never reads the table mid-write.
  ['dibs-summary', '0 35 * * * *', dibsSummaryJob],
  // #996 — measured target stats from our own hits. ⚠️ No Torn calls: it reads
  // what attacks-sync (:20/:50) already stored, five minutes behind it.
  ['stat-measurements', '0 25,55 * * * *', statMeasurementsJob],
  // #965 — cross the automatic bingo squares. ⚠️ No Torn calls; it does nothing
  // unless an event with bingo on is running.
  ['event-bingo', '30 */5 * * * *', eventBingoJob],
  // #942 — queue membership notes for the Discord member threads. Every five
  // minutes: a join or a leave is worth logging promptly, and the sweep is two
  // small queries when nothing has changed, which is almost always.
  ['member-thread-sweep', '0 */5 * * * *', memberThreadSweepJob],
  // #945 — when a war ends: drive the final scrapes, verify every source is
  // there, then queue the whole roster's reports. ⚠️ Every ten minutes, and it
  // does nothing at all unless a war ended that has not been wrapped up. The
  // cadence is what sets how quickly a lagging source is retried; the retry
  // WINDOW is a tunable in faction_settings.
  ['war-wrap-up', '0 */10 * * * *', warWrapUpJob],


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
  // #395/#458: one snapshot of the faction's upgrades per day, so the calendar
  // can say what Steadfast was giving on a given date rather than repainting
  // history with today's numbers. Perks change on the order of weeks, so daily
  // is ample resolution and costs exactly one call. 02:10 sits in a gap between
  // the 01:xx cluster and member-battle-stats at 02:45.
  ['faction-upgrades', '0 10 2 * * *', factionUpgradesSyncJob],
  // #872 — ~1 call per member. Daily is affordable; per-page-load is not.
  // 01:35 is clear of member-stats (01:05) and member-profile (01:20).
  ['member-hof', '0 35 1 * * *', memberHofSyncJob],
  // #889 — the Book of Grudges target list.
  //
  // ⚠️ Cadence is a STATED choice. The list is unbounded by design, so the
  // cost is not "one call per member" but "one call per FACTION holding two or
  // more targets, plus one per loner". Every 15 minutes keeps hospital timers
  // usable for chaining without the list being able to run away with the call
  // budget as it grows.
  //
  // ⚠️ Purpose-scoped: it claims only keys whose owner accepted the Target
  // Lookups disclosure, and does nothing at all if none have. That is a
  // legitimate state, not a failure.
  // ⚠️ Ticks every MINUTE and decides for itself whether to work. Watch
  // mode on means a fast sharded refresh; off means one pass a quarter-hour.
  // One job rather than two, because two would double-refresh on every
  // minute where both happened to be due.
  ['grudge-refresh', '0 * * * * *', grudgeRefreshJob],
  // #889 slice 5 — battle stats for grudge targets.
  //
  // ⚠️ DAILY, not quarter-hourly like the refresh beside it, and the gap is
  // deliberate. These come from THIRD-PARTY servers we do not own, and spy
  // stats move on the order of weeks. It also refetches only what is stale, so
  // most runs do nothing at all. 03:20 is clear of the 01:xx–02:xx cluster.
  ['grudge-stats', '0 20 3 * * *', grudgeStatsJob],
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
    globalDb: opts.globalDb,
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
  const scheduler = createScheduler({ db: opts.db, runLogger, flags: opts.flags })

  // A previous process may have died mid-run (redeploy, crash, OOM), leaving
  // rows stuck 'running' forever. Close them out before we start so the run
  // history is honest and stale rows can't mask themselves as in-flight.
  const reaped = await runLogger.reapOrphanedRuns()
  if (reaped > 0) console.log(`[scraper] reaped ${reaped} orphaned running run(s) from a prior process`)

  // ⚠️ #945 — the wrap-up drives other jobs, and it must do so THROUGH the run
  // logger. `scheduler.runNow` ignores the enabled flag (which is right: the
  // wrap-up asked for this run explicitly) and records a run row, so the final
  // attack scrape appears in Global Admin's Recent Runs like any other. Calling
  // the job function directly would work and would be invisible, which is the
  // worse kind of working.
  //
  // Attached after the scheduler exists because it needs it. Only `war-wrap-up`
  // reads it.
  ;(deps as JobDeps & { runJob?: (n: string) => Promise<unknown> }).runJob =
    (name: string) => scheduler.runNow(name)

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

  // ⚠️ The same capability for a hand-triggered wrap-up, so "run now" on
  // war-wrap-up behaves like the scheduled one rather than quietly skipping the
  // scrapes it is supposed to drive.
  ;(deps as JobDeps & { runJob?: (n: string) => Promise<unknown> }).runJob =
    async (name: string) => {
      const entry = byName.get(name)
      if (!entry) throw new Error(`Unknown scraper job: ${name}`)
      return runLogger.withRun(name, () => entry.job(deps))
    }

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
