// #687 — measuring the join gap instead of assuming 12 hours.
//
// ⚠️ `g` is the only free parameter in the whole per-person-per-day figure, and
// every published minimum-CPR threshold inherits it. Measured on the tenant
// databases 2026-09-14, the assumption was wrong by a factor of two in one
// direction and nearly right in the other:
//
//     tnl    n=6   formula 23.50   measured 24.22   g = 15.5h
//     forge  n=6   formula 23.50   measured 26.89   g = 28.3h
//
// So it is faction behaviour, exactly as the issue predicted, and forge's
// $/person-day was 14% optimistic.
import { describe, expect, it } from 'vitest'
import { summariseJoinGap, ASSUMED_GAP_HOURS, MIN_CRIMES_FOR_GAP } from '../src/oc/joinGap.js'

/** One crime: role count and the total person-days its members were held. */
const crime = (roles: number, personDays: number, id = Math.random().toString()) =>
  ({ crimeId: id, roles, personDays })

/** personDays for a perfect fill plus `gapHours` of slack on each of n-1 joins. */
const withGap = (n: number, gapHours: number) =>
  (n * (n + 1)) / 2 + (n - 1) * (gapHours / 24)

describe('summariseJoinGap', () => {
  it('recovers the gap the data was built with', () => {
    const rows = Array.from({ length: 40 }, (_, i) => crime(6, withGap(6, 15.5), `a${i}`))
    const out = summariseJoinGap(rows)
    expect(out.measured).toBe(true)
    expect(out.byRoleCount[6].medianGapHours).toBeCloseTo(15.5, 1)
  })

  it('⚠️ is absent, not the assumption, when there is too little history', () => {
    // "We measured 12h" and "we assumed 12h" must not look the same. A tenant
    // with no history has to keep the documented fallback and say so.
    const out = summariseJoinGap([crime(6, 24), crime(6, 25)])
    expect(out.measured).toBe(false)
    expect(out.gapHours).toBe(ASSUMED_GAP_HOURS)
    expect(out.reason).toBe('too-few-crimes')
  })

  it('reports the distribution, not just the median', () => {
    // ⚠️ A bimodal gap — fills fast on weekday evenings, stalls overnight — is a
    // different planning problem from a consistent one, and a median hides it.
    const rows = [
      ...Array.from({ length: 20 }, (_, i) => crime(6, withGap(6, 4), `f${i}`)),
      ...Array.from({ length: 20 }, (_, i) => crime(6, withGap(6, 30), `s${i}`)),
    ]
    const out = summariseJoinGap(rows)
    const b = out.byRoleCount[6]
    expect(b.p10GapHours).toBeLessThan(6)
    expect(b.p90GapHours).toBeGreaterThan(28)
    expect(b.spreadHours).toBeGreaterThan(20)
  })

  it('keeps role counts apart', () => {
    const rows = [
      ...Array.from({ length: 30 }, (_, i) => crime(4, withGap(4, 10), `x${i}`)),
      ...Array.from({ length: 30 }, (_, i) => crime(6, withGap(6, 25), `y${i}`)),
    ]
    const out = summariseJoinGap(rows)
    expect(out.byRoleCount[4].medianGapHours).toBeCloseTo(10, 1)
    expect(out.byRoleCount[6].medianGapHours).toBeCloseTo(25, 1)
  })

  it('⚠️ drops a single-role crime rather than dividing by zero', () => {
    // g is slack per JOIN, and a one-role crime has no second joiner.
    const rows = [...Array.from({ length: 30 }, (_, i) => crime(1, 1, `z${i}`)),
                  ...Array.from({ length: 30 }, (_, i) => crime(6, withGap(6, 12), `w${i}`))]
    const out = summariseJoinGap(rows)
    expect(out.byRoleCount[1]).toBeUndefined()
    expect(out.measured).toBe(true)
  })

  it('⚠️ clamps a negative gap to zero rather than reporting a crime that beat physics', () => {
    // personDays below the perfect-fill lock-in means a clock or a missing slot
    // is wrong, not that members joined before the crime existed.
    const rows = Array.from({ length: 30 }, (_, i) => crime(6, 18, `n${i}`))   // < 21 lock-in
    const out = summariseJoinGap(rows)
    expect(out.byRoleCount[6].medianGapHours).toBe(0)
  })

  it('caps an absurd gap and counts it rather than letting it drag the median', () => {
    const rows = [
      ...Array.from({ length: 30 }, (_, i) => crime(6, withGap(6, 12), `ok${i}`)),
      crime(6, 500, 'stuck'),
    ]
    const out = summariseJoinGap(rows)
    expect(out.byRoleCount[6].medianGapHours).toBeCloseTo(12, 1)
    expect(out.byRoleCount[6].capped).toBe(1)
  })

  it('gives one overall gap, weighted by how much each role count is actually run', () => {
    const rows = [
      ...Array.from({ length: 60 }, (_, i) => crime(6, withGap(6, 20), `m${i}`)),
      ...Array.from({ length: 10 }, (_, i) => crime(4, withGap(4, 5), `s${i}`)),
    ]
    const out = summariseJoinGap(rows)
    expect(out.gapHours).toBeGreaterThan(15)     // dominated by the 6-role crimes
    expect(out.measured).toBe(true)
  })

  it('exposes the crime count behind every figure', () => {
    const rows = Array.from({ length: MIN_CRIMES_FOR_GAP + 5 }, (_, i) => crime(6, withGap(6, 12), `c${i}`))
    const out = summariseJoinGap(rows)
    expect(out.crimes).toBe(MIN_CRIMES_FOR_GAP + 5)
    expect(out.byRoleCount[6].crimes).toBe(MIN_CRIMES_FOR_GAP + 5)
  })
})
