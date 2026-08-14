/**
 * How many of our members can actually fill a role at a given CPR (#442).
 *
 * MonChoon: *"If I change the CPR in this crime, how many of our current members
 * can fill that role... the silver bullet is the layer above that."*
 *
 * ⚠️ Everything here is an UPPER BOUND on availability. A member with the CPR
 * may already be in another crime — members cannot be in two OCs at once — and
 * these readings do not know that. Every label must say "can fill", never "are
 * available".
 */

import { parseDbTime } from './time'

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

/** Readings older than this are worth flagging; cpr-scan runs twice a day. */
export const STALE_READING_DAYS = 14

/**
 * How many readings meet or beat `threshold`.
 *
 * A member with no reading for this role is NOT counted as failing — they are
 * simply absent from the list, and `unknownMembers` on the summary carries that
 * separately. Counting an unknown as a zero is the #351 mistake: it makes a
 * crime nobody has run look like a crime nobody can do.
 */
export function headcountAtCpr(readings, threshold) {
  const t = num(threshold)
  if (t === null) return 0
  return (readings ?? []).filter((r) => (num(r.cpr) ?? -1) >= t).length
}

/**
 * The CPR → headcount curve for one role.
 *
 * The more useful direction of the question: not "how many at 70" but "where
 * does the roster fall off a cliff". Returns one point per step.
 */
export function cprCurve(readings, step = 5) {
  const points = []
  for (let cpr = 0; cpr <= 100; cpr += step) {
    points.push({ cpr, count: headcountAtCpr(readings, cpr) })
  }
  return points
}

/**
 * The highest CPR at which at least `needed` members can still fill the role.
 *
 * This is the practical ceiling for a role — set the bar above it and the crime
 * cannot be crewed. Returns null when even 0 is not achievable, which means we
 * have no readings at all rather than that the roster is bad.
 */
export function maxSustainableCpr(readings, needed = 1) {
  const values = (readings ?? []).map((r) => num(r.cpr)).filter((v) => v !== null)
  if (values.length < needed || needed < 1) return null
  return values.sort((a, b) => b - a)[needed - 1]
}

/**
 * Per-role fit summary at the CPRs currently on the sliders.
 *
 * `shortfall` is the number of extra people needed to crew the role at this
 * bar. It is the number that decides whether a plan is real.
 */
export function roleFit(role, readings, threshold, { needed = 1 } = {}) {
  const eligible = headcountAtCpr(readings, threshold)
  return {
    positionId: role.position_id,
    roleName: role.role_name,
    eligible,
    // Distinct from "0 eligible": no readings at all means we have never
    // observed anyone in this role, not that nobody can do it.
    hasReadings: (readings ?? []).length > 0,
    shortfall: Math.max(0, needed - eligible),
    ceiling: maxSustainableCpr(readings, needed),
  }
}

/**
 * Whether the whole crew can be fielded at the current sliders.
 *
 * ⚠️ Deliberately does NOT check that the eligible sets are disjoint. One
 * member can be the only person clearing the bar for three roles, and this
 * would call that crime crewable. Solving it properly is an assignment problem
 * and belongs with the team builder (#443); until then the summary says
 * "per role" so nobody reads it as a guarantee.
 */
export function crewFit(roles, readingsByRole, cprs) {
  const fits = (roles ?? []).map((role, i) =>
    roleFit(role, readingsByRole?.[role.position_id], cprs?.[i])
  )
  const unfilled = fits.filter((f) => f.eligible === 0)
  return {
    roles: fits,
    // The binding role: whichever has the fewest people clearing its bar.
    tightest: fits.length > 0
      ? fits.reduce((a, b) => (b.eligible < a.eligible ? b : a))
      : null,
    unfilled: unfilled.map((f) => f.roleName),
    crewable: fits.length > 0 && unfilled.length === 0,
  }
}

/** Readings we have not refreshed in a while, which may misstate the roster. */
export function staleReadings(readings, now = Date.now(), days = STALE_READING_DAYS) {
  const cutoff = now - days * 86400 * 1000
  // parseDbTime, not Date.parse: Postgres serves timestamptz with a bare two
  // digit offset ("...+00"), which both Date.parse and new Date read as NaN.
  // A NaN comparison is false, so every reading would silently look fresh —
  // the #140 trap, which the repo's scanner caught in this very function.
  return (readings ?? []).filter((r) => {
    const d = parseDbTime(r.updated_at)
    return d !== null && d.getTime() < cutoff
  }).length
}
