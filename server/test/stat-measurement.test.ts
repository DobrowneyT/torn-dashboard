// #996 — the pure rules: reading a defender's score back out of Torn's FF.
import { describe, expect, it } from 'vitest'
import {
  battleStatsScore, predictedFF, measureFromHit, decide, deadbandFrom, maxAgeDaysFrom,
  DEADBAND_DEFAULT, MAX_AGE_DAYS_DEFAULT,
} from '../src/statMeasurement.js'

const ATT = 40_000 // four stats of 1e8: 4 × √1e8

describe('measureFromHit', () => {
  it('runs the FF formula backwards', () => {
    const m = measureFromHit(2, ATT)!
    expect(m.bound).toBe('exact')
    expect(m.score).toBeCloseTo(15_000)
    // And forwards again, to the same FF.
    expect(predictedFF(m.score, ATT)).toBeCloseTo(2)
  })

  it('a capped hit is only a lower bound', () => {
    expect(measureFromHit(3, ATT)).toEqual({ score: 30_000, bound: 'at_least' })
    expect(measureFromHit(2.995, ATT)!.bound).toBe('at_least')
  })

  it('FF 1.00 is the column default, not a reading', () => {
    expect(measureFromHit(1, ATT)).toBeNull()
    expect(measureFromHit(2, 0)).toBeNull()
  })
})

describe('decide', () => {
  const deadband = 0.1

  it('stores when there is no belief at all', () => {
    expect(decide({ ff: 2, attackerScore: ATT, current: null, deadband }).action).toBe('store')
  })

  it('leaves the belief alone inside the deadband', () => {
    // A belief predicting 1.95 for this hitter; Torn gave 2.00.
    const current = 0.95 * (3 / 8) * ATT
    expect(decide({ ff: 2, attackerScore: ATT, current, deadband })).toEqual({ action: 'confirm' })
  })

  it('replaces it outside the deadband', () => {
    const current = 0.8 * (3 / 8) * ATT // predicts 1.80
    const d = decide({ ff: 2, attackerScore: ATT, current, deadband })
    expect(d.action).toBe('store')
  })

  it('a capped hit corrects a belief that predicted well under the cap', () => {
    const weak = 0.5 * (3 / 8) * ATT // predicts 1.50
    expect(decide({ ff: 3, attackerScore: ATT, current: weak, deadband }).action).toBe('store')
    const strong = 2 * ATT // predicts the cap
    expect(decide({ ff: 3, attackerScore: ATT, current: strong, deadband })).toEqual({ action: 'confirm' })
  })
})

describe('battleStatsScore', () => {
  it('matches the SPA: four stats, else an even split of the total', () => {
    expect(battleStatsScore({ str: 1e8, spd: 1e8, def: 1e8, dex: 1e8 })).toBeCloseTo(ATT)
    expect(battleStatsScore({ total: 4e8 })).toBeCloseTo(ATT)
    expect(battleStatsScore({})).toBeNull()
  })
})

describe('tunables', () => {
  it('fall back to the defaults on nonsense', () => {
    expect(deadbandFrom(null)).toBe(DEADBAND_DEFAULT)
    expect(deadbandFrom('0.2')).toBe(0.2)
    expect(deadbandFrom(-1)).toBe(DEADBAND_DEFAULT)
    expect(maxAgeDaysFrom(undefined)).toBe(MAX_AGE_DAYS_DEFAULT)
    expect(maxAgeDaysFrom('14')).toBe(14)
    expect(maxAgeDaysFrom(0)).toBe(MAX_AGE_DAYS_DEFAULT)
  })
})
