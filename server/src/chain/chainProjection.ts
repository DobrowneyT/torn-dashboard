/**
 * When is this chain going to finish? (#774.)
 *
 * The number that decides how many days to add to the sign-up window (#772),
 * and the honest answer to "how much longer are we doing this".
 */

/** Torn's cap. A chain cannot go past it, so it is what we project towards. */
export const CHAIN_TARGET = 100_000

/**
 * ⚠️ Whole days, never "the last N hours".
 *
 * Hit rate is violently diurnal: it collapses while the faction sleeps and
 * spikes in their evening. A rate taken over the last six hours and
 * extrapolated linearly says something wildly different at 03:00 TCT than at
 * 19:00 TCT — from the *same healthy chain*. Whole multiples of 24h average the
 * cycle out.
 *
 * (A per-hour-of-day profile is the better model and is deliberately not built
 * here. Noted, not attempted.)
 */
export const WINDOW_MS = 24 * 3600_000

/**
 * Below this there is not enough chain to say anything.
 *
 * ⚠️ On day one, six hours of data extrapolated to 100,000 hits is noise
 * wearing a date. An absent projection is fine; a confident wrong one is not,
 * because somebody will plan around it.
 */
export const MIN_WINDOW_MS = WINDOW_MS

/**
 * How wide the band is, as a share of the remaining time.
 *
 * ⚠️ A band, not a point — `travelEta` (#330) sets the house precedent for the
 * same reason. A projection eleven days out stated to the hour is false
 * precision, and the error here is far larger than travel's ±3%: the rate is
 * one faction's mood over a fortnight, not a published flight time.
 */
export const BAND = 0.25

export interface ChainReading {
  /** Chain position. */
  chain: number
  /** Epoch ms of the reading. */
  at: number
}

export type Projection =
  | { measured: false; reason: 'no-readings' | 'too-early' | 'stalled' | 'complete'
      current: number | null; hitsPerHour: number | null }
  | { measured: true; current: number; hitsPerHour: number
      remaining: number; earliest: number; latest: number; windowHours: number }

/**
 * Project from readings of the chain counter itself.
 *
 * ⚠️ **The chain counter, not a count of attacks.** Only qualifying attacks
 * advance a chain — a stealthed hit on someone already mugged does not — so
 * counting rows in `faction_attacks` measures effort, while the delta in
 * `faction_attacks.chain` measures the thing we are projecting. They are not
 * the same number and only one of them is the chain.
 */
export function projectChain(readings: ChainReading[], nowMs: number): Projection {
  const sorted = [...readings].filter((r) => Number.isFinite(r.chain) && Number.isFinite(r.at))
    .sort((a, b) => a.at - b.at)
  const latest = sorted[sorted.length - 1] ?? null
  if (!latest) return { measured: false, reason: 'no-readings', current: null, hitsPerHour: null }

  const current = latest.chain
  if (current >= CHAIN_TARGET) {
    return { measured: false, reason: 'complete', current, hitsPerHour: null }
  }

  // The oldest reading at or before the window edge — so the window is a full
  // day of elapsed time, not "however many readings happen to be here".
  const edge = latest.at - WINDOW_MS
  const first = [...sorted].reverse().find((r) => r.at <= edge) ?? sorted[0]
  const spanMs = latest.at - first.at
  if (spanMs < MIN_WINDOW_MS) {
    return { measured: false, reason: 'too-early', current, hitsPerHour: null }
  }

  const hits = current - first.chain
  const hitsPerHour = hits / (spanMs / 3600_000)
  // A chain that is not advancing has no finish to project. Saying "never" as a
  // date would be absurd; saying nothing is correct.
  if (hits <= 0) return { measured: false, reason: 'stalled', current, hitsPerHour: 0 }

  const remaining = CHAIN_TARGET - current
  const hoursLeft = remaining / hitsPerHour
  const centre = nowMs + hoursLeft * 3600_000
  const half = hoursLeft * BAND * 3600_000
  return {
    measured: true,
    current,
    hitsPerHour,
    remaining,
    earliest: Math.round(centre - half),
    latest: Math.round(centre + half),
    windowHours: Math.round(spanMs / 3600_000),
  }
}
