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
const usableRows = (readings, pos) => (readings?.[pos] ?? []).filter((r) => num(r?.cpr) !== null)

/** The lowest CPR anyone has been observed at for a role — the "carry" floor. */
function rosterFloor(readings, pos) {
  const values = usableRows(readings, pos).map((r) => num(r.cpr))
  return values.length === 0 ? null : Math.min(...values)
}

/**
 * The highest vector that still seats `k` crews.
 *
 * `pinned` holds roles whose bar is FIXED and must not be raised — that is how
 * a carry role is expressed. Pinning one role low strictly enlarges its
 * eligible set, so it can only ever help the matching, never break it.
 *
 * Starts from the Hall-safe bar — `k·n` candidates per role guarantees `k`
 * crews, by the same argument slice 3 uses for `k = 1` — then greedily raises
 * each unpinned role while the matching still holds. The Hall bar alone is
 * conservative because it cannot see how disjoint the pools actually are; the
 * raising step recovers that, and costs nothing because matching is local.
 */
function highestVectorFor(readings, positions, k, pinned = {}, weights = null) {
  const n = positions.length
  const vector = {}
  for (const pos of positions) {
    if (pinned[pos] !== undefined) { vector[pos] = pinned[pos]; continue }
    const safe = maxSustainableCpr(usableRows(readings, pos), k * n)
    if (safe === null) return null
    vector[pos] = safe
  }
  if (maxDisjointCrews(readings, vector).k < k) return null

  // Raise one role at a time to the next reading above its current bar, keeping
  // the move only while `k` survives.
  //
  // ⚠️ **The order is not cosmetic — it decides which role gets starved.** The
  // roles share a member pool, so whoever is raised first takes first claim on
  // the strongest members and whoever is raised last gets the leftovers. An
  // earlier version sorted by position id, which meant the sacrificed role was
  // whichever happened to sort last: on a six-role crime that is P6, chosen for
  // no reason at all.
  //
  // Ordering by WEIGHT descending makes the sacrifice deliberate — the role
  // that moves success chance most gets the best people, and the least
  // important role absorbs the shortfall. That IS the source document's carry
  // trade, applied on every candidate rather than only the explicit one below.
  // Weights are static per crime, so the order is a property of the crime.
  const order = [...positions].sort((a, b) => {
    const wa = weights ? num(weights[a]) : null
    const wb = weights ? num(weights[b]) : null
    if (wa !== null && wb !== null && wa !== wb) return wb - wa
    return String(a).localeCompare(String(b), 'en', { numeric: true })
  })
  for (const pos of order) {
    if (pinned[pos] !== undefined) continue
    const above = [...new Set(usableRows(readings, pos).map((r) => num(r.cpr)))]
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
/**
 * One vector per achievable crew count — plus, where `weights` are supplied, a
 * CARRY variant of each.
 *
 * ⚠️ **The carry variant is the trade the source document calls the usual best
 * one**, and the first cut of this module could not express it at all:
 *
 *   > If we can drop a role to a full carry, like Thief 1 / Picklock 2 then
 *   > prioritise doing that and make the other roles a couple points higher.
 *
 * Raising every role as high as it independently goes never *sacrifices* one to
 * lift the others, so an unequal vector was never generated. On Blast from the
 * Past that is Picklock 2 at 2.9% impact against Muscle at 34.6% — dropping the
 * carry to the roster floor frees a large pool on that role at almost no cost
 * to success chance, which is exactly the trade the objective rewards.
 *
 * ⚠️ The carry is chosen by **weight**, never by position order. Weights are
 * static per crime (tornprobability, summing to 100), so this is a property of
 * the crime rather than of the roster.
 *
 * ⚠️ **Budgeted: at most ONE carry variant per crew count**, because every
 * candidate costs a probability call. The lowest-weight role is tried and no
 * other — a search over which subset to carry would be combinatorial, and the
 * document only ever describes carrying one.
 *
 * ⚠️ It is a candidate, not a preference. If dropping the role costs more than
 * the crews are worth, `searchThresholds` rejects it like anything else.
 */
export function candidateVectors(
  readings, positionIds, { maxCandidates = DEFAULT_MAX_CANDIDATES, weights = null } = {}
) {
  const positions = [...(positionIds ?? [])]
  if (positions.length === 0) return []

  const ceiling = maximalCprVector(readings, positions)
  if (!ceiling.crewable) return []

  // Lowest weight wins, ties broken by position id so the choice is stable.
  let carryRole = null
  if (weights) {
    const ranked = positions
      .filter((p) => num(weights[p]) !== null)
      .sort((a, b) => num(weights[a]) - num(weights[b]) || String(a).localeCompare(String(b)))
    carryRole = ranked[0] ?? null
  }
  const carryFloor = carryRole === null ? null : rosterFloor(readings, carryRole)

  const out = []
  const seen = new Set()
  const add = (k, vector, role) => {
    if (vector === null) return false
    // Two crew counts can share a vector when the roster steps; keep the first,
    // which is the one whose claim is the weaker and therefore always true.
    const fingerprint = positions.map((p) => vector[p]).join('|')
    if (seen.has(fingerprint)) return true
    seen.add(fingerprint)
    out.push({
      crews: k, vector, carryRole: role,
      verifiedCrews: maxDisjointCrews(readings, vector).k,
    })
    return true
  }

  for (let k = 1; k <= maxCandidates; k += 1) {
    const flat = highestVectorFor(readings, positions, k, {}, weights)
    if (flat === null) break
    add(k, flat, null)
    // ⚠️ The carry variant is kept ONLY when it lifts another role.
    //
    // E(X) is monotone in CPR (verified across six scenarios, 2026-09-12), so a
    // vector that merely lowers the carry role and changes nothing else can
    // only score WORSE — and every candidate costs a probability call. Keeping
    // it unconditionally would double the budget to evaluate vectors we already
    // know lose.
    //
    // ⚠️ This is NOT the whole of the source document's carry rule. Publishing
    // `0` on a low-impact role is a PRESENTATION decision, not a scoring one:
    // the bar is a floor, not a prediction, and members will bring whoever is
    // free to that seat. Scoring a vector at its pinned-low CPR understates
    // what actually happens. That half belongs to #694.
    if (carryRole !== null && carryFloor !== null) {
      const carried = highestVectorFor(readings, positions, k, { [carryRole]: carryFloor }, weights)
      const liftsSomething =
        carried !== null && positions.some((p) => p !== carryRole && carried[p] > flat[p])
      if (liftsSomething) add(k, carried, carryRole)
    }
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
  gap, maxCandidates = DEFAULT_MAX_CANDIDATES, weights = null,
} = {}) {
  const positions = [...(positionIds ?? [])]
  const breakEven = breakEvenFor(category)
  const candidates = candidateVectors(readings, positions, { maxCandidates, weights })

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
