/**
 * Fair Fight (#422).
 *
 * FF is a respect multiplier: the same hit is worth roughly three times more
 * against someone in your stat range than against someone far below it. The
 * War Room already shows battle stats, so the mismatch is visible — but it has
 * to be eyeballed, and this turns it into a number you can sort on.
 *
 * Formula confirmed by MonChoon (2026-08-12):
 *
 *   BS Score = √strength + √speed + √defense + √dexterity
 *   FF       = min(3, 1 + (8/3) × (defender_BS / attacker_BS))
 */

/** Hard ceiling. Torn caps FF at 3.00 no matter how far you punch up. */
export const FF_MAX = 3

/**
 * The ratio at which FF saturates: 1 + 8/3 × r = 3  ⟹  r = 0.75.
 *
 * Worth knowing before designing any colour scale — every matchup from "a bit
 * weaker than me" upward reads a flat 3.00, so the entire useful gradient sits
 * between 0 and 0.75. A scale spread linearly across 1.00–3.00 would spend
 * most of its range on values that barely occur.
 */
export const FF_CAP_RATIO = 0.75

/** Present and non-negative. `Number(null)` is 0, which would pass a naive check. */
const stat = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * A fighter's battle-stat score, or null when any component is missing.
 *
 * ⚠️ This is a sum of square ROOTS, so it is NOT a function of the stat total.
 * Two members with identical totals split differently score differently, and
 * that is the whole reason the four values are needed. Deriving it from a
 * total by assuming an even split would invent a number that looks right and
 * is not — so a missing component returns null rather than a best guess.
 */
export function battleStatsScore(stats) {
  const s = stat(stats?.strength ?? stats?.str)
  const sp = stat(stats?.speed ?? stats?.spd)
  const d = stat(stats?.defense ?? stats?.def)
  const dx = stat(stats?.dexterity ?? stats?.dex)
  if (s === null || sp === null || d === null || dx === null) return null
  return Math.sqrt(s) + Math.sqrt(sp) + Math.sqrt(d) + Math.sqrt(dx)
}

/**
 * FF for `attacker` hitting `defender`, or null when either side is unknown.
 *
 * Null is deliberate and load-bearing: FF drives target selection, and a
 * fabricated value sends someone at a target that pays nothing. Callers render
 * a dash and, per #351, sort nulls last in BOTH directions.
 */
export function fairFight(attackerStats, defenderStats) {
  const attacker = battleStatsScore(attackerStats)
  const defender = battleStatsScore(defenderStats)
  if (attacker === null || defender === null || attacker <= 0) return null
  return Math.min(FF_MAX, 1 + (8 / 3) * (defender / attacker))
}

/** Two decimals, matching how Torn reports it; '—' when unknown. */
export function formatFF(ff) {
  return ff === null || ff === undefined ? '—' : ff.toFixed(2)
}

/**
 * Sort key honouring the #351 rule: no reading sinks in both directions.
 *
 * Returning null lets the shared comparator apply that rule rather than each
 * column reinventing it — sorting an unknown as 0 or as 1.00 buries it in the
 * middle of the ranking, which is worse than either end.
 */
export function ffSortValue(attackerStats, defenderStats) {
  return fairFight(attackerStats, defenderStats)
}

/**
 * A coarse band for colouring, derived from the ratio rather than from FF.
 *
 * FF itself is flat at 3.00 above the cap ratio, so banding on FF would make
 * "an even fight" and "punching up hard" indistinguishable. The ratio keeps
 * separating them, which is the thing a lead is choosing between.
 */
export function ffBand(attackerStats, defenderStats) {
  const attacker = battleStatsScore(attackerStats)
  const defender = battleStatsScore(defenderStats)
  if (attacker === null || defender === null || attacker <= 0) return 'unknown'
  const ratio = defender / attacker
  if (ratio >= FF_CAP_RATIO) return 'max'      // FF is 3.00 — full respect
  if (ratio >= 0.45) return 'good'
  if (ratio >= 0.2) return 'poor'
  return 'wasted'                              // punching far down; a few respect
}
