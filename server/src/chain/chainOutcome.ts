/**
 * How did the chain end, and when? (#774's derivation, needed by #773.)
 *
 * ⚠️ This is read back from `chain_samples` rather than caught in the moment.
 * The War Room's chain row is a singleton that every poll overwrites, so the
 * end would be a moment somebody had to be watching for; an append-only series
 * can be asked the question hours later, which is when the payout is actually
 * reconciled.
 */
import { CHAIN_TARGET } from './chainProjection.js'

export interface OutcomeSample {
  /** Epoch ms of the sample. */
  at: number
  /** Chain position at that moment, if known. */
  chain: number | null
  /** Absolute epoch SECONDS the cooldown runs to, or null when not in cooldown. */
  cooldown: number | null
}

export type ChainOutcome =
  | { state: 'running' | 'unknown'; endedAt: null; peak: number | null; dropped: false }
  | { state: 'ended'; endedAt: number; peak: number; dropped: boolean }

/**
 * ⚠️ **Cooldown means the chain is over.** Torn starts a cooldown the moment a
 * chain closes, whether it was banked at the cap or dropped, so the first
 * sample carrying one is the end — accurate to the sampling interval, and
 * honestly a *lower bound* rather than a derived fact.
 *
 * ⚠️ **"Dropped" is decided by the peak, not by the timer.** Reaching Torn's
 * 100,000 cap is the goal; ending below it is a drop. That distinction is what
 * decides whether the raffle runs at all (MonChoon, 2026-09-22: a dropped chain
 * still pays the slots, but the raffle does not run), so it must not be
 * inferred from something as incidental as which sample happened to catch the
 * transition.
 */
export function chainOutcome(samples: OutcomeSample[]): ChainOutcome {
  const sorted = [...samples].sort((a, b) => a.at - b.at)
  if (sorted.length === 0) return { state: 'unknown', endedAt: null, peak: null, dropped: false }

  const peak = sorted.reduce<number | null>(
    (max, s) => (s.chain != null && (max == null || s.chain > max) ? s.chain : max), null)

  const ended = sorted.find((s) => s.cooldown != null)
  if (!ended) return { state: 'running', endedAt: null, peak, dropped: false }

  return {
    state: 'ended',
    endedAt: ended.at,
    peak: peak ?? 0,
    dropped: (peak ?? 0) < CHAIN_TARGET,
  }
}
