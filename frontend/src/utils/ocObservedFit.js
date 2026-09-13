/**
 * The model's predicted success against the faction's own history (#728).
 *
 * ⚠️ Every success figure on the Simulator is tornprobability's. Forge has 370
 * Advanced runs where we know the crew and the outcome, and on its highest
 * earner the two disagree: Break the Bank shows **no measurable gain** across
 * the CPR range Forge operates in, while the guidance pushes its bar toward a
 * threshold that fields zero crews.
 *
 * This does not refit anything. It reports the gap, so a number built on a
 * model can be read next to what actually happened.
 */

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

/**
 * ⚠️ A stated tolerance, not a discovered one. Below this the two are treated
 * as agreeing — a success rate measured over tens of runs carries several
 * points of sampling noise, and flagging that as a disagreement would cry wolf
 * on every crime.
 */
export const DISAGREEMENT_POINTS = 0.08

/**
 * How far the published crew may sit outside the observed CPR range before the
 * comparison stops being a comparison. Beyond it we have never run the crime
 * that way, and saying anything would dress an extrapolation as a measurement.
 */
export const MAX_EXTRAPOLATION_CPR = 5

export function compareToObserved({ observed, predicted, crewCpr } = {}) {
  const p = num(predicted)
  const crew = num(crewCpr)
  const none = { bucket: null, observedRate: null, gap: null, direction: null, disagrees: false }

  if (!observed?.enough || (observed.buckets ?? []).length === 0) {
    return { ...none, status: 'no-history', runs: observed?.runs ?? 0 }
  }
  if (p === null) return { ...none, status: 'no-prediction', runs: observed.runs }

  const buckets = observed.buckets
  // ⚠️ Nearest by the crew's own CPR, not the highest bucket. Comparing a
  // published floor against our best-ever crew would make every model look
  // pessimistic.
  const nearest = crew === null
    ? buckets[buckets.length - 1]
    : buckets.reduce((best, b) =>
      Math.abs(b.meanCpr - crew) < Math.abs(best.meanCpr - crew) ? b : best)

  if (crew !== null) {
    const lo = Math.min(...buckets.map((b) => b.lo))
    const hi = Math.max(...buckets.map((b) => b.hi))
    if (crew < lo - MAX_EXTRAPOLATION_CPR || crew > hi + MAX_EXTRAPOLATION_CPR) {
      return { ...none, status: 'out-of-range', runs: observed.runs, range: [lo, hi] }
    }
  }

  const gap = p - nearest.rate
  const disagrees = Math.abs(gap) >= DISAGREEMENT_POINTS
  return {
    status: disagrees ? 'disagrees' : 'agrees',
    bucket: nearest,
    observedRate: nearest.rate,
    runs: observed.runs,
    gap,
    direction: gap > 0 ? 'model-optimistic' : 'model-pessimistic',
    disagrees,
  }
}
