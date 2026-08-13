/**
 * Turning the #389 occupancy diagnostics into something a human can act on.
 *
 * The poller (#389 part 1) and the per-member arithmetic (#389 part 2) are both
 * in place, and the payout page already carries `occupancyCoverage`,
 * `occupancyDrift` and a per-member `observedSeconds`. None of it is shown.
 *
 * This module is the judgement layer between the raw numbers and the page. It
 * exists as its own tested unit because the decision it encodes is the whole
 * point of the ticket: MonChoon watches observed time against inferred time for
 * a few weeks, and then decides whether observation is allowed to move money.
 * A panel that made that comparison look better than it is would corrupt
 * exactly the evidence it was built to supply.
 *
 * ⚠️ The distinction this module refuses to blur, from #330: "we did not watch"
 * is not "we watched and saw nothing". A window the poller never covered must
 * never render as a table of zeroes, because zeroes look like observations.
 */
import { formatTimeHours } from './payoutCalculations'
import { MAX_ACCEPTABLE_GAP_SECONDS, POLL_INTERVAL_SECONDS } from './occupancyTime'

/** How far apart two figures must be before the divergence list mentions them. */
export const DIVERGENCE_FLOOR_SECONDS = 30 * 60

/**
 * Fraction of the window that may be unwatched before coverage reads as broken
 * rather than merely imperfect.
 *
 * A few scattered missed ticks across a week are ordinary; an hour-long hole is
 * not. Both are reported, but only the second should stop someone trusting the
 * numbers, and a warning that fires on both teaches people to ignore it.
 */
export const DEGRADED_COVERAGE_FRACTION = 0.01

/**
 * A single gap this long is an outage no matter how small a share of the window
 * it is.
 *
 * The fraction test alone is too forgiving over a long window — 1% of a week is
 * still an hour and three quarters, which is ample time for a member to join a
 * crime, leave it, and have the whole stint credited to the resume. Whichever
 * test fires first wins.
 */
export const SIGNIFICANT_GAP_SECONDS = 15 * 60

/**
 * Overall verdict for a payout window's occupancy data.
 *
 * Returns one of four states, deliberately including the two "no data" cases as
 * distinct outcomes rather than collapsing them to a falsy:
 *
 *   `unavailable` — the result carries no coverage object at all. A payout
 *                   loaded from the database predates this feature, or was
 *                   saved before the poller existed. Show nothing; there is no
 *                   claim to make.
 *   `unwatched`   — coverage exists and reports zero polls. We know we were not
 *                   looking. That is a fact worth stating, and the opposite of
 *                   the observed figures being zero.
 *   `degraded`    — polled, with holes big enough to matter.
 *   `watched`     — polled continuously, within the gap tolerance.
 */
export function coverageVerdict(coverage, windowStart, windowEnd) {
  if (!coverage) return { state: 'unavailable', gaps: [], missingSeconds: 0, pollCount: 0 }

  const span = Math.max(0, (windowEnd ?? 0) - (windowStart ?? 0))
  const missingSeconds = coverage.missingSeconds ?? 0
  const pollCount = coverage.pollCount ?? 0
  const gaps = coverage.gaps ?? []

  if (pollCount === 0) {
    return { state: 'unwatched', gaps, missingSeconds, pollCount, span, missingFraction: 1 }
  }

  const missingFraction = span > 0 ? missingSeconds / span : 0
  // Expected ticks over the window, for "384 of 10080 polls" style context —
  // a poll count on its own means nothing to a reader.
  const expectedPolls = span > 0 ? Math.round(span / POLL_INTERVAL_SECONDS) : 0
  const longestGap = gaps.reduce((max, [a, b]) => Math.max(max, b - a), 0)

  // Note this deliberately does NOT key off `coverage.covered`. That flag goes
  // false on any gap over three poll intervals — correct for its own purpose,
  // but it makes one four-minute hiccup indistinguishable from a four-hour
  // outage, and a warning that fires on both gets ignored on both.
  const degraded =
    longestGap >= SIGNIFICANT_GAP_SECONDS || missingFraction > DEGRADED_COVERAGE_FRACTION

  return {
    state: degraded ? 'degraded' : 'watched',
    gaps,
    // Kept separate so a clean-but-jittery window can say so quietly instead of
    // claiming gapless coverage it did not have.
    minorGaps: degraded ? 0 : gaps.length,
    longestGap,
    missingSeconds,
    missingFraction,
    pollCount,
    expectedPolls,
    span,
  }
}

/**
 * Whether the poller is keeping up, in the words the ticket asked the question in.
 *
 * `withinTolerance` is already computed against MonChoon's stated ~2 minute
 * expectation; this adds the "no evidence yet" case, which is neither pass nor
 * fail. A poller that has been running an hour has witnessed very few joins,
 * and reporting that as a pass would put a green tick on an untested claim.
 */
export function driftVerdict(drift) {
  if (!drift || drift.count === 0) {
    return { state: 'no-evidence', count: 0, median: null, p95: null, max: null }
  }
  return {
    state: drift.withinTolerance ? 'ok' : 'drifting',
    count: drift.count,
    median: drift.median,
    p95: drift.p95,
    max: drift.max,
  }
}

/**
 * Observed vs inferred, per member, worst disagreements first.
 *
 * This is the comparison the whole observation period is for, so it reports the
 * disagreement rather than summarising it away. Members are only listed once
 * they differ by more than DIVERGENCE_FLOOR_SECONDS — below that the difference
 * is within the poll interval's own error bar plus rounding, and a list where
 * everyone appears tells you nothing about who to look at.
 *
 * `direction` names which way the disagreement runs, because the two mean
 * different things:
 *   `over-inferred`  — the legacy figure credits MORE than we watched. This is
 *                      the reported bug's fingerprint: time inferred past a
 *                      departure Torn never announced.
 *   `under-observed` — we watched LESS than the legacy figure because the
 *                      poller was not running for part of the stint. Expected
 *                      while the window predates the poller; not a payout bug.
 */
export function memberDivergences(members, { floor = DIVERGENCE_FLOOR_SECONDS } = {}) {
  const rows = []
  for (const member of members ?? []) {
    // Absent, not zero. A member with no observedSeconds field at all is from a
    // saved week and has nothing to compare; treating that as 0 would invent a
    // total divergence for every member of every historical payout.
    if (member?.observedSeconds === undefined || member?.observedSeconds === null) continue
    const inferred = member.timeSpent ?? 0
    const observed = member.observedSeconds
    const delta = observed - inferred
    if (Math.abs(delta) < floor) continue
    rows.push({
      userId: member.userId,
      name: member.name,
      inferred,
      observed,
      delta,
      direction: delta < 0 ? 'over-inferred' : 'under-observed',
    })
  }
  return rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
}

/**
 * The one-line summary: do the two methods agree in aggregate?
 *
 * Totals only, because per-member noise cancels and the aggregate is what a
 * payout pool is actually divided by. Returns null when there is nothing to
 * compare, rather than a zero that would read as perfect agreement.
 */
export function occupancySummary(members) {
  const comparable = (members ?? []).filter(
    (m) => m?.observedSeconds !== undefined && m?.observedSeconds !== null
  )
  if (comparable.length === 0) return null

  const inferred = comparable.reduce((s, m) => s + (m.timeSpent ?? 0), 0)
  const observed = comparable.reduce((s, m) => s + m.observedSeconds, 0)
  return {
    memberCount: comparable.length,
    inferred,
    observed,
    delta: observed - inferred,
    // Guarded: a window where nothing was inferred has no ratio, and 0/0 must
    // not surface as agreement.
    ratio: inferred > 0 ? observed / inferred : null,
  }
}

/** "1h 12m of a 7d window", for gap and drift copy. */
export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds ?? 0))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) {
    const h = Math.floor(s / 3600)
    const m = Math.round((s % 3600) / 60)
    return m === 0 ? `${h}h` : `${h}h ${m}m`
  }
  const d = Math.floor(s / 86400)
  const h = Math.round((s % 86400) / 3600)
  return h === 0 ? `${d}d` : `${d}d ${h}h`
}

/** Signed hours, so a divergence reads as a direction and not just a size. */
export function formatDelta(seconds) {
  const sign = seconds > 0 ? '+' : seconds < 0 ? '−' : ''
  return `${sign}${formatTimeHours(Math.abs(seconds))}`
}

export { MAX_ACCEPTABLE_GAP_SECONDS, POLL_INTERVAL_SECONDS }
