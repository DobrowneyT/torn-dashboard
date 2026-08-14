/**
 * What each role is actually worth (#441).
 *
 * MonChoon: *"Some of the roles are not huge factors in the crimes, so they have
 * very little affect on the success chance. Sometimes they affect the payouts
 * more than success, so its important to see these distinction."*
 *
 * Both halves are measurable, and they are deliberately kept as TWO numbers:
 *
 *   Δ success — how much the overall success chance moves per CPR point
 *   Δ value   — how much expected value moves per CPR point
 *
 * ⚠️ Collapsing them into one "impact" score is the mistake this module exists
 * to avoid. It would average together the two cases that matter most:
 *
 *   GATE   — high Δ success, low Δ value. Failing it ends the crime; passing it
 *            does not change which good ending you reach.
 *   ROUTER — low Δ success, high Δ value. Barely changes whether you succeed,
 *            but decides which ending you land in — worth ~$159M a step on
 *            Break the Bank.
 *
 * A single averaged number makes a router look unimportant, which is exactly
 * the role someone would then under-train.
 */
import { expectedValue } from './ocExpectedValue'
import { payoutsFromEndings } from './ocScenarioPayouts'

/** CPR points to step when measuring a derivative. */
export const PROBE_DELTA = 10

/**
 * How much probability may move onto UNPRICED endings before a value delta is
 * no longer trustworthy.
 *
 * Small but not zero: rounding in the upstream response moves the last decimal
 * around, and demanding exact equality would discard every measurement.
 */
export const UNPRICED_MASS_TOLERANCE = 0.01

/**
 * Below this share of the biggest mover, a role is "barely matters".
 *
 * Relative rather than absolute: crimes differ by orders of magnitude in both
 * money and success sensitivity, so a fixed threshold would classify every role
 * in a cheap crime as negligible.
 */
export const NEGLIGIBLE_FRACTION = 0.15

/** Good-ending probabilities from a CalculateSuccess response. */
export function goodEndings(result) {
  const out = {}
  for (const [k, v] of Object.entries(result ?? {})) {
    if (k.startsWith('goodEnding') && Number.isFinite(v)) out[k] = v
  }
  return out
}

/**
 * Δ success and Δ value per CPR point for one role.
 *
 * `base` and `bumped` are CalculateSuccess responses for the same crew with
 * only this role's CPR changed by `delta` points.
 *
 * ⚠️ Returns nulls rather than zeros when a figure cannot be computed. A role
 * whose value effect is unknown must not read as "this role does not affect
 * payouts" — that is a claim, and the wrong one to make by accident.
 */
export function roleSensitivity(scenario, base, bumped, delta = PROBE_DELTA) {
  if (!base || !bumped || !Number.isFinite(delta) || delta === 0) return null

  const dSuccess = Number.isFinite(base.successChance) && Number.isFinite(bumped.successChance)
    ? (bumped.successChance - base.successChance) / delta
    : null

  const payouts = payoutsFromEndings(scenario?.endings)
  const anyPriced = Object.values(payouts).some((v) => v != null)

  let dValue = null
  if (anyPriced) {
    const baseProbs = goodEndings(base)
    const bumpProbs = goodEndings(bumped)
    const evBase = expectedValue(scenario?.name, baseProbs, payouts)
    const evBump = expectedValue(scenario?.name, bumpProbs, payouts)

    // ⚠️ Only meaningful if the probability sitting on UNPRICED endings is
    // about the same on both sides. A role that shifts mass onto an ending we
    // cannot price would otherwise look like it DESTROYS value, when in truth
    // the value went somewhere we cannot see.
    //
    // Comparing the COUNT of missing endings is not enough, and an earlier
    // version did exactly that: the same endings stay unpriced while the mass
    // on them goes from 0 to 0.7, and the count never changes. It is the mass
    // that matters.
    const missingMass = (probs, missing) =>
      missing.reduce((sum, key) => sum + (Number(probs[key]) || 0), 0)
    const shift = Math.abs(
      missingMass(bumpProbs, evBump.missing) - missingMass(baseProbs, evBase.missing)
    )
    if (shift <= UNPRICED_MASS_TOLERANCE) dValue = (evBump.expected - evBase.expected) / delta
  }

  return { dSuccess, dValue, priced: anyPriced }
}

/**
 * Classify a role from its two sensitivities, relative to the crime's biggest.
 *
 * Returns one of: 'gate', 'router', 'both', 'minor', or 'unknown'.
 */
export function classifyRole(sensitivity, maxima) {
  if (!sensitivity) return 'unknown'
  const { dSuccess, dValue } = sensitivity
  if (dSuccess === null && dValue === null) return 'unknown'

  const successShare = maxima?.success > 0 ? Math.abs(dSuccess ?? 0) / maxima.success : 0
  const valueShare = maxima?.value > 0 ? Math.abs(dValue ?? 0) / maxima.value : 0

  const movesSuccess = successShare >= NEGLIGIBLE_FRACTION
  const movesValue = dValue !== null && valueShare >= NEGLIGIBLE_FRACTION

  if (movesSuccess && movesValue) return 'both'
  if (movesSuccess) return 'gate'
  if (movesValue) return 'router'
  // ⚠️ 'minor' only when we could actually measure. Unmeasured is 'unknown',
  // and the two must not both render as "safe to put your weakest member here".
  return dValue === null && !sensitivity.priced ? 'unknown' : 'minor'
}

export const ROLE_CLASS_LABELS = {
  gate: 'Gate — drives success',
  router: 'Router — drives payout',
  both: 'Drives success and payout',
  minor: 'Barely matters',
  unknown: 'Not measured',
}

/**
 * Build the per-role picture for a crime, with the maxima needed to classify.
 *
 * `byRole` maps position_id → { base, bumped }.
 */
export function crimeSensitivity(scenario, byRole, delta = PROBE_DELTA) {
  const roles = scenario?.roles ?? []
  const raw = roles.map((role) => ({
    role,
    sensitivity: roleSensitivity(scenario, byRole?.[role.position_id]?.base,
      byRole?.[role.position_id]?.bumped, delta),
  }))

  const maxima = {
    success: Math.max(0, ...raw.map((r) => Math.abs(r.sensitivity?.dSuccess ?? 0))),
    value: Math.max(0, ...raw.map((r) => Math.abs(r.sensitivity?.dValue ?? 0))),
  }

  return raw.map((r) => ({
    positionId: r.role.position_id,
    roleName: r.role.role_name,
    dSuccess: r.sensitivity?.dSuccess ?? null,
    dValue: r.sensitivity?.dValue ?? null,
    kind: classifyRole(r.sensitivity, maxima),
  }))
}
