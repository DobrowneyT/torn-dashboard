/**
 * Chain economics for one crime, priced at a stated crew (#712).
 *
 * `ocChains.js` (#585) has known all of this since it was written and the OC
 * Simulator has never imported it — so a chain link showed as a crime paying
 * nothing, with no hint that its value lives two crimes downstream or that its
 * scope maths is completely different from a standalone crime's.
 *
 * ⚠️ **The scope result is the one that surprises.** Scope is paid once at the
 * root and repaid only at the terminal link, only if every link succeeded — so
 * the reward stays flat while the probability of collecting it COMPOUNDS.
 * Elaborate breaks even at 83.3% standalone, **91.3% per link over two** and
 * **94.1% over three**. A reader comparing a chain against the standalone line
 * is comparing the wrong number.
 *
 * ⚠️ **The crew assumption has to be stated wherever this is shown.** Links have
 * different role counts, so there is no way to carry the current sliders
 * downstream. Every downstream link is priced at a FLAT CPR — by default the
 * mean of the crew on screen — which says "a crew of about this quality runs the
 * next one too". That is an assumption about our own behaviour, in the same
 * family as `g`, and it is a parameter for that reason.
 */

import { buildChainIndex, chainFrom, chainConfident, chainedSuccess, chainedValue, chainedScope } from './ocChains'
import { maximalCprVector } from './ocMaximalCpr'
import { makeProbe } from './ocGuidancePipeline'
import { chainTargetOf } from './ocScenarioPayouts'

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

/** Mean of the crew currently on screen — the default quality for downstream links. */
export function meanCpr(cprs) {
  const values = (cprs ?? []).map(num).filter((v) => v !== null)
  if (values.length === 0) return null
  return values.reduce((a, b) => a + b, 0) / values.length
}

/**
 * @param rootName      the crime whose card this is
 * @param scenarios     every scenario, so downstream links can be priced
 * @param chains        observed `{parent, child, observations}` edges from the API
 * @param assumedCpr    flat CPR for every link
 * @param categoryOf    `(crimeName) => categoryKey`
 * @param call          `(name, parameters) => CalculateSuccess response`
 * @param known         success/value we already have, so the root is not re-probed
 * @param vectorFor     optional `(name, scenario) => readings | null` (#725).
 *                      When it yields readings that can crew the link, that
 *                      link is priced at ITS OWN maximal CPR vector instead of
 *                      the flat `assumedCpr`.
 */
export async function computeChainEconomics({
  rootName, scenarios = [], chains = [], assumedCpr, categoryOf, call, known = {}, vectorFor,
} = {}) {
  const links = chainFrom(rootName, buildChainIndex(chains))
  // ⚠️ A single link is not a chain. Rendering one would tell a reader that an
  // ordinary crime has chain economics, which is the opposite of the point.
  if (links.length < 2) return null

  const byName = new Map(scenarios.map((s) => [s.name, s]))
  const successByName = {}
  const valueByName = {}
  const categoryByName = {}
  const crewByName = {}
  const missing = []
  let probeCalls = 0

  for (const l of links) {
    categoryByName[l.name] = categoryOf ? categoryOf(l.name) : null

    if (known[l.name]) {
      successByName[l.name] = known[l.name].successChance
      valueByName[l.name] = known[l.name].expectedValue
      continue
    }
    const scenario = byName.get(l.name)
    if (!scenario) { missing.push(l.name); continue }

    const probe = makeProbe({ scenario, call })
    const positions = (scenario.roles ?? []).map((r) => r.position_id)

    // ⚠️ **Prefer the link's OWN roster (#725).** `assumedCpr` used to be the
    // mean of the Simulator's sliders, which sit at 50 until somebody drags
    // them — while tnl has 81-87 readings per role for Ace in the Hole showing
    // a roster that sustains 70-75. Pricing the terminal link 22 CPR below what
    // the faction can field made every chain look far worse than it is, and the
    // scope verdict is REPORTED rather than enforced, so it has to be right and
    // not merely alarming.
    //
    // ⚠️ Falls back to flat, and records WHICH, because a tenant that has never
    // run the terminal link must not inherit a roster number it does not have.
    let vector = null
    if (vectorFor) {
      const readings = await vectorFor(l.name, scenario)
      const maximal = readings ? maximalCprVector(readings, positions) : null
      if (maximal?.crewable) vector = maximal.vector
    }
    crewByName[l.name] = vector
      ? { source: 'roster', vector }
      : { source: 'assumed', vector: Object.fromEntries(positions.map((p) => [p, assumedCpr])) }

    probeCalls += 1
    const out = await probe(crewByName[l.name].vector)
    successByName[l.name] = out.successChance

    // ⚠️ "Pays nothing" and "we have not priced it" are DIFFERENT, and
    // `chainedValue` distinguishes them with `== null` precisely so a chain
    // reads as a lower bound only when something is genuinely unmeasured.
    //
    // A chain PARENT pays nothing *by design* — every good ending spawns the
    // next crime instead. That is a known zero, not a gap, and reporting it as
    // null would mark every chain incomplete and hide a real terminal-link gap
    // behind the noise.
    const good = (scenario.endings ?? []).filter((e) => e?.kind === 'good' && !e?.alias_of)
    // ⚠️ Two ways to know a link pays only by chaining (#738). The model may
    // say so per ending (`chainsTo`), OR the link may have an OBSERVED child
    // while carrying no money on any good ending — which is Lock Stock: no
    // model mapping, unpriced endings, and $0 across 44 real runs.
    //
    // Getting this wrong matters in a specific way: `chainedValue` uses
    // `== null` to mean "unmeasured", so a known zero recorded as null marks
    // the whole chain incomplete and hides a genuine gap in the terminal link
    // behind the noise.
    const unpricedGood = good.length > 0 && good.every(
      (e) => num(e?.money_avg) === null && num(e?.item_value_avg) === null
    )
    const paysOnlyByChaining =
      (good.length > 0 && good.every((e) => chainTargetOf(e) !== null)) ||
      (l.child != null && unpricedGood)
    valueByName[l.name] =
      out.expectedValue !== null ? out.expectedValue : paysOnlyByChaining ? 0 : null
  }

  return {
    links,
    confident: chainConfident(links),
    chainedSuccess: chainedSuccess(links, successByName),
    value: chainedValue(links, successByName, valueByName),
    scope: chainedScope(links, successByName, categoryByName),
    successByName,
    valueByName,
    crewByName,
    assumedCpr,
    missing,
    probeCalls,
  }
}
