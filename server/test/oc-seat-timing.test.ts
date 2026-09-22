// #744 — when members actually take their seats, against when the seat is needed.
//
// ⚠️ This measures the thing #687's `g` was standing in for. `g` is a single
// reconciled number, so a faction whose members queue up at the front and one
// whose crimes simply run long produce the same value — and only the first is
// something a faction can change tomorrow.
//
// The observed rule: a crime completes `24h × n` after the FIRST join, and all
// slots are open from the start. So seat `s` is not needed until hour
// `24 × (s − 1)`; anything earlier is capacity removed from every other crime
// for no gain, because a member cannot be in two organized crimes at once.
import { describe, expect, it } from 'vitest'
import {
  summariseSeatTiming,
  IDEAL_HOURS_PER_SEAT,
  MIN_OBSERVATIONS_PER_SEAT,
  MAX_PLAUSIBLE_SEAT_HOURS,
} from '../src/oc/seatTiming.js'

/** A seat observation as the SQL hands it over. */
const seat = (roles: number, s: number, medianHours: number, n = 40) =>
  ({ roles, seat: s, observations: n, medianHours })

// capacityx's real shape, from the issue: the sixth member sits down at hour 65
// for a slot not needed until 120.
const CAPACITYX = [
  seat(6, 1, 13.6), seat(6, 2, 28.0), seat(6, 3, 36.3),
  seat(6, 4, 44.6), seat(6, 5, 52.8), seat(6, 6, 65.0),
]

// tnl's, which tracks the ideal line closely.
const TNL = [
  seat(6, 1, 4.0), seat(6, 2, 19.3), seat(6, 3, 49.5),
  seat(6, 4, 73.7), seat(6, 5, 97.5), seat(6, 6, 113.4),
]

describe('summariseSeatTiming', () => {
  it('scores each seat against the hour it is actually needed', () => {
    const out = summariseSeatTiming(CAPACITYX)
    const six = out.byRoleCount[6]
    expect(six.seats[5]).toMatchObject({ seat: 6, idealHours: 120, medianHours: 65 })
    expect(six.seats[5].earlyHours).toBe(55)
  })

  it('⚠️ counts the first seat as never early', () => {
    // Seat 1 STARTS the clock — the crime completes 24h×n from that join, so
    // there is no earlier hour it could have been taken. Scoring it against
    // hour 0 would charge a faction for the act of beginning a crime.
    const out = summariseSeatTiming(CAPACITYX)
    expect(out.byRoleCount[6].seats[0]).toMatchObject({ seat: 1, idealHours: 0, earlyHours: 0 })
  })

  it('reports a late seat as late rather than as negative earliness', () => {
    // tnl's third seat lands at 49.5 for an hour-48 slot. That is not capacity
    // freed and must not subtract from the total.
    const out = summariseSeatTiming(TNL)
    const third = out.byRoleCount[6].seats[2]
    expect(third.earlyHours).toBe(0)
    expect(third.lateHours).toBeCloseTo(1.5, 5)
  })

  it('⚠️ totals only the early side, because late seating does not free capacity', () => {
    // Netting signed offsets lets one late seat cancel another's earliness and
    // reports a faction as nearly fine when it is not. tnl is the live example:
    // seats 2 and 6 are 11.3h early between them, seats 1/3/4/5 are 8.7h late,
    // and a signed sum would call the whole thing 2.6h.
    const six = summariseSeatTiming(TNL).byRoleCount[6]
    const signed = six.seats.reduce((a, s) => a + (s.idealHours - s.medianHours), 0)
    expect(signed).toBeCloseTo(2.6, 5)
    expect(six.earlyHoursTotal).toBeCloseTo(11.3, 5)
    expect(six.earlyHoursTotal).toBeGreaterThan(signed)
  })

  it('turns the early hours into person-days, which is the unit that spends', () => {
    // capacityx: 0 + 0 + 11.7 + 27.4 + 43.2 + 55 = 137.3 hours ÷ 24.
    const six = summariseSeatTiming(CAPACITYX).byRoleCount[6]
    expect(six.earlyHoursTotal).toBeCloseTo(137.3, 5)
    expect(six.earlyPersonDays).toBeCloseTo(137.3 / 24, 5)
  })

  it('names the seat worth acting on', () => {
    const six = summariseSeatTiming(CAPACITYX).byRoleCount[6]
    expect(six.worstSeat).toMatchObject({ seat: 6, earlyHours: 55 })
  })

  it('⚠️ says a faction is on the line rather than inventing a lever', () => {
    // A faction already seating on schedule must not be handed a number to
    // chase — "free 0.1 person-days" is noise dressed as advice.
    const onTime = [1, 2, 3, 4, 5, 6].map((s) => seat(6, s, IDEAL_HOURS_PER_SEAT * (s - 1)))
    const six = summariseSeatTiming(onTime).byRoleCount[6]
    expect(six.earlyPersonDays).toBe(0)
    expect(six.worstSeat).toBeNull()
  })
})

describe('summariseSeatTiming — what it refuses to conclude', () => {
  it('⚠️ drops a seat with too few observations instead of reporting a median of three', () => {
    const thin = [seat(6, 1, 0, 40), seat(6, 2, 10, 2), seat(6, 3, 20, 40)]
    const six = summariseSeatTiming(thin).byRoleCount[6]
    expect(six.seats.map((s) => s.seat)).toEqual([1, 3])
    expect(six.thinSeats).toEqual([2])
  })

  it('⚠️ excludes an implausible hold rather than letting it drag the figure', () => {
    // A seat "taken" a fortnight in is a stall, a clock problem, or a crime
    // nobody finished — not a faction filling slowly.
    const stalled = [seat(6, 1, 0), seat(6, 2, MAX_PLAUSIBLE_SEAT_HOURS + 50)]
    const six = summariseSeatTiming(stalled).byRoleCount[6]
    expect(six.seats.map((s) => s.seat)).toEqual([1])
    expect(six.implausibleSeats).toEqual([2])
  })

  it('returns nothing measurable for an empty history', () => {
    const out = summariseSeatTiming([])
    expect(out.measured).toBe(false)
    expect(out.reason).toBe('no-observations')
    expect(out.byRoleCount).toEqual({})
  })

  it('keeps role counts apart, because the ideal line depends on n', () => {
    const mixed = [
      seat(4, 1, 0), seat(4, 2, 10),
      seat(6, 1, 0), seat(6, 2, 10),
    ]
    const out = summariseSeatTiming(mixed)
    expect(Object.keys(out.byRoleCount).sort()).toEqual(['4', '6'])
    expect(out.byRoleCount[4].seats[1].idealHours).toBe(24)
    expect(out.byRoleCount[6].seats[1].idealHours).toBe(24)
  })

  it('⚠️ ignores a seat number a crime of that size cannot have', () => {
    // A seventh seat in a six-role crime means the join ordering or the role
    // count is wrong; scoring it against hour 144 would invent earliness.
    const out = summariseSeatTiming([seat(6, 1, 0), seat(6, 7, 100)])
    expect(out.byRoleCount[6].seats.map((s) => s.seat)).toEqual([1])
  })
})

describe('summariseSeatTiming — the headline', () => {
  it('picks the role count with the most to gain', () => {
    const out = summariseSeatTiming([
      ...CAPACITYX,
      seat(4, 1, 0), seat(4, 2, 24), seat(4, 3, 48), seat(4, 4, 72),
    ])
    expect(out.headline?.roles).toBe(6)
    expect(out.headline?.seat).toBe(6)
    expect(out.headline?.earlyHours).toBe(55)
  })

  it('has no headline when nothing is early', () => {
    const onTime = [1, 2, 3, 4].map((s) => seat(4, s, IDEAL_HOURS_PER_SEAT * (s - 1)))
    expect(summariseSeatTiming(onTime).headline).toBeNull()
  })

  it('reports it measured something even when the news is good', () => {
    const onTime = [1, 2, 3, 4].map((s) => seat(4, s, IDEAL_HOURS_PER_SEAT * (s - 1)))
    const out = summariseSeatTiming(onTime)
    expect(out.measured).toBe(true)
    expect(out.reason).toBe('ok')
  })
})

describe('MIN_OBSERVATIONS_PER_SEAT', () => {
  it('is stated rather than buried, since it decides what gets reported', () => {
    expect(MIN_OBSERVATIONS_PER_SEAT).toBeGreaterThan(1)
  })
})
