/**
 * CPR thresholds for ALL crimes at once, against one shared roster (#710).
 *
 * ⚠️ **Why the per-crime answer is too high.** #707 wires slices 3 → 4 → 6 and
 * skips the spawn simulation, so `searchThresholds` maximises
 * `$/faction-member/day` for ONE crime with the ENTIRE roster available. The
 * optimum for that question is naturally "take the strongest people" — and
 * every crime reaches it independently, so four Advanced crimes each assume
 * first claim on an overlapping twenty. **Individually optimal, jointly
 * unfillable.**
 *
 * MonChoon on the first live output: *"It might make sense from a single crime
 * perspective, but we need to look at it holistically."*
 *
 * The per-crime number is not wrong; it is a **ceiling**. This descends from it.
 *
 * ## How it stays affordable
 *
 * ⚠️ Every candidate vector is a request to tornprobability. A joint search
 * cannot be a product of per-crime candidate sets.
 *
 * It does not have to be, because **`E(X)` for a crime at a vector does not
 * depend on the other crimes**. So each crime's candidates are priced ONCE —
 * the same handful #707 already pays for — and the joint search then runs
 * entirely on cached values with **zero further calls**. What it costs is CPU,
 * and the simulation is local.
 *
 * ## The search
 *
 * Coordinate descent from the per-crime ceilings: repeatedly take the crime
 * whose stepping down improves the whole mix most, until nothing helps. That is
 * greedy rather than optimal, and deliberately so — the exact solve is a
 * combinatorial problem over a shared roster, and a leader needs an answer they
 * can read and a reason for every concession more than they need the last 1%.
 */

import { candidateVectors } from './ocThresholdSearch'
import { maximalCprVector } from './ocMaximalCpr'
import { simulateSpawns } from './ocSpawnSimulation'
import { makeProbe } from './ocGuidancePipeline'

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

/** ⚠️ Bounded: the product of candidate counts is what this exists to avoid. */
export const DEFAULT_MAX_ROUNDS = 40

export async function solveJointThresholds({
  crimes = [], readings = {}, rosterSize = null, call,
  days = 30, spawnsPerDay = 1, gap, scope,
  maxCandidates, maxRounds = DEFAULT_MAX_ROUNDS,
  // ⚠️ The inner loop runs on a SHORTER horizon than the report. Its job is to
  // RANK candidate sets, not to produce the published figure, and the ranking
  // is stable well before thirty days. The simulation is the hot loop — eight
  // crimes over thirty days at two spawns a day is ~15,000 crew matchings per
  // pass — so this is most of what keeps the solve usable in a click handler.
  searchDays = 12,
} = {}) {
  const perCrimeCeiling = {}
  const laddersByName = {}
  const skipped = {}
  let probeCalls = 0

  // ── 1. Per crime, in isolation: the ceiling and the candidate ladder ──────
  for (const c of crimes) {
    const crimeReadings = readings?.[c.name] ?? {}
    const ceiling = maximalCprVector(crimeReadings, c.positionIds)
    if (!ceiling.crewable) {
      // ⚠️ "Never observed" is a gap in our measurement, not a verdict on the
      // roster (#351). The two must survive all the way to the caller.
      const everObserved = (pos) => (crimeReadings?.[pos] ?? []).some((r) => num(r?.cpr) !== null)
      const unread = ceiling.limitingRoles.filter((p) => !everObserved(p))
      skipped[c.name] = unread.length > 0 ? 'no-readings' : 'not-crewable'
      continue
    }
    perCrimeCeiling[c.name] = ceiling

    const weights = Object.fromEntries((c.roles ?? []).map((r) => [r.position_id, num(r.weight)]))
    const cands = candidateVectors(crimeReadings, c.positionIds, { weights, maxCandidates })
    if (cands.length === 0) { skipped[c.name] = 'not-crewable'; continue }

    // ⚠️ Priced once, here, and never again. Everything below is cached.
    const probe = makeProbe({ scenario: c, call })
    const priced = []
    for (const cand of cands) {
      probeCalls += 1
      const { expectedValue, successChance } = await probe(cand.vector)
      if (expectedValue === null) continue
      priced.push({ ...cand, expectedValue, successChance })
    }
    if (priced.length === 0) { skipped[c.name] = 'no-expected-value'; continue }

    // Strongest crew first, so index 0 is this crime's ceiling and descending
    // the ladder means conceding.
    priced.sort((a, b) => a.crews - b.crews)
    laddersByName[c.name] = priced
  }

  const solvable = crimes.filter((c) => laddersByName[c.name])
  if (solvable.length === 0) {
    return {
      chosen: {}, perCrimeCeiling, concessions: {}, skipped,
      score: null, simulation: null, probeCalls, rounds: 0,
    }
  }

  // ── 2. Descend jointly ───────────────────────────────────────────────────
  const at = Object.fromEntries(solvable.map((c) => [c.name, 0]))

  const scenariosFor = (picks) => solvable.map((c) => ({
    name: c.name,
    positionIds: c.positionIds,
    vector: laddersByName[c.name][picks[c.name]].vector,
    category: c.category,
    expectedValue: laddersByName[c.name][picks[c.name]].expectedValue,
    successChance: laddersByName[c.name][picks[c.name]].successChance,
    spawnWeight: c.spawnWeight,
  }))

  // ⚠️ Memoised on the pick tuple. Coordinate descent revisits the same
  // combinations across rounds, and each miss is a full spawn simulation.
  const seen = new Map()
  const evaluate = (picks) => {
    const key = solvable.map((c) => picks[c.name]).join('|')
    const hit = seen.get(key)
    if (hit) return hit
    const sim = simulateSpawns({
      scenarios: scenariosFor(picks),
      readings, days: searchDays, spawnsPerDay, gap, rosterSize, scope,
    })
    const out = { sim, score: sim.income.perFactionMemberPerDay ?? sim.income.total, picks: { ...picks } }
    seen.set(key, out)
    return out
  }

  let current = evaluate(at)
  let rounds = 0

  // ⚠️ **Every rung, not the next one.** The score landscape is not smooth and
  // a single-step descent parks in the first dip. Measured on a 24-member
  // roster with one 4-role crime:
  //
  //     k=1  filled  8/30  score   990,741   <- a step-at-a-time search stops here
  //     k=4  filled  8/30  score   814,815
  //     k=5  filled 16/30  score 1,611,111   <- 63% better, never reached
  //
  // `filled` is a STEP function: a crew locks n members for n days, so the bar
  // has to fall a long way before a second crime fits alongside the first, and
  // everything in between is strictly worse. Looking one rung ahead sees only
  // the valley.
  //
  // Coordinate descent over the FULL ladder escapes that: each crime is moved
  // to its own best rung given the others, repeated to convergence. Still not
  // the exact joint optimum — that is combinatorial over a shared roster — but
  // it cannot be trapped by a dip inside one crime's ladder, which is the
  // failure that actually occurs.
  //
  // Every evaluation is cached `E(X)` plus a local simulation, so this costs
  // CPU and NOT a single extra probability call.
  for (; rounds < maxRounds; rounds += 1) {
    let improved = false
    // Deterministic order — a plan that reshuffles between runs is not a plan.
    for (const c of [...solvable].sort((a, b) => a.name.localeCompare(b.name))) {
      const ladder = laddersByName[c.name]
      let bestRung = at[c.name]
      let bestScore = current.score
      let bestEval = current
      for (let rung = 0; rung < ladder.length; rung += 1) {
        if (rung === at[c.name]) continue
        const result = evaluate({ ...at, [c.name]: rung })
        // ⚠️ Strictly greater, and ties keep the incumbent rung. Without that a
        // plateau flips crimes back and forth forever and the answer depends on
        // when the round limit happened to bite.
        if (result.score > bestScore) { bestScore = result.score; bestRung = rung; bestEval = result }
      }
      if (bestRung !== at[c.name]) {
        at[c.name] = bestRung
        current = bestEval
        improved = true
      }
    }
    // ⚠️ Coordinate descent cannot see an improvement that needs SEVERAL crimes
    // to concede together — moving any one of them alone makes things worse, so
    // it converges with everyone at the ceiling and a mostly-unfilled schedule.
    // A shared roster makes that the normal case rather than a corner one.
    //
    // So after the coordinates settle, try stepping EVERY crime down in lockstep
    // and keep it if the whole mix improves. Cheap — a handful of cached
    // evaluations — and it is the move the failure mode actually needs.
    if (!improved) {
      let jumped = false
      for (let step = 1; step < Math.max(...solvable.map((c) => laddersByName[c.name].length)); step += 1) {
        const trial = Object.fromEntries(solvable.map((c) => [
          c.name, Math.min(at[c.name] + step, laddersByName[c.name].length - 1),
        ]))
        const result = evaluate(trial)
        if (result.score > current.score) {
          for (const c of solvable) at[c.name] = trial[c.name]
          current = result
          jumped = true
          break
        }
      }
      if (!jumped) break
    }
  }

  // ── 3. Report, including what each crime conceded ────────────────────────
  const chosen = {}
  const concessions = {}
  for (const c of solvable) {
    const pick = laddersByName[c.name][at[c.name]]
    const top = laddersByName[c.name][0]
    chosen[c.name] = pick
    // ⚠️ "Alpha dropped 4 points so Beta could run" is the insight. A table of
    // lower numbers with no reasoning attached will not be trusted or followed.
    concessions[c.name] = {
      stepsDown: at[c.name],
      pointsGivenUp: c.positionIds.reduce(
        (sum, p) => sum + ((num(top.vector[p]) ?? 0) - (num(pick.vector[p]) ?? 0)), 0
      ),
      crewsGained: pick.crews - top.crews,
      fromVector: top.vector,
    }
  }

  // ⚠️ The reported simulation runs the FULL horizon, not the search's short
  // one. Ranking on twelve days is fine; publishing a "crews short" figure from
  // twelve days when the caller asked for thirty is not.
  const finalSim = simulateSpawns({
    scenarios: scenariosFor(at), readings, days, spawnsPerDay, gap, rosterSize, scope,
  })

  return {
    chosen, perCrimeCeiling, concessions, skipped,
    score: finalSim.income.perFactionMemberPerDay ?? finalSim.income.total,
    simulation: finalSim,
    searchDays, probeCalls, rounds,
  }
}
