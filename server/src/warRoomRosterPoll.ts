// Configurable roster refresh cadence (#339).
//
// The roster sync used to run on EVERY ticker tick, with the ticker hardcoded
// at 1 Hz — there was no setting for it anywhere. (The old client-side "UI
// Refresh" slider looked like this control but was never wired to anything.)
//
// Leads want it both ways: slower during a termed war, where a 1 Hz sweep of
// both rosters burns Torn calls for nothing, and faster during a live chain.
// So the cadence moves into config and the sync gets its own elapsed-time
// gate, exactly like the chain pollers.

/**
 * Absolute floor, in milliseconds — 2 Hz. The fastest we will EVER poll, and
 * only reachable by a faction with enough keys to spread the load (see
 * safeRosterIntervalMs — the real floor is usually higher).
 */
export const ROSTER_POLL_MIN_MS = 500

/** Ceiling — a minute between sweeps is already barely a "live" board. */
export const ROSTER_POLL_MAX_MS = 60_000

/** What the board polls at when nothing has been configured. */
export const ROSTER_POLL_DEFAULT_MS = 1000

/**
 * Torn calls per roster sync: the enemy roster and ours, both on the SAME
 * claimed key (see syncWarRoomMemberStates).
 */
const CALLS_PER_SYNC = 2

/**
 * Per-key ceiling we hold ourselves to, in calls per minute. Torn's hard limit
 * is 100/min per key; 80 leaves headroom for the chain pollers, the member
 * stats sweep and the background scrapers, which draw on the same keys.
 */
const PER_KEY_BUDGET_PER_MIN = 80

/**
 * The fastest cadence a pool of `poolSize` keys can actually sustain.
 *
 * This exists because the configured floor alone was not a safety limit
 * (#342). A sync spends two calls on ONE key, and `pool.claim()` rotates keys
 * between syncs, so the per-key rate is:
 *
 *     callsPerKeyPerMin = CALLS_PER_SYNC * (60000 / intervalMs) / poolSize
 *
 * Solving for the budget gives intervalMs >= 1500 / poolSize. So a one-key
 * pool cannot go below 1.5s, two keys manage 750ms, and three or more can
 * reach the 500ms floor. Setting 0.5s on a small pool previously blew straight
 * through Torn's limit — every sync threw, the ticker swallowed it, and the
 * board silently froze.
 */
export function minSustainableIntervalMs(poolSize: number): number {
  const keys = Math.max(1, Math.floor(Number(poolSize) || 0))
  const perKeyMs = (CALLS_PER_SYNC * 60_000) / (PER_KEY_BUDGET_PER_MIN * keys)
  return Math.max(ROSTER_POLL_MIN_MS, Math.ceil(perKeyMs))
}

/**
 * The interval to actually poll at: what was configured, but never faster than
 * the key pool can sustain. Returns the effective value so the caller can log
 * when it had to override the setting.
 */
export function safeRosterIntervalMs(configuredMs: unknown, poolSize: number): number {
  const configured = Number(configuredMs)
  const base = Number.isFinite(configured) && configured > 0
    ? configured
    : ROSTER_POLL_DEFAULT_MS
  return Math.min(ROSTER_POLL_MAX_MS, Math.max(minSustainableIntervalMs(poolSize), base))
}


/**
 * The ticker's own heartbeat. Must divide into the floor, or the fastest
 * configured cadence could never actually be met: a 1000ms heartbeat can only
 * deliver 1 Hz no matter what the config says.
 */
export const TICKER_HEARTBEAT_MS = ROSTER_POLL_MIN_MS

/** Is a roster sync due, given when the last one ran? */
export function rosterPollDue(
  lastSyncMs: number | null | undefined,
  intervalMs: number,
  nowMs: number
): boolean {
  const interval = Number(intervalMs)
  const effective = Number.isFinite(interval)
    ? Math.min(ROSTER_POLL_MAX_MS, Math.max(ROSTER_POLL_MIN_MS, interval))
    : ROSTER_POLL_DEFAULT_MS
  if (lastSyncMs == null || !Number.isFinite(Number(lastSyncMs))) return true
  return nowMs - Number(lastSyncMs) >= effective
}
