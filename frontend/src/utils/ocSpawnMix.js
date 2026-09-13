/**
 * What a faction ACTUALLY spawns, from its own history (#715).
 *
 * The spawn simulation used a caller-supplied `spawnsPerDay` (defaulting to 1)
 * and uniform `spawnWeight`. tnl's real figures on 2026-09-13 were **3.97
 * spawns a day** across a distinctly uneven mix, so both were guesses standing
 * where a measurement could go — the same shape as `g` in #687.
 *
 * ⚠️ **Chain children are not spawn decisions, and this is the whole point of
 * the module.** A crime with `previous_crime_id` set did not get chosen; it
 * appeared because its parent succeeded. On tnl that was **23.5% of all
 * "spawns"** — Hostile Takeover 17.6%, Ace in the Hole 5.9% — and every one of
 * their lifetime runs came from a parent.
 *
 * Leaving them in does two separate kinds of damage:
 *
 *   * the mix contains crimes nobody can choose to run, so the planner
 *     apportions roster capacity to a decision that does not exist;
 *   * they get charged `scopeCost`, when scope is paid **once at the root** and
 *     a child costs nothing to appear (`ocChains.js`).
 */

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

/** Below this many observed spawns the mix is too thin to plan on. */
export const MIN_SPAWNS_FOR_MIX = 20

/**
 * @param spawns `{ window_days, by_crime: [{ name, spawns, from_chain }] }`
 * @returns `{ spawnsPerDay, weightByName, chainChildren, chosenSpawns, measured }`
 *   with `measured: false` when there is too little history to plan on — in
 *   which case the caller keeps its defaults rather than planning on noise.
 */
export function observedSpawnMix(spawns) {
  const days = num(spawns?.window_days)
  const rows = Array.isArray(spawns?.by_crime) ? spawns.by_crime : []
  if (days === null || days <= 0 || rows.length === 0) {
    return { measured: false, spawnsPerDay: null, weightByName: {}, chainChildren: [], chosenSpawns: 0 }
  }

  const chainChildren = []
  const chosen = []
  let chosenSpawns = 0

  for (const r of rows) {
    const total = num(r?.spawns) ?? 0
    const fromChain = num(r?.from_chain) ?? 0
    // ⚠️ A crime EVERY appearance of which came from a parent is a chain child,
    // not a choice. Judged per crime rather than per row so a crime that is
    // usually chosen but occasionally chained still counts as choosable — and
    // the `>= total` test means a crime with zero spawns cannot slip through as
    // "always chained".
    if (total > 0 && fromChain >= total) { chainChildren.push(r.name); continue }
    // Its chained appearances are still not decisions, so they come off the
    // count even for a crime that is mostly chosen.
    const chosenHere = Math.max(0, total - fromChain)
    if (chosenHere === 0) continue
    chosen.push({ name: r.name, spawns: chosenHere })
    chosenSpawns += chosenHere
  }

  if (chosenSpawns < MIN_SPAWNS_FOR_MIX) {
    return { measured: false, spawnsPerDay: null, weightByName: {}, chainChildren, chosenSpawns }
  }

  const weightByName = {}
  for (const c of chosen) weightByName[c.name] = c.spawns / chosenSpawns

  return {
    measured: true,
    // ⚠️ Decisions per day, not appearances per day. A faction that spawns four
    // crimes a day of which one is a chain child is making three decisions.
    spawnsPerDay: chosenSpawns / days,
    weightByName,
    chainChildren,
    chosenSpawns,
    windowDays: days,
  }
}
