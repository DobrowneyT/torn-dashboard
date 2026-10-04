/**
 * Human durations from a number of seconds.
 *
 * ⚠️ **One formatter for the app.** This was `occupancyReport.formatDuration`,
 * which stopped at days because a coverage window never exceeds one. The Hall
 * of Fame needed years, and the alternative was a second formatter with a
 * second set of rounding bugs. `occupancyReport` re-exports this one, so its
 * callers are unchanged.
 */

const MINUTE = 60
const HOUR = 3600
const DAY = 86400

/**
 * ⚠️ A year here is a flat 365 days, which ignores leap days — about 6 hours a
 * year of drift. That is fine for "839 days of travel reads better as 2y 109d"
 * and would not be fine for a date calculation, so this lives in a display
 * helper and nothing derives from it. Anywhere the exact figure matters, show
 * the raw seconds alongside.
 */
const YEAR = 365 * DAY

/**
 * The two most significant units, with the smaller one dropped when it is zero.
 *
 * ⚠️ **Rounding the smaller unit can carry.** 23h 36m of a day rounds to 24h,
 * and `${d}d ${h}h` then renders "114d 24h" — which is not wrong so much as
 * obviously unconsidered. Both the original minute and hour branches had this;
 * the carry is handled here once instead of three times.
 */
function twoUnits(s, bigSize, smallSize, bigSuffix, smallSuffix) {
  let big = Math.floor(s / bigSize)
  let small = Math.round((s % bigSize) / smallSize)
  if (small * smallSize >= bigSize) {
    big += 1
    small = 0
  }
  return small === 0 ? `${big}${bigSuffix}` : `${big}${bigSuffix} ${small}${smallSuffix}`
}

/**
 * "45s", "10m", "4h 12m", "114d", "2y 109d".
 *
 * The unit is chosen per value, so each row reads at its own scale rather than
 * every row being flattened to the largest one in the column.
 */
export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds ?? 0))
  if (s < MINUTE) return `${s}s`
  if (s < HOUR) {
    const m = Math.round(s / MINUTE)
    // ⚠️ 3599s rounds to 60m, which is an hour, not "60m".
    return m < 60 ? `${m}m` : '1h'
  }
  if (s < DAY) return twoUnits(s, HOUR, MINUTE, 'h', 'm')
  if (s < YEAR) return twoUnits(s, DAY, HOUR, 'd', 'h')
  return twoUnits(s, YEAR, DAY, 'y', 'd')
}

export { MINUTE, HOUR, DAY, YEAR }
