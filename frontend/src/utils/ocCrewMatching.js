/**
 * How many disjoint crews can we actually field? (#689)
 *
 * ⚠️ **Why a matching and not a headcount.** `ocRosterFit.js` answers "how many
 * members clear the bar for this role", and for a single crime that is enough —
 * by Hall's marriage theorem, if every one of `n` roles has at least `n`
 * candidates then a crew of DISTINCT members always exists, because for any
 * subset S of roles |N(S)| >= n >= |S|.
 *
 * That guarantee dies the moment you want two crimes running at once. Then you
 * need `k` candidates per role AND `k*n` across the UNION of the eligible sets,
 * and a per-role count cannot see the union. Measured on Blast from the Past,
 * every role has 7-9 eligible members, so the per-role bound says seven crews.
 * If the same nine strong members are the ones clearing every bar, the true
 * answer is one. **A per-role bound can be wrong by 5x, always optimistically.**
 *
 * This is the assignment problem `ocRosterFit.js` defers to the team builder:
 *
 *   > ⚠️ Deliberately does NOT check that the eligible sets are disjoint. One
 *   > member can be the only person clearing the bar for three roles, and this
 *   > would call that crime crewable.
 *
 * ⚠️ **The constraint is a game rule, not a modelling choice.** A member cannot
 * be in two organised crimes at once, so a seat filled here is a seat that
 * cannot be filled anywhere else.
 *
 * ⚠️ Still an UPPER BOUND on what is fieldable TODAY. These readings do not know
 * who is already committed to a crime in flight; `k` is what the roster could
 * support from a standing start.
 */

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

/**
 * ⚠️ Every ordering in this module routes through here, and that is what makes
 * the result reproducible. A leader comparing two runs must not see crews
 * reshuffle when nothing about the roster changed — churn that is not real
 * destroys trust in the number faster than being wrong would.
 *
 * Numeric-aware because member ids and position ids are text holding digits:
 * plain string order puts "P10" between "P1" and "P2".
 */
const byId = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true })

/**
 * Members eligible for one role, with the two rejection reasons kept apart.
 *
 * ⚠️ "Never observed in this role" and "observed, below the bar" are different
 * facts and must not be summed. The first is a gap in our measurement; the
 * second is a gap in the roster. Reporting them together would send someone
 * training a member who is already fine, or leave a role looking impossible
 * when we simply have not looked (#351).
 */
function eligibleFor(rows, threshold, universe) {
  const bar = num(threshold)
  const eligible = new Set()
  let belowBar = 0
  const seen = new Set()
  for (const row of rows ?? []) {
    const id = String(row?.member_id ?? '')
    if (id === '') continue
    seen.add(id)
    const cpr = num(row?.cpr)
    // A null reading is not a zero — it is the absence of a reading, and this
    // member is counted as unmeasured rather than as failing.
    if (cpr === null) continue
    if (bar !== null && cpr >= bar) eligible.add(id)
    else belowBar += 1
  }
  let withoutReading = 0
  for (const id of universe) if (!seen.has(id)) withoutReading += 1
  return { eligible, belowBar, withoutReading }
}

/**
 * Kuhn's augmenting-path search for one slot.
 *
 * Plain recursion is fine here: depth is bounded by the number of slots, which
 * is `k * roles` — single-digit `k` against at most six roles. Reaching for
 * Hopcroft-Karp would buy nothing at this size and cost readability.
 */
function assign(slot, adjacency, slotOfMember, visited) {
  for (const memberId of adjacency[slot]) {
    if (visited.has(memberId)) continue
    visited.add(memberId)
    const held = slotOfMember.get(memberId)
    if (held === undefined || assign(held, adjacency, slotOfMember, visited)) {
      slotOfMember.set(memberId, slot)
      return true
    }
  }
  return false
}

/** Try to seat `k` full crews. Returns the seating, or the roles that ran dry. */
function seat(positions, eligibleByPos, k) {
  const slots = []
  for (let copy = 0; copy < k; copy += 1) {
    for (const pos of positions) slots.push({ pos, copy })
  }
  const adjacency = slots.map((s) => [...eligibleByPos[s.pos]].sort(byId))
  const slotOfMember = new Map()
  const unfilled = []
  for (let i = 0; i < slots.length; i += 1) {
    if (!assign(i, adjacency, slotOfMember, new Set())) unfilled.push(slots[i].pos)
  }
  if (unfilled.length > 0) return { ok: false, limitingRoles: [...new Set(unfilled)] }

  const crews = Array.from({ length: k }, () => ({}))
  for (const [memberId, slotIndex] of slotOfMember) {
    const { pos, copy } = slots[slotIndex]
    crews[copy][pos] = memberId
  }
  return { ok: true, crews }
}

/**
 * The largest number of simultaneous crews this roster supports at these bars.
 *
 * @param readingsByRole `{ [positionId]: [{ member_id, cpr }] }` — as served by
 *   the roster-CPR endpoint.
 * @param cprVector `{ [positionId]: number }` — the bar per role. Its keys
 *   define the crime's roles, so a role with no entry is not part of the crew.
 * @param maxK optional ceiling, for a caller that only needs to know "at least".
 *
 * @returns `k`, the `crews` seating it, and per-role diagnostics. `limitingRoles`
 *   names the roles that ran out at `k + 1` — what slice #693 needs in order to
 *   relax the right threshold rather than lowering every bar at once.
 */
export function maxDisjointCrews(readingsByRole, cprVector, { maxK = Infinity } = {}) {
  const positions = Object.keys(cprVector ?? {}).sort(byId)

  // The observed universe: everyone with a reading for ANY of this crime's
  // roles. Deliberately not the whole roster — a member we have never observed
  // in any of these roles tells us nothing about this crime, and counting them
  // as "without a reading" on all six would make every role look unmeasured.
  const universe = new Set()
  for (const pos of positions) {
    for (const row of readingsByRole?.[pos] ?? []) {
      const id = String(row?.member_id ?? '')
      if (id !== '') universe.add(id)
    }
  }

  const eligibleByPos = {}
  const perRoleEligible = {}
  const perRoleBelowBar = {}
  const perRoleWithoutReading = {}
  for (const pos of positions) {
    const r = eligibleFor(readingsByRole?.[pos], cprVector[pos], universe)
    eligibleByPos[pos] = r.eligible
    perRoleEligible[pos] = r.eligible.size
    perRoleBelowBar[pos] = r.belowBar
    perRoleWithoutReading[pos] = r.withoutReading
  }

  const diagnostics = { perRoleEligible, perRoleBelowBar, perRoleWithoutReading }

  if (positions.length === 0) return { k: 0, crews: [], limitingRoles: [], ...diagnostics }

  // Two cheap ceilings before doing any matching work. Both are upper bounds:
  // no role can seat more crews than it has candidates, and no crime can seat
  // more crews than the union supports at `positions.length` seats apiece.
  const perRoleCap = Math.min(...positions.map((p) => eligibleByPos[p].size))
  const union = new Set()
  for (const pos of positions) for (const id of eligibleByPos[pos]) union.add(id)
  const unionCap = Math.floor(union.size / positions.length)
  const cap = Math.min(perRoleCap, unionCap, maxK)

  let best = { k: 0, crews: [] }
  let limitingRoles = positions.filter((p) => eligibleByPos[p].size === 0)

  // Feasibility is monotone — if `k` crews seat, so do `k - 1` — so the first
  // failure is the answer. `k` is single digits in practice, so walking up is
  // clearer than a binary search and costs nothing.
  for (let k = 1; k <= cap; k += 1) {
    const attempt = seat(positions, eligibleByPos, k)
    if (!attempt.ok) {
      limitingRoles = attempt.limitingRoles
      break
    }
    best = { k, crews: attempt.crews }
    limitingRoles = []
  }

  // Nothing was tried because a ceiling already said no: name the roles at fault.
  if (best.k === 0 && cap < 1 && limitingRoles.length === 0) {
    const fewest = Math.min(...positions.map((p) => eligibleByPos[p].size))
    limitingRoles = positions.filter((p) => eligibleByPos[p].size === fewest)
  }
  // We stopped at the caller's ceiling, not at a real shortage.
  if (best.k === maxK) limitingRoles = []

  return { ...best, limitingRoles, ...diagnostics }
}
