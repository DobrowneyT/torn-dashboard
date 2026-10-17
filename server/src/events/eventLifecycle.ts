// Is a faction event upcoming, live, or over? (#969)
//
// ⚠️ **The end is not a date.** MonChoon: *"The event will end when our chain
// reaches 100k or when the chain dies, essentially. At minimum the event will
// last until November 1 16:00 TCT."* So:
//
//   - before `starts_at`              → upcoming
//   - before `min_ends_at`            → live, whatever the chain is doing
//   - after `min_ends_at`             → live until the chain ends, then over
//
// ⚠️ A chain that breaks BEFORE `min_ends_at` does not end the event early —
// members may start a new one, and the event runs to its minimum regardless.
//
// ⚠️ **Once over, it stays over.** "Is the chain running" read live would bring
// a finished event back to life the next time the faction started an ordinary
// chain a week later. So the end is derived from the APPEND-ONLY chain sample
// history — the first sample at or after `min_ends_at` showing the chain dead —
// and stamped into `ended_at`. It does not depend on anybody having looked.

/**
 * Torn's hard cap on a chain. ⚠️ A game fact, not a tunable: a chain cannot go
 * past it, so reaching it is the chain finishing.
 */
export const TORN_CHAIN_MAX = 100_000

export type EventPhase = 'upcoming' | 'live' | 'ended'

export interface EventTimes {
  starts_at: number          // epoch ms
  min_ends_at: number        // epoch ms
  ends_with_chain: boolean
  ended_at: number | null    // epoch ms, stamped once over
}

/**
 * The phase at `now`.
 *
 * `chainEndedAt` is the first moment at or after `min_ends_at` that the chain
 * was observed dead, or null if it has not been (or there is no data — see
 * `firstChainEndAfter`). ⚠️ Null means "keep going": an outage that stops the
 * sampler must never end the event.
 */
export function eventPhase(
  e: EventTimes, now: number, chainEndedAt: number | null,
): EventPhase {
  if (e.ended_at != null && now >= e.ended_at) return 'ended'
  if (now < e.starts_at) return 'upcoming'
  if (now < e.min_ends_at) return 'live'
  // Past the minimum. Without a chain to wait for, the minimum IS the end.
  if (!e.ends_with_chain) return 'ended'
  if (chainEndedAt != null && now >= chainEndedAt) return 'ended'
  return 'live'
}

/**
 * When the event ended, if it has — the value to stamp into `ended_at`.
 *
 * ⚠️ The DERIVED moment, not "now": stamping the time somebody happened to load
 * the page would put the end wherever the first visitor fell, and the report's
 * window would follow it.
 */
export function eventEndedAt(e: EventTimes, chainEndedAt: number | null): number | null {
  if (e.ended_at != null) return e.ended_at
  if (!e.ends_with_chain) return e.min_ends_at
  if (chainEndedAt == null) return null
  return Math.max(chainEndedAt, e.min_ends_at)
}

export interface ChainSample {
  sampled_at: number         // epoch ms
  chain_current: number | null
}

/** Is this sample a dead chain — broken, or complete? */
export function isChainOver(s: ChainSample): boolean {
  if (s.chain_current == null) return false
  return s.chain_current === 0 || s.chain_current >= TORN_CHAIN_MAX
}

/**
 * The first sample at or after `since` showing the chain over, or null.
 *
 * ⚠️ Samples with no reading (`chain_current` null) are skipped, not counted as
 * dead: a failed poll during an outage is an absence of information, and must
 * never end the event.
 */
export function firstChainEndAfter(samples: ChainSample[], since: number): number | null {
  let first: number | null = null
  for (const s of samples) {
    if (s.sampled_at < since || !isChainOver(s)) continue
    if (first === null || s.sampled_at < first) first = s.sampled_at
  }
  return first
}
