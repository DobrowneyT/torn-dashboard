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
 * A fighter's battle-stat score, or null when we have nothing to go on.
 *
 * This is a sum of square ROOTS, so it is not a function of the stat total:
 * two members with identical totals split differently score differently.
 *
 * When only a total is available — BSP estimates give one number, not four —
 * we assume an even split, per MonChoon (2026-08-13): "if we don't have a stat
 * breakdown and just have the total stats (like from BSP), then let's just
 * assume that the player has evenly distributed stats."
 *
 * ⚠️ That assumption is not free, and it flatters lopsided builds. An even
 * split maximises the sum of roots for a given total, so a pure-strength
 * fighter's score is OVERSTATED — by about 30% at the extreme (√400 × ... see
 * the tests). On the defender side that inflates FF, making a target look more
 * rewarding than it is. `scoreIsEstimated` marks it so the UI can say which
 * numbers are assumed rather than measured.
 */
export function battleStatsScore(stats) {
  const s = stat(stats?.strength ?? stats?.str)
  const sp = stat(stats?.speed ?? stats?.spd)
  const d = stat(stats?.defense ?? stats?.def)
  const dx = stat(stats?.dexterity ?? stats?.dex)
  if (s !== null && sp !== null && d !== null && dx !== null) {
    return Math.sqrt(s) + Math.sqrt(sp) + Math.sqrt(d) + Math.sqrt(dx)
  }
  // Even split: 4 × √(total/4) = 2√total.
  const total = stat(stats?.total ?? stats?.bsp ?? stats?.bspTotal)
  if (total !== null) return 2 * Math.sqrt(total)
  return null
}

/** True when the score came from a total with an assumed even split. */
export function scoreIsEstimated(stats) {
  const has = (v) => stat(v) !== null
  const full = has(stats?.strength ?? stats?.str) && has(stats?.speed ?? stats?.spd)
    && has(stats?.defense ?? stats?.def) && has(stats?.dexterity ?? stats?.dex)
  if (full) return false
  return stat(stats?.total ?? stats?.bsp ?? stats?.bspTotal) !== null
}

/**
 * A roster row's battle stats, in whichever of the two shapes it arrives in.
 *
 * The desktop table reads flat DB rows (`bsp_str`, `bsp_total`); the mobile
 * overlay is handed a camelCase projection of the same data (`bspStr`, `bsp`).
 * Both feed the same FF number, so the mapping lives here once rather than
 * being retyped at each call site — three copies of "which field is defense"
 * is exactly how a surface ends up quietly disagreeing with the others.
 */
export function targetBattleStats(row) {
  if (!row) return null
  return {
    strength:  row.bsp_str   ?? row.bspStr,
    speed:     row.bsp_spd   ?? row.bspSpd,
    defense:   row.bsp_def   ?? row.bspDef,
    dexterity: row.bsp_dex   ?? row.bspDex,
    total:     row.bsp_total ?? row.bsp,
  }
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

/**
 * The UNCAPPED fair fight — the same formula before Torn's 3.00 ceiling (#995).
 *
 * ⚠️ Display and ordering only. Respect is paid on the CAPPED value, so every
 * payout, score and the "3x FF" filter keep using `fairFight()`. What this adds
 * is how far past 3.00 a matchup is: "true FF 5.40" is a target you are likely
 * to lose to, where the capped value would read a reassuring 3.00.
 */
export function trueFairFight(attackerStats, defenderStats) {
  const attacker = battleStatsScore(attackerStats)
  const defender = battleStatsScore(defenderStats)
  if (attacker === null || defender === null || attacker <= 0) return null
  return 1 + (8 / 3) * (defender / attacker)
}

/**
 * Default for the upper red anchor of the true-FF gradient (#995). MonChoon
 * suggested 5 or 6 and will tune it against real stats, so the live value is a
 * feature flag (`war_room_ff_red_high`, Global Admin) — this is only the
 * fallback when the flag is unset.
 */
export const FF_TRUE_RED_HIGH_DEFAULT = 6

/**
 * Hue for a true FF, double-ended (#995): red (0°) at 1.00, green (120°) at
 * 3.00, and red again at `redHigh` and beyond — too far below you pays little,
 * too far above you is a fight you probably lose. Null when unknown.
 */
export function ffTrueHue(ff, redHigh = FF_TRUE_RED_HIGH_DEFAULT) {
  if (ff === null || ff === undefined || !Number.isFinite(ff)) return null
  const high = Number.isFinite(redHigh) && redHigh > FF_MAX ? redHigh : FF_TRUE_RED_HIGH_DEFAULT
  if (ff <= FF_MAX) return Math.round(120 * Math.max(0, (ff - 1) / (FF_MAX - 1)))
  return Math.round(120 * Math.max(0, 1 - (ff - FF_MAX) / (high - FF_MAX)))
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
  // #995: by TRUE FF, so "far above me" sorts above "even fight" rather than
  // both tying at 3.00.
  return trueFairFight(attackerStats, defenderStats)
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

/**
 * Gradient position for the FF cell: 0 at the low end (red) → 1 at 3.00 (green).
 *
 * ⚠️ Anchored at FF 1.00, not 0.75. Under the confirmed formula
 * `1 + 8/3 × ratio`, FF cannot go below 1.00 — the ratio would have to be
 * negative. MonChoon asked for "3.00 green and .75 red"; 0.75 is the RATIO at
 * which FF saturates at 3.00, so it is the green end rather than the red one.
 * Anchoring red at 1.00 is the only reading that spans the values FF actually
 * takes. Worth confirming: if 0.75 has been seen as a real FF in game, the
 * formula needs revisiting rather than the gradient.
 */
export function ffGradientPosition(ff) {
  if (ff === null || ff === undefined) return null
  return Math.min(1, Math.max(0, (ff - 1) / (FF_MAX - 1)))
}

/**
 * Whether this matchup pays full respect — the "3x FF" roster filter.
 *
 * Compared with a tolerance rather than `=== 3`: FF is floating point, and a
 * matchup sitting a whole hair under the cap is the same tactical call as one
 * exactly on it. An exact equality check would drop targets for a rounding
 * artefact the user cannot see.
 */
export function isMaxFF(ff) {
  return ff !== null && ff !== undefined && ff >= FF_MAX - 1e-9
}
