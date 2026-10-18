// #996 — learn a target's real battle-stat score from our own hits.
//
// Every hit carries Torn's ACTUAL fair fight, and the hitter's exact stats come
// from their own key, so the War Room's formula runs backwards:
//
//   FF = min(3, 1 + 8/3 × defender / attacker)
//   ⟹ defender = (FF − 1) × 3/8 × attacker            (when FF < 3)
//
// ⚠️ **A hit at the 3.00 cap is a lower bound, not a value.** It only proves
// the defender is at least 0.75 × the hitter. That is still worth having: it
// corrects an estimate that says the target is weaker than it is.
//
// ⚠️ **A score, not four stats.** The score is a sum of square roots, so it
// cannot be split back into STR/SPD/DEF/DEX. The War Room scales the spy's
// breakdown to match it, or assumes an even split when there is none.
//
// Pure: nothing here touches the database. The job decides what to store.

/** Torn's ceiling. */
export const FF_CAP = 3

/**
 * Torn reports FF to two decimals, so a capped hit reads 3.00 and anything at
 * or above 2.995 cannot be told apart from it.
 */
export const FF_CAP_READ = 2.995

/** Defaults; each is overridable per faction in `faction_settings`. */
export const DEADBAND_DEFAULT = 0.1
export const MAX_AGE_DAYS_DEFAULT = 30
export const DEADBAND_SETTING = 'stat_measure_deadband'
export const MAX_AGE_SETTING = 'stat_measure_max_age_days'

export interface FourStats {
  str?: number | string | null
  spd?: number | string | null
  def?: number | string | null
  dex?: number | string | null
  total?: number | string | null
}

const stat = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * A fighter's BS score — the same rule as the SPA's `battleStatsScore`: four
 * stats when we have them, else an even split of the total.
 */
export function battleStatsScore(s: FourStats | null | undefined): number | null {
  if (!s) return null
  const parts = [stat(s.str), stat(s.spd), stat(s.def), stat(s.dex)]
  if (parts.every((p) => p !== null)) {
    return (parts as number[]).reduce((sum, p) => sum + Math.sqrt(p), 0)
  }
  const total = stat(s.total)
  return total === null ? null : 2 * Math.sqrt(total)
}

/** The FF a hitter of `attackerScore` would get on a defender of `defenderScore`. */
export function predictedFF(defenderScore: number, attackerScore: number): number {
  return Math.min(FF_CAP, 1 + (8 / 3) * (defenderScore / attackerScore))
}

export interface Measurement {
  score: number
  bound: 'exact' | 'at_least'
}

/** What one hit says about the defender, or null when it says nothing. */
export function measureFromHit(ff: number, attackerScore: number): Measurement | null {
  if (!Number.isFinite(ff) || !Number.isFinite(attackerScore) || attackerScore <= 0) return null
  // ⚠️ FF is never below 1 and exactly 1 is the column's DEFAULT, not a reading.
  if (ff <= 1) return null
  if (ff >= FF_CAP_READ) return { score: 0.75 * attackerScore, bound: 'at_least' }
  return { score: (ff - 1) * (3 / 8) * attackerScore, bound: 'exact' }
}

export type Decision =
  | { action: 'store'; measurement: Measurement }
  | { action: 'confirm' }
  | { action: 'skip' }

/**
 * Does this hit change what we believe about the defender?
 *
 * `current` is the defender score the War Room would use right now — a live
 * measurement, else the spy estimate — or null when there is nothing.
 *
 * ⚠️ **The deadband is in FF, against THIS hitter.** The question a member asks
 * is "will my FF be what the board says", so the comparison is the FF this
 * hitter got against the FF the current belief predicted for them. Within the
 * deadband the belief stands and is only confirmed — MonChoon: "If the FF
 * scored is within some tolerance then we should also just leave the stats".
 */
export function decide(args: {
  ff: number
  attackerScore: number
  current: number | null
  deadband: number
}): Decision {
  const m = measureFromHit(args.ff, args.attackerScore)
  if (!m) return { action: 'skip' }
  if (args.current === null || !(args.current > 0)) return { action: 'store', measurement: m }

  const predicted = predictedFF(args.current, args.attackerScore)
  if (m.bound === 'at_least') {
    // A capped hit agrees with any belief that also predicts the cap; it only
    // corrects one that predicted noticeably less.
    return predicted >= FF_CAP - args.deadband
      ? { action: 'confirm' }
      : { action: 'store', measurement: m }
  }
  return Math.abs(args.ff - predicted) <= args.deadband
    ? { action: 'confirm' }
    : { action: 'store', measurement: m }
}

/** A usable deadband: a non-negative number below 2, else the default. */
export function deadbandFrom(value: unknown): number {
  const n = Number(value)
  return value !== null && value !== undefined && Number.isFinite(n) && n >= 0 && n < 2
    ? n : DEADBAND_DEFAULT
}

/** A usable expiry in days: a positive number, else the default. */
export function maxAgeDaysFrom(value: unknown): number {
  const n = Number(value)
  return value !== null && value !== undefined && Number.isFinite(n) && n > 0
    ? n : MAX_AGE_DAYS_DEFAULT
}

/**
 * When a live measurement beats the spy it would replace.
 *
 * ⚠️ A TornStats spy carries a capture time, so the newer of the two wins. BSP
 * has no capture time — it is a model's estimate, not a reading — so a live
 * measurement always beats it. Shared with the grudge list's read so the two
 * surfaces cannot disagree about one target.
 */
export const MEASUREMENT_BEATS_SPY_SQL = (m: string, spySource: string, tsSpyAt: string) =>
  `(${spySource} IS DISTINCT FROM 'tornstats' OR ${tsSpyAt} IS NULL
     OR greatest(${m}.measured_at, coalesce(${m}.confirmed_at, ${m}.measured_at)) >= ${tsSpyAt})`
