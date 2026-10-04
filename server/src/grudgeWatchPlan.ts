// How fast the Book of Grudges can refresh, and how to split it up (#889).
//
// ⚠️ **The list is unbounded by design**, so the refresh rate cannot be a
// constant. Twenty targets and four hundred targets are not the same job, and
// a cadence that suits one starves the other or floods Torn.
//
// The cost model, which is what makes a fast rate affordable at all:
//
//   /faction/{id}/members returns EVERY member's status in one call.
//
// So a sweep costs one call per faction holding two or more targets, plus one
// each for people who are alone in theirs or in none — not one per target.

/** Torn's documented ceiling, per key, per minute. */
export const TORN_CALLS_PER_KEY_PER_MINUTE = 100

/**
 * The share of a key's budget this feature may spend.
 *
 * ⚠️ A stated tunable, and deliberately a QUARTER. The pool is shared with
 * every other scraper — OC tracking, the War Room, member stats — and a watch
 * that spends a key's whole minute leaves nothing for them. The 2026-09-10
 * incident was exactly this shape: a job that looked affordable in isolation
 * starving the box once it ran alongside everything else.
 */
export const WATCH_KEY_SHARE = 0.25

/** One tick is one minute, matching the job's cron. */
export const TICK_SECONDS = 60

export interface WatchWork {
  /** Factions holding two or more targets — one call covers all of them. */
  factions: string[]
  /** Targets needing a call of their own: alone in a faction, or in none. */
  individuals: string[]
}

export interface WatchPlan {
  /** Calls a complete pass over every target would cost. */
  callsPerSweep: number
  /** Calls this feature may make in one tick. */
  callsPerTick: number
  /** Ticks a complete pass takes. 1 means every target, every tick. */
  shards: number
  /** How long a complete pass takes, which is the number people care about. */
  secondsPerSweep: number
}

/**
 * Work out the achievable refresh rate.
 *
 * ⚠️ Returns a plan even with no keys — `callsPerTick` is then 0 and the job
 * does nothing. That is a consent outcome, not an error: nobody has accepted
 * the Target Lookups disclosure yet.
 */
export function planWatchCycle(
  work: WatchWork,
  keys: number,
  share = WATCH_KEY_SHARE
): WatchPlan {
  const callsPerSweep = (work?.factions?.length ?? 0) + (work?.individuals?.length ?? 0)
  const usableKeys = Math.max(0, Math.floor(keys || 0))

  // ⚠️ `floor`, then a floor of 1 whenever there IS a key. Rounding down keeps
  // us inside the budget; the minimum of 1 stops a single key with a small
  // share from producing zero calls and a watch that silently never runs.
  const raw = Math.floor(usableKeys * TORN_CALLS_PER_KEY_PER_MINUTE * share)
  const callsPerTick = usableKeys === 0 ? 0 : Math.max(1, raw)

  if (callsPerSweep === 0 || callsPerTick === 0) {
    return { callsPerSweep, callsPerTick, shards: 1, secondsPerSweep: 0 }
  }

  const shards = Math.max(1, Math.ceil(callsPerSweep / callsPerTick))
  return {
    callsPerSweep,
    callsPerTick,
    shards,
    secondsPerSweep: shards * TICK_SECONDS,
  }
}

/**
 * The slice of work for this tick.
 *
 * ⚠️ **Derived from the clock, not from stored state.** A persisted cursor is
 * one more thing to get stuck: a crash mid-sweep, two processes, a reset to
 * zero that re-reads the same shard forever. Minute-of-epoch modulo the shard
 * count cycles through every slice and self-corrects if the shard count
 * changes, because the next tick simply lands somewhere valid.
 *
 * ⚠️ Factions come FIRST in the combined order so that, when the budget is
 * tight, the calls that cover the most targets are the ones that happen.
 */
export function shardFor(work: WatchWork, plan: WatchPlan, nowMs = Date.now()): WatchWork {
  if (plan.shards <= 1) return { factions: [...work.factions], individuals: [...work.individuals] }

  const combined = [
    ...work.factions.map((id) => ({ kind: 'faction' as const, id })),
    ...work.individuals.map((id) => ({ kind: 'individual' as const, id })),
  ]
  const index = Math.floor(nowMs / (TICK_SECONDS * 1000)) % plan.shards
  const size = Math.ceil(combined.length / plan.shards)
  const slice = combined.slice(index * size, index * size + size)

  return {
    factions: slice.filter((x) => x.kind === 'faction').map((x) => x.id),
    individuals: slice.filter((x) => x.kind === 'individual').map((x) => x.id),
  }
}

/** Plain words for the settings page, so the cadence is never a mystery. */
export function describePlan(plan: WatchPlan, keys: number): string {
  if (keys === 0) {
    return 'Nobody has accepted the Target Lookups disclosure yet, so nothing is being refreshed.'
  }
  if (plan.callsPerSweep === 0) return 'No targets to refresh.'
  const every = plan.secondsPerSweep <= TICK_SECONDS
    ? 'every minute'
    : `every ${Math.round(plan.secondsPerSweep / 60)} minutes`
  return `${plan.callsPerSweep} API ${plan.callsPerSweep === 1 ? 'call' : 'calls'} per full pass, `
    + `spread over ${plan.shards} ${plan.shards === 1 ? 'tick' : 'ticks'} — `
    + `every target refreshes ${every}.`
}
