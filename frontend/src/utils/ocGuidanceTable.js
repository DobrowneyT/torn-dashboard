/**
 * The published CPR guidance table (#694, slice 6 of #688).
 *
 * The deliverable members actually read. Everything upstream is worthless if the
 * output is a spreadsheet nobody opens, so the failure modes here are about
 * MEANING rather than arithmetic: a number that invites pointless training, a
 * threshold that looks solid when it is on a knife edge, a table that presents
 * an assumption as a fact.
 *
 * ## ⚠️ Two numbers per role, because one of them would lie
 *
 * The published bar is a **floor**, not a prediction. Members bring whoever is
 * free to a seat, usually above the minimum — so a table showing only the floor
 * understates what the crime really returns, and understates it most on exactly
 * the carry roles published as zero.
 *
 * So every role shows both: the **floor** we publish, and the **expected** crew
 * we think will actually turn up. The source document asks for the same thing
 * about scope in step 5 — *"it assumes each crime is undertaken with the exact
 * minimum CPR levels... Maybe we could assume half way between the minimum CPR
 * and the 'maximal' CPRs from step 1?"* — and that halfway point is the default.
 *
 * ## ⚠️ Carry roles publish 0, deliberately
 *
 * MonChoon, 2026-09-12: *"I think carry roles should publish 0, even though the
 * simulator effectively uses the lowest real number."*
 *
 * "You do not need this role trained" is the true instruction, and **any**
 * number at all invites somebody to train toward it. The simulator still scored
 * the crime at a real bar, and that bar stays visible as `floor` — hiding it
 * would make the table unauditable.
 *
 * ⚠️ The two surfaces disagree **by design**. Anyone reconciling them later
 * should not "fix" it.
 *
 * ## Recompute, do not freeze
 *
 * Roster churn invalidates these, and step 1's ceiling sits on a cliff by
 * construction. This regenerates from live readings; a hand-maintained document
 * is exactly what drifts today.
 */

import { headcountAtCpr } from './ocRosterFit'

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

/**
 * Weight below which a role publishes `0`.
 *
 * 10 matches where the source document's importance bands bottom out — they run
 * down to "10-15%" and treat everything beneath as a carry.
 */
export const CARRY_WEIGHT_MAX = 10

/**
 * How far from the floor toward step 1's ceiling a real crew is assumed to land.
 *
 * ⚠️ A guess about behaviour, in the same family as `g` — the source document
 * proposes halfway and says so in the same breath as admitting it is a guess.
 * Tunable for that reason.
 */
export const EXPECTED_BLEND = 0.5

export function publishGuidance({
  scenarioName, positionIds = [], roleNames = {}, weights = {},
  chosen, ceiling = {}, readings = {},
  carryWeightMax = CARRY_WEIGHT_MAX, expectedBlend = EXPECTED_BLEND,
  nearMissWithin = 0, values = null,
  gap = null, gapIsAssumed = false, rosterSize = null, generatedAt = null,
} = {}) {
  const empty = { scenarioName, publishable: false, roles: [], value: { floor: null, expected: null, uplift: null }, assumptions: [] }
  if (!chosen || positionIds.length === 0) return { ...empty, reason: 'no-chosen-vector' }

  const blend = Math.min(1, Math.max(0, num(expectedBlend) ?? EXPECTED_BLEND))

  // ⚠️ Ordered by weight so the roles that decide the outcome are read first.
  // A table sorted by position id buries the 34%-impact role under whichever
  // one happens to be called P1.
  const ordered = [...positionIds].sort((a, b) => {
    const wa = num(weights[a])
    const wb = num(weights[b])
    if (wa !== null && wb !== null && wa !== wb) return wb - wa
    return String(a).localeCompare(String(b), 'en', { numeric: true })
  })

  const roles = ordered.map((pos) => {
    const rows = (readings?.[pos] ?? []).filter((r) => num(r?.cpr) !== null)
    const floor = num(chosen[pos])
    const top = num(ceiling[pos])
    const weight = num(weights[pos])
    const isCarry = weight !== null && weight < carryWeightMax

    const expected =
      floor === null ? null : top === null ? floor : floor + blend * (top - floor)

    const eligible = floor === null ? 0 : headcountAtCpr(rows, floor)
    const eligibleOneHigher = floor === null ? 0 : headcountAtCpr(rows, floor + 1)

    // ⚠️ Not offered for a carry role: telling somebody they are two points off
    // a bar we publish as zero is the exact pointless training this table is
    // built to prevent.
    const nearMisses =
      isCarry || floor === null || nearMissWithin <= 0
        ? []
        : rows
            .map((r) => ({ ...r, cpr: num(r.cpr) }))
            .filter((r) => r.cpr < floor && floor - r.cpr <= nearMissWithin)
            .sort((a, b) => b.cpr - a.cpr)
            .map((r) => ({
              member_id: r.member_id, cpr: r.cpr, pointsNeeded: floor - r.cpr,
            }))

    return {
      positionId: pos,
      roleName: roleNames[pos] ?? pos,
      weight,
      isCarry,
      /** What members are told to train to. Zero on a carry, by design. */
      published: isCarry ? 0 : floor,
      /** The bar the model actually scored at — kept so the table is auditable. */
      floor,
      /** Where a real crew is assumed to land, between the floor and the ceiling. */
      expected,
      ceiling: top,
      eligible,
      eligibleOneHigher,
      /**
       * How many members one more CPR point costs.
       *
       * ⚠️ A bar of 92 with four clearing it and three clearing 93 is a knife
       * edge that one person leaving invalidates — a very different instruction
       * from the same number with comfortable headroom.
       */
      cliff: eligible - eligibleOneHigher,
      /** ⚠️ Absent is not failing (#351); a role read on fewer people is softer. */
      readings: rows.length,
      nearMisses,
    }
  })

  const vFloor = num(values?.floor?.expectedValue)
  const vExpected = num(values?.expected?.expectedValue)

  const assumptions = []
  if (gap !== null) {
    assumptions.push(
      `Join gap of ${Math.round(gap * 24)}h between members${gapIsAssumed ? ' — assumed, not measured (#687)' : ''}.`
    )
  }
  if (rosterSize !== null) {
    assumptions.push(`Roster of ${rosterSize} as of generation; these move when members join or leave.`)
  }
  assumptions.push(
    `Expected crew assumed ${Math.round(blend * 100)}% of the way from the published floor toward the maximum the roster can sustain.`
  )
  assumptions.push('Carry roles publish 0 on purpose: no training is needed for them.')

  return {
    scenarioName,
    publishable: true,
    generatedAt,
    roles,
    value: {
      floor: vFloor,
      expected: vExpected,
      // ⚠️ Null rather than 0 when either crew went unpriced. A zero uplift
      // would read as "the expected crew is worth nothing extra", which is a
      // claim we have not made (#441/#473/#351).
      uplift: vFloor === null || vExpected === null || vFloor === 0 ? null : (vExpected - vFloor) / vFloor,
    },
    assumptions,
    reason: null,
  }
}
