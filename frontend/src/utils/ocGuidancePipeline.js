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
import { computeChainEconomics } from './ocChainPipeline'
import { chainedValue, buildChainIndex } from './ocChains'

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
  // Needed only for a chain root — see below.
  scenarios = [], chains = [], categoryOf = null, chainCpr = null,
  // #725: `(crimeName) => Promise<{ readings }>` for the DOWNSTREAM links, so
  // each is priced at its own roster rather than at the slider default.
  fetchReadings = null,
} = {}) {
  const positionIds = (scenario?.roles ?? []).map((r) => r.position_id)
  const weights = Object.fromEntries((scenario?.roles ?? []).map((r) => [r.position_id, num(r.weight)]))
  const roleNames = Object.fromEntries((scenario?.roles ?? []).map((r) => [r.position_id, r.role_name]))
  const readings = rosterCpr?.readings ?? {}
  const rosterSize = num(rosterCpr?.roster_size)

  const fail = (reason, extra = {}) => ({
    guidance: publishGuidance({ scenarioName: scenario?.name, positionIds, chosen: null }),
    // ⚠️ `chainSource` defaults to null on EVERY refusal, so a caller reading
    // it never sees `undefined` and cannot mistake "not a chain" for "we did
    // not look" (#738).
    reason, probeCalls: 0, ceiling: null, chosen: null, chainContext: null,
    chainSource: null, ...extra,
  })

  if (positionIds.length === 0) return fail('no-roles')

  // ⚠️ A chain crime pays no money or items at all — every good ending spawns
  // the NEXT crime (Stacking the Deck → Ace in the Hole). Reporting that as
  // "unpriced" reads as a data gap and sends somebody hunting a number that
  // does not exist; it is a different KIND of reward. Detected before the
  // search so we do not spend probability calls learning nothing.
  const goodEndings = (scenario?.endings ?? []).filter((e) => e?.kind === 'good' && !e?.alias_of)
  // The API ships the model's published reward whole, so `chainsTo` arrives
  // nested under it rather than as a top-level field.
  const modelChainsTo = goodEndings.map((e) => e?.reward?.chainsTo).find(Boolean) ?? null
  const paysSomething = goodEndings.some(
    (e) => num(e?.money_avg) !== null || num(e?.item_value_avg) !== null
  )

  // ⚠️ **The per-ending model mapping is not the only source of a chain (#738).**
  //
  // Lock Stock carries no `reward.chainsTo` and its good endings are unpriced,
  // so this refused with "payouts are not fully priced" and published nothing —
  // for a crime that is tnl's most-spawned at 21% of decisions. Meanwhile
  // `ocChains.js` has known the edge all along, in KNOWN_CHAINS, and tnl's own
  // history confirms it: **34 of 34** Hostile Takeover runs came from a Lock
  // Stock parent, and Lock Stock paid **$0 across 44 runs**. The terminal
  // link's model is complete and carries $572M-$828M per good ending, so the
  // value was sitting right there the whole time.
  //
  // The gate was the only thing missing. `crimeshub-facts.json` covers 26
  // crimes and predates Torn's newest, so reading the chain only from there
  // leaves a crime unguided for as long as a third party takes.
  //
  // ⚠️ **Only when the crime pays nothing itself.** A crime can both pay and
  // spawn something; valuing that at the chain would double-count its payout.
  const indexEdge = paysSomething || modelChainsTo
    ? null
    : buildChainIndex(chains)?.edge?.(scenario.name) ?? null

  const chainsTo = modelChainsTo ?? indexEdge?.child ?? null
  // ⚠️ Provenance survives to the caller, and it is the INDEX's own label
  // rather than one invented here: `observed` means our history showed it,
  // `known` means the fixed-mechanics table did. Those are different strengths
  // of claim and a reader is entitled to know which they are looking at.
  const chainSource = modelChainsTo ? 'model' : indexEdge?.source ?? null
  // ⚠️ A chain root used to be REFUSED here, and that was wrong. Ace in the
  // Hole cannot be spawned on its own (#585: 128 of 128 runs came from a
  // parent), so telling a leader to "set thresholds on Ace in the Hole" asks
  // them to publish bars for a crime nobody can choose. **Stacking the Deck is
  // the crime members actually join** — it is the one that needs guidance, and
  // its value is not zero. It is the chain's value, which #712 computes.
  let chainContext = null
  if (chainsTo && !paysSomething) {
    chainContext = await computeChainEconomics({
      rootName: scenario.name, scenarios, chains,
      // ⚠️ Downstream links are priced ONCE and reused across every candidate.
      // Pricing them per candidate would multiply the call budget by the chain
      // length — the links have different role counts, so the root's crew
      // cannot carry across them anyway.
      //
      // ⚠️ **At the link's own roster, not the sliders (#725).** `chainCpr` is
      // the mean of the Simulator's sliders, which sit at 50 until somebody
      // drags them; tnl's readings say Ace in the Hole sustains 70-75. It stays
      // only as the fallback for a link this faction has never run.
      assumedCpr: chainCpr ?? 75,
      vectorFor: fetchReadings
        ? async (name) => {
            try {
              return (await fetchReadings(name))?.readings ?? null
            } catch {
              // Our own server, but a chain root must still produce a table if
              // it is briefly unreachable — the flat fallback covers it.
              return null
            }
          }
        : undefined,
      categoryOf, call,
    })
    if (!chainContext || chainContext.missing.length > 0) {
      return fail('chains', { chainsTo, chainContext, chainSource })
    }
  }

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

  let probeCalls = chainContext?.probeCalls ?? 0
  const counted = makeProbe({ scenario, call })

  // ⚠️ For a chain root the crime's OWN E(X) is zero by design, so searching on
  // it would rank every vector identically. What varies with the crew is the
  // root's success chance — and that is what decides how often the chain is
  // reached at all. So the value scored is the whole chain's, recomputed with
  // this candidate's success and the downstream figures priced once above.
  const probe = chainContext
    ? async (vector) => {
        probeCalls += 1
        const { successChance } = await counted(vector)
        if (successChance === null) return { expectedValue: null, successChance: null }
        const v = chainedValue(
          chainContext.links,
          { ...chainContext.successByName, [scenario.name]: successChance },
          chainContext.valueByName
        )
        return {
          expectedValue: v && v.complete ? num(v.expected) : null,
          successChance,
        }
      }
    : async (vector) => { probeCalls += 1; return counted(vector) }

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
    crews: search.chosen.crews,
    expectedBlend, nearMissWithin, gap, gapIsAssumed, rosterSize,
  })
  const expectedVector = Object.fromEntries(draft.roles.map((r) => [r.positionId, r.expected]))
  const expectedValueAtCrew = await probe(expectedVector)

  const guidance = publishGuidance({
    scenarioName: scenario.name, positionIds, roleNames, weights,
    chosen: search.chosen.vector, ceiling: ceiling.vector, readings,
    crews: search.chosen.crews,
    expectedBlend, nearMissWithin, gap, gapIsAssumed, rosterSize,
    generatedAt: now(),
    values: {
      floor: { expectedValue: search.chosen.expectedValue },
      expected: { expectedValue: expectedValueAtCrew.expectedValue },
    },
  })

  return { guidance, ceiling, chosen: search.chosen, search, probeCalls, chainContext, chainSource, reason: null }
}
