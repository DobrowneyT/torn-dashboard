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
 * Hard floor, in milliseconds — 2 Hz.
 *
 * Each roster sync is two Torn calls (their faction + ours), so 2 Hz is 240
 * calls a minute against a pool that also serves chains, member stats and the
 * background scrapers. This is a rate-limit guard, not a preference: it is
 * enforced here AND in CONFIG_BOUNDS, so a value written straight into the
 * database still cannot outrun it.
 */
export const ROSTER_POLL_MIN_MS = 500

/** Ceiling — a minute between sweeps is already barely a "live" board. */
export const ROSTER_POLL_MAX_MS = 60_000

/** What the board polls at when nothing has been configured. */
export const ROSTER_POLL_DEFAULT_MS = 1000

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
