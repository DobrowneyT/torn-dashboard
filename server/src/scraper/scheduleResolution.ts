/**
 * Where a scraper job's cadence comes from (#609 slice 5).
 *
 * Three layers, most specific first:
 *
 *   1. `scraper_jobs.cron_schedule`  — this faction's own choice (NULL = unset)
 *   2. `fleet_flags['scraper.schedule.<job>']` — the control plane's default
 *   3. the code default in registerJobs.ts's JOB_TABLE
 *
 * ⚠️ **The tenant layer is the existing column, not a `feature_flags` row**, and
 * that is deliberate. Cadence already has a UI, an audit trail and a dedicated
 * admin route; adding a second place to set the same thing would mean two
 * answers to "what cadence is this job on" and no way to know which one the
 * scheduler read. `feature_flags` remains the tenant layer for every other
 * flag — this one consumer has a better-established home.
 *
 * ⚠️ **NULL in that column means "follow the fleet default", which is a real
 * setting rather than a missing one.** It was `NOT NULL` until migration 0058
 * precisely because the distinction did not exist; see featureFlags.ts for why
 * `local || global` is the bug this shape avoids.
 */
import cron from 'node-cron'
import { asString, scraperScheduleKey, type FlagResolver } from '../featureFlags.js'

export interface ScheduleResolution {
  jobName: string
  effective: string
  source: 'tenant' | 'fleet' | 'default'
  codeDefault: string
  tenantValue: string | null
  fleetValue?: string
  /** A configured expression that was rejected, and therefore ignored. */
  rejected?: string
}

export type CronValidator = (expression: string) => boolean

export interface ResolveScheduleArgs {
  jobName: string
  codeDefault: string
  /** The `scraper_jobs.cron_schedule` column. NULL = follow the fleet. */
  tenantValue: string | null
  flags?: FlagResolver
  isValid?: CronValidator
}

/**
 * ⚠️ **Every configured expression is validated, and an invalid one falls back
 * rather than throwing.**
 *
 * `cron.schedule()` throws on a malformed expression, and `scheduler.start()`
 * registers jobs in a loop — so one typo would abort the loop and leave every
 * job after it in the table unscheduled. Via a FLEET flag that is worse again:
 * a single bad character typed once in the admin console would stop scraping
 * for every faction at once, with the only symptom being that data quietly
 * stopped arriving. Falling back to the code default keeps the fleet running
 * and puts the mistake in the logs and on the admin page.
 */
export async function resolveJobSchedule(args: ResolveScheduleArgs): Promise<ScheduleResolution> {
  const isValid = args.isValid ?? ((e: string) => cron.validate(e))
  const base: ScheduleResolution = {
    jobName: args.jobName,
    effective: args.codeDefault,
    source: 'default',
    codeDefault: args.codeDefault,
    tenantValue: args.tenantValue,
  }

  const fleetFlag = args.flags ? asString(await args.flags.get(scraperScheduleKey(args.jobName))) : undefined
  if (fleetFlag !== undefined) base.fleetValue = fleetFlag

  // ⚠️ `!== null`, not a truthiness test. An empty string in that column is a
  // mistake rather than a setting, but it is still the tenant's row — so it is
  // reported as rejected instead of silently reading as "unset", which would
  // hide the mistake behind plausible behaviour.
  if (args.tenantValue !== null) {
    if (isValid(args.tenantValue)) {
      return { ...base, effective: args.tenantValue, source: 'tenant' }
    }
    base.rejected = args.tenantValue
  } else if (fleetFlag !== undefined) {
    if (isValid(fleetFlag)) {
      return { ...base, effective: fleetFlag, source: 'fleet' }
    }
    base.rejected = fleetFlag
  }

  return base
}
