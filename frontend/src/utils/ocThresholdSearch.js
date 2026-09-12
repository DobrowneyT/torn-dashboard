/**
 * The threshold search (#692, slice 4 of #688): the minimum CPR we publish.
 *
 * Descends from slice 3's maximal vector looking for the one that maximises
 * `$ per faction member per day`. The ceiling is `maximalCprVector` (#691) —
 * above it the crime cannot be crewed.
 *
 * ## ⚠️ Scope is REPORTED here, not enforced
 *
 * Spawning costs scope up front and only success pays it back, so each category
 * has a break-even success chance of `scopeCost / scopeReward`, and a crime run
 * below it bleeds the resource that lets us spawn anything. An earlier version
 * of this module treated that as a hard floor and disqualified such vectors.
 *
 * **That was wrong, and it was wrong because scope is a PORTFOLIO question.**
 * MonChoon, 2026-09-12:
 *
 *   > I am okay to have the higher paying crimes scope negative in the hopes
 *   > that some lower ones balance it out (since we cant control spawning) and
 *   > if things get to a point where we need to fill up scope a bit, we can
 *   > always spawn some lower level crimes.
 *
 * Scope is fungible across the whole spawn mix and cheaply replenished by
 * running easier crimes. Refusing a lucrative crime because that ONE crime is
 * scope-negative optimises a sub-problem nobody has — and we do not control
 * what spawns anyway, so a per-crime veto buys nothing.
 *
 * So every candidate carries `netScope` and `aboveBreakEven` and none is
 * refused for it. Solvency across the mix belongs to #693, which simulates the
 * spawn distribution and can actually see the portfolio.
 *
 * ## Why this is affordable
 *
 * ⚠️ Every candidate vector costs a call to tornprobability — a small
 * third-party server this codebase is already careful with. A grid over six
 * roles is not on the table.
 *
 * The structure rescues it. For one crime, role count and roster size are
 * constant, so the objective reduces to maximising `k × E(X)`, where:
 *
 *   `k`    is a STEP function of the vector, changes only at reading values,
 *          and is FREE to evaluate (#689).
 *   `E(X)` is monotone in CPR and EXPENSIVE.
 *
 * So for each achievable `k` the best vector is the HIGHEST one still seating
 * `k` crews — and there are only a handful of achievable `k`. **One probability
 * call per crew count, not per vector.**
 *
 * ⚠️ `E(X)` monotonicity is an ASSUMPTION, not a proof. Raising a bar shifts
 * probability mass toward better endings, but ending payouts are not ordered —
 * a shift could land on a good ending that happens to pay less, particularly
 * where the reward is items. Verify it against a tenant with real readings
 * before treating the result as an optimum rather than a good heuristic.
 *
 * ## Agnostic to the tier ladder, deliberately
 *
 * No tier name, tier count or role count appears here. The break-even comes
 * from the caller's category record (`scopeCost` / `scopeReward`), which lives
 * in config. A tier added above Elaborate is a config entry, never a change to
 * this file.
 */

import { maxDisjointCrews } from './ocCrewMatching'
import { maximalCprVector } from './ocMaximalCpr'
import { perPersonPerDay } from './ocPersonDays'
import { maxSustainableCpr } from './ocRosterFit'

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

/** Ceiling on how many crew counts we will pay a probability call to explore. */
export const DEFAULT_MAX_CANDIDATES = 8

/**
 * The scope break-even success chance for a category.
 *
 * ⚠️ Derived, never tabulated. Advanced happens to be 4/5 today; if Torn
 * rebalances it, or adds a tier above Elaborate, this keeps working.
 *
 * Reported, not enforced — see the note at the top of this file.
 */
export function breakEvenFor(category) {
  const cost = num(category?.scopeCost)
  const reward = num(category?.scopeReward)
  if (cost === null || reward === null || reward <= 0) return null
  return cost / reward
}

/**
 * The highest vector that still seats `k` crews.
 *
 * Starts from the Hall-safe bar — `k·n` candidates per role guarantees `k`
 * crews, by the same argument slice 3 uses for `k = 1` — then greedily raises
 * each role while the matching still holds. The Hall bar alone is conservative
 * because it cannot see how disjoint the pools actually are; the raising step
 * recovers that, and costs nothing because matching is local.
 */
function highestVectorFor(readings, positions, k) {
  const n = positions.length
  const vector = {}
  for (const pos of positions) {
    const rows = (readings?.[pos] ?? []).filter((r) => num(r?.cpr) !== null)
    const safe = maxSustainableCpr(rows, k * n)
    if (safe === null) return null
    vector[pos] = safe
  }
  if (maxDisjointCrews(readings, vector).k < k) return null

  // Raise one role at a time to the next reading above its current bar, keeping
  // the move only while `k` survives. Ordered for determinism, not for merit —
  // a smarter order is a refinement, not a correctness issue.
  for (const pos of [...positions].sort()) {
    const above = [...new Set((readings[pos] ?? []).map((r) => num(r?.cpr)).filter((v) => v !== null))]
      .filter((v) => v > vector[pos])
      .sort((a, b) => a - b)
    for (const next of above) {
      const trial = { ...vector, [pos]: next }
      if (maxDisjointCrews(readings, trial).k >= k) vector[pos] = next
      else break
    }
  }
  return vector
}

/**
 * One vector per achievable crew count — the whole candidate set.
 *
 * ⚠️ Deliberately tiny. This is what makes the search affordable, and every
 * entry carries `verifiedCrews` so a caller can see the claim was checked
 * rather than assumed.
 */
export function candidateVectors(readings, positionIds, { maxCandidates = DEFAULT_MAX_CANDIDATES } = {}) {
  const positions = [...(positionIds ?? [])]
  if (positions.length === 0) return []

  const ceiling = maximalCprVector(readings, positions)
  if (!ceiling.crewable) return []

  const out = []
  const seen = new Set()
  for (let k = 1; k <= maxCandidates; k += 1) {
    const vector = highestVectorFor(readings, positions, k)
    if (vector === null) break
    // Two crew counts can share a vector when the roster steps; keep the first,
    // which is the one whose claim is the weaker and therefore always true.
    const fingerprint = positions.map((p) => vector[p]).join('|')
    if (seen.has(fingerprint)) continue
    seen.add(fingerprint)
    out.push({ crews: k, vector, verifiedCrews: maxDisjointCrews(readings, vector).k })
  }
  return out
}

/**
 * @param readings   per-role member CPR readings
 * @param positionIds the crime's roles
 * @param rosterSize  for the faction-wide figure
 * @param category    `{ scopeCost, scopeReward }` — supplies the break-even
 * @param probe       `async (vector) => ({ expectedValue, successChance })`.
 *   ⚠️ Injected, and the only expensive thing here. Keeping it a parameter is
 *   what lets this run against any tenant's data — forge has no readings for
 *   the roles this needs; tnl does.
 * @param incumbent   the currently published vector, used as a SEED only.
 */
export async function searchThresholds({
  readings, positionIds, rosterSize, category, probe, incumbent = null,
  gap, maxCandidates = DEFAULT_MAX_CANDIDATES,
} = {}) {
  const positions = [...(positionIds ?? [])]
  const breakEven = breakEvenFor(category)
  const candidates = candidateVectors(readings, positions, { maxCandidates })

  const empty = {
    chosen: null, evaluated: [], rejected: [], runnersUp: [], nearTie: false,
    breakEven, movedFrom: incumbent, movement: null,
  }
  if (candidates.length === 0) return { ...empty, reason: 'no-crewable-vector' }

  // ⚠️ The incumbent seeds the ORDER, not the outcome. Starting near last run's
  // answer converges sooner because roster composition moves slowly — but if
  // the roster degraded, that bar is now impossible and must fall. A margin
  // that kept it would publish a target nobody can hit, which is strictly worse
  // than churn: somebody trains toward an unreachable number for weeks.
  const distanceFromIncumbent = (c) =>
    incumbent === null
      ? 0
      : positions.reduce((d, p) => d + Math.abs((num(incumbent[p]) ?? 0) - c.vector[p]), 0)
  const ordered = [...candidates].sort((a, b) => distanceFromIncumbent(a) - distanceFromIncumbent(b) || a.crews - b.crews)

  const evaluated = []
  const rejected = []
  for (const candidate of ordered) {
    const { expectedValue, successChance } = (await probe(candidate.vector)) ?? {}
    const ex = num(expectedValue)
    const success = num(successChance)

    // ⚠️ The ONLY rejection. A crime with no reward coverage has no value we
    // can state, and scoring it as zero would read as "worthless" rather than
    // "unmeasured" (#441/#473/#351).
    if (ex === null) {
      rejected.push({ ...candidate, reason: 'no-expected-value' })
      continue
    }

    const metric = perPersonPerDay({
      expectedValue: ex, roleCount: positions.length, rosterSize, crews: candidate.crews, gap,
    })
    // Expected scope per spawn: the cost is spent either way, only success pays
    // back. Negative is allowed and reported, never a veto — see the file note.
    const cost = num(category?.scopeCost)
    const reward = num(category?.scopeReward)
    const netScope =
      cost === null || reward === null || success === null ? null : success * reward - cost
    evaluated.push({
      ...candidate, expectedValue: ex, successChance: success,
      score: metric.perFactionMember, perParticipant: metric.perParticipant,
      utilisation: metric.utilisation,
      netScope,
      aboveBreakEven: breakEven === null || success === null ? null : success >= breakEven,
    })
  }

  // ⚠️ Absent, not zero. Every candidate was unpriceable, so there is no
  // threshold to publish and saying so is the useful answer (#441/#473/#351).
  if (evaluated.length === 0) {
    return { ...empty, rejected, reason: 'no-expected-value' }
  }

  const ranked = [...evaluated].sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity))
  const chosen = ranked[0]
  const runnersUp = ranked.slice(1)

  // ⚠️ A runner-up within a whisker means the pick is arbitrary, and presenting
  // it as decided would overstate what we know.
  const nearTie =
    runnersUp.length > 0 && chosen.score > 0 && (chosen.score - runnersUp[0].score) / chosen.score < 0.01

  const movement =
    incumbent === null
      ? null
      : Object.fromEntries(
          positions.map((p) => [p, { from: num(incumbent[p]), to: chosen.vector[p] }])
        )

  return {
    chosen, evaluated, rejected, runnersUp, nearTie,
    breakEven, movedFrom: incumbent, movement, reason: null,
  }
}
