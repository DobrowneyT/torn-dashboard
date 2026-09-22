/**
 * When members actually take their seats, against when the seat is needed (#744).
 *
 * #687 measures `g`, the single slack term in
 * `personDays(n, g) = n(n+1)/2 + (n-1)·g`. The arithmetic is right and the
 * measurement is right, but one number conflates at least two mechanisms:
 *
 *   1. **Early seating** — members queue up at the front of a crime.
 *   2. **Wall-clock extension** — the crime itself runs longer than `24h × n`,
 *      which holds every member longer. Pause delay contributes here.
 *
 * ⚠️ **Only the first is something a faction can change tomorrow**, and a single
 * `g` cannot tell them apart: tnl's wall-clock excess is LARGER than forge's
 * while its person-day excess is far smaller. This module measures the first on
 * its own.
 *
 * ## The rule being scored against
 *
 * A crime completes `24h × n` after the FIRST join, and — established in #744 —
 * all slots are open from the start; the staggered fill is convention, not
 * enforcement. So seat `s` is not needed until hour `24 × (s − 1)`. A member
 * seated before that is capacity removed from every other crime for no gain,
 * because a member cannot be in two organized crimes at once.
 *
 * ⚠️ Seat 1 is never early. That join STARTS the clock, so there is no earlier
 * hour it could have been taken; scoring it against hour 0 would charge a
 * faction for the act of beginning a crime.
 */

/** Hours a seat buys before the next one is needed — the game's own step. */
export const IDEAL_HOURS_PER_SEAT = 24

/**
 * ⚠️ A median over a handful of joins is not a measurement, and this figure is
 * meant to be acted on — "your sixth seat is 55h early" has to survive being
 * checked.
 */
export const MIN_OBSERVATIONS_PER_SEAT = 5

/**
 * ⚠️ A seat "taken" a fortnight in is a stall, a clock problem, or a crime
 * nobody finished. Counted and excluded rather than dragging the figure — the
 * same treatment #687 gives an implausible hold.
 */
export const MAX_PLAUSIBLE_SEAT_HOURS = 24 * 14

/** One seat position, as the SQL aggregates it. */
export interface SeatObservation {
  roles: number
  seat: number
  observations: number
  medianHours: number
}

export interface SeatRow {
  seat: number
  observations: number
  /** Hour this seat is actually needed: 24 × (seat − 1). */
  idealHours: number
  medianHours: number
  /** Hours taken BEFORE it was needed. Never negative — see `lateHours`. */
  earlyHours: number
  /** Hours taken after. Reported, but never netted off the early total. */
  lateHours: number
}

export interface RoleCountTiming {
  roles: number
  seats: SeatRow[]
  earlyHoursTotal: number
  /** The capacity a faction would free by moving onto the ideal line. */
  earlyPersonDays: number
  worstSeat: SeatRow | null
  /** Seat numbers dropped for too few observations, so the gap is visible. */
  thinSeats: number[]
  /** Seat numbers dropped as implausible holds. */
  implausibleSeats: number[]
}

export interface SeatTimingSummary {
  measured: boolean
  reason: 'ok' | 'no-observations'
  byRoleCount: Record<number, RoleCountTiming>
  /** The single most actionable number: which seat, in which size of crime. */
  headline: { roles: number; seat: number; earlyHours: number; earlyPersonDays: number } | null
}

const round = (v: number) => Math.round(v * 1e6) / 1e6

export function summariseSeatTiming(observations: SeatObservation[]): SeatTimingSummary {
  const byRoles = new Map<number, SeatObservation[]>()
  for (const o of observations ?? []) {
    const roles = Number(o?.roles)
    const seat = Number(o?.seat)
    if (!Number.isInteger(roles) || roles < 1) continue
    // ⚠️ A seat number a crime of that size cannot have means the join ordering
    // or the role count is wrong. Scoring it against an ideal hour it never had
    // would invent earliness out of a data error.
    if (!Number.isInteger(seat) || seat < 1 || seat > roles) continue
    if (!Number.isFinite(Number(o?.medianHours))) continue
    const list = byRoles.get(roles) ?? []
    list.push(o)
    byRoles.set(roles, list)
  }

  const byRoleCount: Record<number, RoleCountTiming> = {}

  for (const [roles, list] of byRoles) {
    const seats: SeatRow[] = []
    const thinSeats: number[] = []
    const implausibleSeats: number[] = []

    for (const o of [...list].sort((a, b) => a.seat - b.seat)) {
      const medianHours = Number(o.medianHours)
      if (medianHours > MAX_PLAUSIBLE_SEAT_HOURS || medianHours < 0) {
        implausibleSeats.push(o.seat)
        continue
      }
      if (Number(o.observations) < MIN_OBSERVATIONS_PER_SEAT) {
        thinSeats.push(o.seat)
        continue
      }
      const idealHours = IDEAL_HOURS_PER_SEAT * (o.seat - 1)
      const offset = idealHours - medianHours
      seats.push({
        seat: o.seat,
        observations: Number(o.observations),
        idealHours,
        medianHours: round(medianHours),
        // ⚠️ Split rather than signed. Summing signed offsets would let one
        // late seat cancel another's earliness and report a faction as fine
        // when both are wrong.
        earlyHours: round(Math.max(0, offset)),
        lateHours: round(Math.max(0, -offset)),
      })
    }

    const earlyHoursTotal = round(seats.reduce((a, s) => a + s.earlyHours, 0))
    const worstSeat = seats.reduce<SeatRow | null>(
      (best, s) => (s.earlyHours > 0 && (!best || s.earlyHours > best.earlyHours) ? s : best),
      null,
    )

    byRoleCount[roles] = {
      roles,
      seats,
      earlyHoursTotal,
      earlyPersonDays: round(earlyHoursTotal / 24),
      worstSeat,
      thinSeats,
      implausibleSeats,
    }
  }

  const ranked = Object.values(byRoleCount)
    .filter((r) => r.worstSeat !== null)
    .sort((a, b) => b.earlyHoursTotal - a.earlyHoursTotal)
  const top = ranked[0]

  return {
    measured: Object.keys(byRoleCount).length > 0,
    reason: Object.keys(byRoleCount).length > 0 ? 'ok' : 'no-observations',
    byRoleCount,
    headline: top
      ? {
          roles: top.roles,
          seat: top.worstSeat!.seat,
          earlyHours: top.worstSeat!.earlyHours,
          earlyPersonDays: top.earlyPersonDays,
        }
      : null,
  }
}
