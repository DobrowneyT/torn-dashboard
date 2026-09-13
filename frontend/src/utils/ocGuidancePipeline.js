/**
 * Chaining the six slices of #688 into one answer for one crime (#707).
 *
 * The slices were built as independent pure functions and had **zero call
 * sites** — the algorithm was complete and the feature had not started. This is
 * the join: roster readings and the crime's own model in, a publishable table
 * out.
 *
 * ⚠️ **Every probe call is a request to tornprobability**, a small third-party
 * server this codebase already counts calls against. The candidate set is one
 * vector per achievable crew count (#692) precisely so this stays in single
 * digits; anything that turns it into a sweep has broken the design.
 *
 * ⚠️ **Injectable by construction.** `call` is a parameter, so the same
 * pipeline runs against any tenant's data — which is how the end-to-end check
 * gets done on a faction that HAS readings for the roles in question.
 */

import { expectedValue } from './ocExpectedValue'
import {
  payoutsFromEndings, withoutEndingPadding, collapseAliasedEndings,
} from './ocScenarioPayouts'
import { maximalCprVector } from './ocMaximalCpr'
import { searchThresholds } from './ocThresholdSearch'
import { publishGuidance } from './ocGuidanceTable'

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

/**
 * A probe over the Simulator's existing `/api/oc-simulator/calculate`.
 *
 * ⚠️ The API takes `parameters` as a POSITIONAL array indexed P1..PN; the
 * algorithm works in keyed vectors. Converting on the wrong key order produces
 * a perfectly plausible number for a crew nobody is running — the #390 hazard
 * in a new place, which is why there is a test pinning the exact array.
 *
 * Pricing reuses the Simulator's own chain (padding removed, aliases collapsed,
 * payouts from the model) rather than re-deriving it, so the table can never
 * disagree with the number displayed above it.
 */
export function makeProbe({ scenario, call }) {
  const payouts = payoutsFromEndings(scenario?.endings)
  const order = (scenario?.roles ?? []).map((r) => r.position_id)

  return async (vector) => {
    const parameters = order.map((pos) => num(vector?.[pos]) ?? 0)
    let raw
    try {
      const res = await call(scenario.name, parameters)
      raw = res?.result ?? res
    } catch {
      // ⚠️ A 502 is not a success chance of zero. Degrade to absent — a
      // manufactured number here would propagate into published guidance.
      return { expectedValue: null, successChance: null }
    }
    if (!raw) return { expectedValue: null, successChance: null }

    const trimmed = withoutEndingPadding(raw, scenario.endings)
    const { probabilities } = collapseAliasedEndings(trimmed, scenario.endings)
    const ev = expectedValue(scenario.name, probabilities, payouts)
    return {
      // ⚠️ An INCOMPLETE sum is absent, not a total. `expectedValue()` reports
      // coverage separately for exactly this reason, and a partial figure would
      // understate every crime whose best ending happens to be unpriced. The
      // Simulator can show a lower bound with a warning beside it; published
      // guidance cannot — nobody reads a footnote before training for a month.
      expectedValue: ev?.complete ? num(ev.expected) : null,
      successChance: num(raw.successChance),
    }
  }
}

export async function computeGuidance({
  scenario, rosterCpr, category, call,
  gap = null, gapIsAssumed = false, expectedBlend, nearMissWithin = 3,
  incumbent = null, maxCandidates, now = () => new Date().toISOString(),
} = {}) {
  const positionIds = (scenario?.roles ?? []).map((r) => r.position_id)
  const weights = Object.fromEntries((scenario?.roles ?? []).map((r) => [r.position_id, num(r.weight)]))
  const roleNames = Object.fromEntries((scenario?.roles ?? []).map((r) => [r.position_id, r.role_name]))
  const readings = rosterCpr?.readings ?? {}
  const rosterSize = num(rosterCpr?.roster_size)

  const fail = (reason, extra = {}) => ({
    guidance: publishGuidance({ scenarioName: scenario?.name, positionIds, chosen: null }),
    reason, probeCalls: 0, ceiling: null, chosen: null, ...extra,
  })

  if (positionIds.length === 0) return fail('no-roles')

  // Slice 3 — the ceiling, and the first place a crime declares itself
  // uncrewable. ⚠️ "Never observed anyone in this role" is a gap in our
  // measurement, NOT a verdict on the roster (#351), and the two must reach the
  // UI as different things.
  const ceiling = maximalCprVector(readings, positionIds)
  if (!ceiling.crewable) {
    const everObserved = (pos) => (readings?.[pos] ?? []).some((r) => num(r?.cpr) !== null)
    const unread = ceiling.limitingRoles.filter((p) => !everObserved(p))
    return fail(unread.length > 0 ? 'no-readings' : 'not-crewable', {
      ceiling, limitingRoles: unread.length > 0 ? unread : ceiling.limitingRoles,
    })
  }

  let probeCalls = 0
  const counted = makeProbe({ scenario, call })
  const probe = async (vector) => { probeCalls += 1; return counted(vector) }

  // Slice 4 — descend from the ceiling.
  const search = await searchThresholds({
    readings, positionIds, rosterSize, category, probe, weights, gap, incumbent, maxCandidates,
  })
  if (!search.chosen) return fail(search.reason ?? 'no-expected-value', { ceiling, probeCalls, search })

  // ⚠️ One extra call, deliberately: the published bar is a FLOOR and members
  // bring whoever is free, so a table showing only the floor's value understates
  // the crime. Pricing the expected crew is what makes the gap visible instead
  // of silent.
  const draft = publishGuidance({
    scenarioName: scenario.name, positionIds, roleNames, weights,
    chosen: search.chosen.vector, ceiling: ceiling.vector, readings,
    expectedBlend, nearMissWithin, gap, gapIsAssumed, rosterSize,
  })
  const expectedVector = Object.fromEntries(draft.roles.map((r) => [r.positionId, r.expected]))
  const expectedValueAtCrew = await probe(expectedVector)

  const guidance = publishGuidance({
    scenarioName: scenario.name, positionIds, roleNames, weights,
    chosen: search.chosen.vector, ceiling: ceiling.vector, readings,
    expectedBlend, nearMissWithin, gap, gapIsAssumed, rosterSize,
    generatedAt: now(),
    values: {
      floor: { expectedValue: search.chosen.expectedValue },
      expected: { expectedValue: expectedValueAtCrew.expectedValue },
    },
  })

  return { guidance, ceiling, chosen: search.chosen, search, probeCalls, reason: null }
}
