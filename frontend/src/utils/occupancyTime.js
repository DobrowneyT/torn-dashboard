/**
 * Payout time from OBSERVED occupancy (#389 part 2).
 *
 * The poller (#389 part 1) records one stint per member per slot: when we first
 * saw them there, when we last saw them there. This turns those stints into the
 * per-member time a payout window should credit.
 *
 * The whole reason this exists is that Torn never reports a departure, so the
 * legacy path infers one from crime status and execution time. Four passes at
 * that inference were wrong. Nothing here infers anything: a stint ends when we
 * stopped seeing it, which is a fact with a known error bar.
 */
import { mergeIntervalSeconds } from './intervals'

/**
 * Number, or null — never 0 for an absent value.
 *
 * `Number(null)` is 0 and `Number.isFinite(0)` is true, so a plain
 * Number()-then-isFinite guard silently accepts a missing timestamp as the
 * epoch. That produced a [0, 0] interval here before the tests caught it: a
 * 1970 stint, clipped away by the window, so it would have vanished quietly
 * rather than failing. Same trap the repo already centralises in
 * utils/reading.js for stat readings.
 */
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

/** Poll cadence, from the scraper's `30 * * * * *`. The error bar on every end. */
export const POLL_INTERVAL_SECONDS = 60

/**
 * A gap longer than this means we stopped watching, not that a poll was late.
 *
 * Three missed polls rather than one: a single late tick is ordinary jitter
 * under load, and flagging every one would make the gap warning meaningless —
 * which is worse than not having it, because a warning people scroll past is
 * indistinguishable from a clean window.
 */
export const MAX_ACCEPTABLE_GAP_SECONDS = 3 * POLL_INTERVAL_SECONDS

/**
 * One stint's [start, end] in epoch seconds, or null if it is unusable.
 *
 * START is Torn's `torn_joined_at` when we have it. It is exact, where
 * `first_seen_at` is only as good as the poll interval — but it is also the
 * value the legacy path already trusted, so preferring it keeps the two
 * approaches comparable rather than introducing a second source of difference.
 *
 * END is always `last_seen_at`. Torn has no equivalent, so our observation is
 * the only answer, and it is deliberately a LOWER BOUND: the member left at
 * some point in the interval after we last saw them. Rounding it up to "now"
 * for an open stint would invent time we did not observe.
 */
export function stintInterval(stint) {
  const seen = num(stint?.first_seen_at)
  const end = num(stint?.last_seen_at)
  const start = num(stint?.torn_joined_at) ?? seen
  if (start === null || end === null) return null

  // torn_joined_at can predate our first sighting by a lot: a stint that began
  // before the poller existed. That is fine and is exactly why we prefer it.
  // But a joined_at AFTER the last sighting is contradictory data, and the
  // observation is the one we can defend.
  if (start > end) return seen === null ? null : [seen, end]
  return [start, end]
}

/**
 * Per-member credited seconds for the window, keyed by member id.
 *
 * The union (not the sum) of a member's intervals, per #262: a member can only
 * be in one OC at a time, so overlapping stints are the same wall-clock time
 * counted twice. Clipped to the window, so the total can never exceed it.
 */
export function occupancySecondsByMember(stints, fromTimestamp, toTimestamp) {
  const byMember = {}
  for (const stint of stints ?? []) {
    const interval = stintInterval(stint)
    if (!interval) continue
    const start = Math.max(interval[0], fromTimestamp)
    const end = Math.min(interval[1], toTimestamp)
    if (end <= start) continue
    const id = String(stint.member_id)
    ;(byMember[id] ??= []).push([start, end])
  }

  const out = {}
  for (const [id, intervals] of Object.entries(byMember)) {
    out[id] = { seconds: mergeIntervalSeconds(intervals), intervals }
  }
  return out
}

/**
 * Whether the poller actually watched this window, and where it did not.
 *
 * `polls` is `crime_occupancy_polls` rows (a `polled_at` each) overlapping the
 * window. A payout must not silently treat an unwatched stretch as "nobody
 * moved" — during a gap, anyone who left keeps accruing to the resume time.
 *
 * Returns `{ covered, gaps, pollCount, firstPollAt, lastPollAt, missingSeconds }`.
 * `covered` is false when there is ANY gap, including at the window's edges:
 * a poller started midway through the week never saw the first half, and that
 * is not a smaller problem than an outage in the middle.
 */
export function pollCoverage(polls, fromTimestamp, toTimestamp, maxGap = MAX_ACCEPTABLE_GAP_SECONDS) {
  const times = (polls ?? [])
    .map((p) => num(p?.polled_at ?? p))
    .filter((t) => t !== null)
    .sort((a, b) => a - b)

  if (times.length === 0) {
    return {
      covered: false,
      gaps: [[fromTimestamp, toTimestamp]],
      pollCount: 0,
      firstPollAt: null,
      lastPollAt: null,
      missingSeconds: Math.max(0, toTimestamp - fromTimestamp),
    }
  }

  const gaps = []
  // Leading edge: the stretch before the first poll inside the window.
  if (times[0] - fromTimestamp > maxGap) gaps.push([fromTimestamp, times[0]])
  for (let i = 1; i < times.length; i++) {
    if (times[i] - times[i - 1] > maxGap) gaps.push([times[i - 1], times[i]])
  }
  // Trailing edge.
  if (toTimestamp - times[times.length - 1] > maxGap) gaps.push([times[times.length - 1], toTimestamp])

  return {
    covered: gaps.length === 0,
    gaps,
    pollCount: times.length,
    firstPollAt: times[0],
    lastPollAt: times[times.length - 1],
    missingSeconds: gaps.reduce((s, [a, b]) => s + (b - a), 0),
  }
}

/**
 * How far our first sighting sits from Torn's own joined_at.
 *
 * MonChoon expects agreement within about two minutes. This is the check that
 * says whether the poller is keeping up — a drifting p95 means missed ticks,
 * and missed ticks are exactly what makes a stint end too late. Worth looking
 * at BEFORE trusting these intervals with money, which is why it ships with
 * the integration rather than after it.
 *
 * Only stints carrying both values can be compared; a stint that began before
 * the poller existed has nothing to compare against and is excluded rather
 * than counted as a perfect match.
 */
export function joinedAtDrift(stints) {
  const deltas = []
  for (const stint of stints ?? []) {
    const torn = num(stint?.torn_joined_at)
    const seen = num(stint?.first_seen_at)
    if (torn === null || seen === null) continue
    // A stint already running when the poller started would report a huge,
    // meaningless delta. Only compare where we plausibly witnessed the join.
    if (seen - torn > 24 * 3600) continue
    deltas.push(Math.abs(seen - torn))
  }
  if (deltas.length === 0) return { count: 0, median: null, p95: null, max: null, withinTolerance: null }

  deltas.sort((a, b) => a - b)
  const at = (q) => deltas[Math.min(deltas.length - 1, Math.floor(q * deltas.length))]
  const p95 = at(0.95)
  return {
    count: deltas.length,
    median: at(0.5),
    p95,
    max: deltas[deltas.length - 1],
    // Two minutes, per MonChoon's expectation. Judged on p95 rather than max:
    // one stint that straddled a restart should not condemn a healthy poller.
    withinTolerance: p95 <= 120,
  }
}
