/**
 * Estimating a member's CPR for a role their faction has never run (#602).
 *
 * The chicken-and-egg: deciding whether to unlock Elaborate needs an expected
 * value, which needs a success chance, which needs the crew's CPRs for Elaborate
 * roles — and a CPR exists only once you are already running the crime.
 *
 * It is breakable because CPR is **deterministic given the member**. Fitted on a
 * faction that runs both crimes, a target role's CPR is an affine function of a
 * source role's, with held-out error of **0.3–1.4 points** on well-sampled pairs.
 * CPR is integer-valued, so that is at the rounding floor.
 *
 * ⚠️ **A slope, not an offset.** Crime Experience acts as a multiplier on the
 * other factors (`docs/oc-cpr-mechanics.md`), so the relationship scales. Slopes
 * run 0.86–1.2 between nearby difficulties and **2.0** across a large gap.
 *
 * ⚠️ **What crosses the tenant boundary is the COEFFICIENT TABLE, not member
 * rows.** The fit is run once by an operator against a donor faction; what ships
 * is `slope`, `intercept`, `n`, `mae` and the range it was fitted on.
 *
 * ⚠️ **Everything here is an estimate and must stay visibly so.** Same rule as
 * `legacyTimeSpent` and `item_value_unmatched` — a number that looks like a
 * reading will be used like one.
 */

import table from '../data/cpr-transfer.json'

export const TABLE_VERSION = table?._generated ?? 'unknown'
export const COEFFICIENTS = table?.targets ?? {}

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const key = (crime, role) => `${crime}||${role}`

/**
 * @param coefficients  `{ "Crime||Role": {source, slope, intercept, source_range, ...} }`
 * @param readings      the faction's OWN readings, `{ "Crime||Role": [{member_id, cpr}] }`
 * @param crimeName     the crime to estimate
 * @param roles         optional explicit role list, so a role with no coefficient
 *                      is reported as unmapped rather than silently skipped
 */
export function estimateReadings({ coefficients = COEFFICIENTS, readings = {}, crimeName, roles = null } = {}) {
  const wanted = roles ?? Object.keys(coefficients)
    .filter((k) => k.startsWith(`${crimeName}||`))
    .map((k) => k.split('||')[1])

  const out = {}
  const unmapped = []

  for (const role of wanted) {
    const coef = coefficients[key(crimeName, role)]
    // ⚠️ No coefficient is "we could not look", not "nobody can fill this" (#351).
    if (!coef) { unmapped.push(role); continue }

    const src = readings[coef.source]
    if (!src || src.length === 0) { unmapped.push(role); continue }

    const [lo, hi] = coef.source_range ?? [null, null]
    const rows = []
    let outOfRange = 0

    for (const r of src) {
      const x = num(r?.cpr)
      // ⚠️ A member with no source reading is ABSENT. Scoring them zero would put
      // a phantom member at the bottom of the roster, and `maxDisjointCrews`
      // would count a seat nobody can actually fill.
      if (x === null) continue

      const y = coef.slope * x + coef.intercept
      const extrapolated = lo !== null && (x < lo || x > hi)

      // ⚠️ A steep slope outside its range produces nonsense: Driver's slope is
      // 2.0, so a member at CPR 20 maps to -75. That is the model failing, not a
      // weak member, and it must never reach the matcher.
      if (!Number.isFinite(y) || y <= 0 || y > 100) { outOfRange += 1; continue }

      rows.push({
        member_id: r.member_id,
        cpr: y,
        estimated: true,
        extrapolated,
      })
    }

    out[role] = {
      readings: rows.sort((a, b) => b.cpr - a.cpr),
      source: coef.source,
      donor: coef.donor,
      slope: coef.slope,
      mae: coef.mae,
      n: coef.n,
      sourceRange: coef.source_range ?? null,
      lowConfidence: Boolean(coef.low_confidence),
      extrapolatedCount: rows.filter((r) => r.extrapolated).length,
      outOfRange,
    }
  }

  return {
    crimeName,
    estimated: Object.keys(out).length > 0,
    roles: out,
    unmapped,
    tableVersion: TABLE_VERSION,
  }
}
