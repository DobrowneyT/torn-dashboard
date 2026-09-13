/**
 * Running the joint solve (#710) against the crimes on screen (#714 wiring).
 *
 * ⚠️ **Scoped to the SELECTED crimes, deliberately.** Solving all 31 scenarios
 * would mean 31 roster-CPR fetches and ~250 requests to tornprobability — a
 * small third-party server this codebase already counts calls against. The
 * Simulator already has a selection the operator controls, so the cost is
 * theirs to choose and is visible before they pay it.
 *
 * ⚠️ **A crime with no readings is skipped with its reason intact.** tnl has
 * readings for exactly the ten crimes it has run recently; the other twenty-one
 * in its history last ran in 2025 and have none. That is a measurement gap, not
 * a verdict, and it must not read as "this crime is impossible" (#351).
 */

import { solveJointThresholds } from './ocJointSolve'

/**
 * @param crimes     the selected scenarios, as the API serves them
 * @param fetchReadings `(crimeName) => Promise<{ readings, roster_size }>`
 * @param categoryOf `(crimeName) => category record`
 * @param call       the probability probe
 */
export async function solveForSelection({
  crimes = [], fetchReadings, categoryOf, call,
  days, spawnsPerDay, gap, scope, maxCandidates, searchDays,
} = {}) {
  if (crimes.length === 0) return { chosen: {}, skipped: {}, score: null, reason: 'nothing-selected' }

  // Our own server, so these are cheap and parallel — unlike the probability
  // calls further down, which are not.
  const rosters = await Promise.all(crimes.map(async (c) => {
    try {
      return { name: c.name, roster: await fetchReadings(c.name) }
    } catch {
      return { name: c.name, roster: null }
    }
  }))

  const readings = {}
  const unreachable = {}
  let rosterSize = null
  for (const { name, roster } of rosters) {
    if (!roster) { unreachable[name] = 'roster-unavailable'; continue }
    readings[name] = roster.readings ?? {}
    // ⚠️ One faction, one roster. Any crime's count is the same number; taking
    // the max guards against a crime whose endpoint answered oddly rather than
    // silently solving against a smaller faction than we have.
    const n = Number(roster.roster_size)
    if (Number.isFinite(n)) rosterSize = Math.max(rosterSize ?? 0, n)
  }

  const solvable = crimes.filter((c) => readings[c.name])
  const out = await solveJointThresholds({
    crimes: solvable.map((c) => ({
      name: c.name,
      positionIds: (c.roles ?? []).map((r) => r.position_id),
      roles: c.roles ?? [],
      endings: c.endings ?? [],
      category: categoryOf ? categoryOf(c.name) : null,
      // ⚠️ Uniform until #715 derives this from observed history. tnl's real mix
      // is far from even (Lock Stock 21%, Cleared for Takeoff 1.7%), so this is
      // a placeholder and the panel says so.
      spawnWeight: 1,
    })),
    readings, rosterSize, call, days, spawnsPerDay, gap, scope, maxCandidates, searchDays,
  })

  return { ...out, skipped: { ...out.skipped, ...unreachable }, rosterSize }
}
