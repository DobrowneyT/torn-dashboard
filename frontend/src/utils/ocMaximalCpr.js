/**
 * Step 1 of the CPR algorithm (#691, part of #688): the maximal CPR vector.
 *
 * The highest bar we can set on each role while still having at least `n`
 * members able to fill it, where `n` is the crime's role count.
 *
 * ⚠️ **This is the CEILING of the search space, not the answer we publish.**
 * The algorithm document frames it the same way — step 3 opens "This sets the
 * upper limit of the potential income for each crime" — and #692 descends from
 * here looking for the vector that maximises $ per faction member per day.
 * Publishing this directly would ask the whole faction to train to a bar that
 * lets us run exactly one crime.
 *
 * ⚠️ **Why `n` and not some other number.** Hall's marriage theorem: if every
 * one of `n` roles has at least `n` candidates, then for any subset S of roles
 * |N(S)| >= n >= |S|, so a crew of DISTINCT members always exists. The rule is
 * not a heuristic — it is provably sufficient for a single crime, and it is
 * exactly the condition that closes the disjointness gap `ocRosterFit.js`
 * documents. It says nothing about two concurrent crimes; that is
 * `ocCrewMatching.js` (#689).
 *
 * ⚠️ **No safety margin, deliberately.** This output is fragile by
 * construction: on Blast from the Past a single CPR point costs six of seven
 * eligible members on three of the six roles. That is accepted precisely
 * because nothing is published from here — the fragility is confined to the top
 * of a search that moves downward into comfortable territory.
 */

import { headcountAtCpr, maxSustainableCpr } from './ocRosterFit'

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

/** Readings carrying a usable number. A null CPR is an absent reading, not a zero. */
const usable = (rows) => (rows ?? []).filter((r) => num(r?.cpr) !== null)

/**
 * @param readingsByRole `{ [positionId]: [{ member_id, cpr }] }`
 * @param positionIds the crime's roles. Their COUNT is the bar — pass the
 *   crime's real role list, not the keys of whatever readings happen to exist.
 *
 * @returns `vector` (positionId → maximal CPR, or null), per-role detail, and
 *   `limitingRoles` — the roles with too few readings to crew at any bar.
 */
export function maximalCprVector(readingsByRole, positionIds) {
  const positions = [...(positionIds ?? [])]
  const needed = positions.length

  const roles = {}
  const vector = {}
  const limitingRoles = []

  for (const pos of positions) {
    const rows = usable(readingsByRole?.[pos])
    // ⚠️ `maxSustainableCpr` returns null when fewer than `needed` members have
    // a reading at all. That is "we cannot crew this at ANY bar", which is a
    // different fact from "the bar is zero" — and the reason is a gap in our
    // observations, not a verdict on the roster.
    const cpr = needed > 0 ? maxSustainableCpr(rows, needed) : null
    const eligible = cpr === null ? 0 : headcountAtCpr(rows, cpr)
    const atNextPoint = cpr === null ? 0 : headcountAtCpr(rows, cpr + 1)

    roles[pos] = {
      positionId: pos,
      cpr,
      eligible,
      // ⚠️ Carried alongside the headcount because the denominators genuinely
      // differ per role — 92, 88, 92, 92, 91, 91 on the live roster. A role
      // with four fewer readings has a correspondingly softer number, and a
      // member with no reading is absent rather than failing (#351).
      readings: rows.length,
      atNextPoint,
      /**
       * How many members one more CPR point costs.
       *
       * ⚠️ The threshold alone is not enough to act on. A bar of 87 where
       * seven clear it and one clears 88 is a very different object from one
       * with comfortable headroom: the first is a knife edge that a single
       * member leaving invalidates, and #692 needs to know which it has before
       * treating the ceiling as meaningful.
       */
      cliff: eligible - atNextPoint,
    }
    vector[pos] = cpr
    if (cpr === null) limitingRoles.push(pos)
  }

  return {
    // ⚠️ False for a crime with NO roles too. An empty role list is not a
    // crime we can field — it is a crime we know nothing about.
    crewable: needed > 0 && limitingRoles.length === 0,
    roleCount: needed,
    roles,
    vector,
    limitingRoles,
  }
}
