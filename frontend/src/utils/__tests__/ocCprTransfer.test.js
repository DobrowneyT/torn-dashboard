// #602 — estimating a role's CPR for a crime this faction has never run.
//
// ⚠️ The whole point is that these are ESTIMATES. Every guard below exists so an
// estimate cannot be mistaken for a reading: outside the fitted range it is an
// extrapolation, a member with no source reading is ABSENT rather than zero, and
// a role with no coefficient is not estimated at all.
import { describe, it, expect } from 'vitest'
import { estimateReadings, TABLE_VERSION } from '../ocCprTransfer'

const COEF = {
  'Ace in the Hole||Muscle #1': {
    donor: 'tnl', source: 'Break the Bank||Muscle #2',
    slope: 0.934, intercept: 0, n: 80, mae: 0.37, source_range: [36, 77],
  },
  'Ace in the Hole||Driver': {
    donor: 'capacityx', source: 'Bidding War||Driver',
    slope: 2.012, intercept: -115.1, n: 7, mae: 1.64, source_range: [75, 85],
    low_confidence: true,
  },
}
const READINGS = {
  'Break the Bank||Muscle #2': [
    { member_id: 'a', cpr: 70 }, { member_id: 'b', cpr: 50 }, { member_id: 'c', cpr: 90 },
  ],
  'Bidding War||Driver': [{ member_id: 'a', cpr: 80 }, { member_id: 'b', cpr: 20 }],
}

const run = (over = {}) =>
  estimateReadings({ coefficients: COEF, readings: READINGS, crimeName: 'Ace in the Hole', ...over })

describe('estimateReadings', () => {
  it('applies slope and intercept, not a flat offset', () => {
    const r = run()
    const m = r.roles['Muscle #1'].readings.find((x) => x.member_id === 'a')
    expect(m.cpr).toBeCloseTo(0.934 * 70, 3)
    expect(m.estimated).toBe(true)
  })

  it('⚠️ flags a member outside the range the coefficient was fitted on', () => {
    const r = run()
    const rows = r.roles['Muscle #1'].readings
    expect(rows.find((x) => x.member_id === 'a').extrapolated).toBe(false)   // 70 in [36,77]
    expect(rows.find((x) => x.member_id === 'c').extrapolated).toBe(true)    // 90 above 77
  })

  it('⚠️ a member with no source reading is absent, never zero', () => {
    // 'c' has no Bidding War Driver reading. Scoring them 0 would put a phantom
    // member at the bottom of the roster and make the crime look crewable by
    // somebody who cannot fill the seat.
    const r = run()
    const ids = r.roles.Driver.readings.map((x) => x.member_id)
    expect(ids).toContain('a')
    expect(ids).not.toContain('c')
  })

  it('⚠️ never returns a negative CPR from extrapolating a steep slope', () => {
    // Driver slope is 2.0: a member at 20 maps to -75. That is not a weak member,
    // it is the model outside its range, and it must not reach the matcher.
    const r = run()
    const b = r.roles.Driver.readings.find((x) => x.member_id === 'b')
    expect(b).toBeUndefined()
    expect(r.roles.Driver.outOfRange).toBe(1)
  })

  it('carries the donor, its error and the low-confidence flag per role', () => {
    const r = run()
    expect(r.roles['Muscle #1'].source).toBe('Break the Bank||Muscle #2')
    expect(r.roles['Muscle #1'].mae).toBe(0.37)
    expect(r.roles['Muscle #1'].lowConfidence).toBe(false)
    expect(r.roles.Driver.lowConfidence).toBe(true)
    expect(r.roles.Driver.donor).toBe('capacityx')
  })

  it('⚠️ reports a role with no coefficient rather than inventing one', () => {
    const r = run({ coefficients: { 'Ace in the Hole||Muscle #1': COEF['Ace in the Hole||Muscle #1'] } })
    expect(Object.keys(r.roles)).toEqual(['Muscle #1'])
    expect(r.unmapped).toEqual([])          // nothing requested that we know of
    const r2 = run({ roles: ['Muscle #1', 'Driver', 'Hacker'] })
    expect(r2.unmapped).toEqual(['Hacker'])
  })

  it('⚠️ a role whose SOURCE the faction has never run is unmapped, not empty', () => {
    // "Nobody can fill this" and "we could not look" are different claims (#351).
    const r = run({ readings: { 'Break the Bank||Muscle #2': READINGS['Break the Bank||Muscle #2'] } })
    expect(r.roles.Driver).toBeUndefined()
    expect(r.unmapped).toContain('Driver')
  })

  it('returns an empty result for a crime with no coefficients at all', () => {
    const r = run({ crimeName: 'Never Heard Of It' })
    expect(r.roles).toEqual({})
    expect(r.estimated).toBe(false)
  })

  it('exposes the table version so a stale estimate is identifiable', () => {
    expect(typeof TABLE_VERSION).toBe('string')
  })
})
