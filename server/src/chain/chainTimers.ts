/**
 * Torn's chain timers, in the form this epic stores them (#774).
 *
 * Torn sends `timeout` and `cooldown` as RELATIVE seconds — `timeout: 184`
 * means "184s until the chain drops" — which is useless in a row somebody reads
 * an hour later. They are converted to absolute epochs on the way in, so a
 * sample means the same thing whenever it is read.
 *
 * ⚠️ **Chain Watch owns this, and shares nothing with the War Room.** The War
 * Room does the same conversion for its own live board; that is a resemblance,
 * not a dependency. Importing across would tie a twelve-day event's payout
 * record to a module whose job is a 1 Hz battle display, and a change made for
 * one would land in the other with nobody looking.
 */

/**
 * Relative seconds → absolute epoch seconds, or null when there is no timer
 * running at all.
 *
 * ⚠️ `0` and absent both mean "no timer", and both must produce null rather
 * than the current time — a zero that survives as `now` reads as a chain about
 * to drop this instant.
 */
export function toAbsoluteEpoch(relative: unknown, nowEpochSec: number): number | null {
  const n = Number(relative)
  return Number.isFinite(n) && n > 0 ? nowEpochSec + n : null
}
