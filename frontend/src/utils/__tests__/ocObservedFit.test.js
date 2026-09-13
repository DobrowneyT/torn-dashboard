// #728 — is the model's prediction consistent with our own history?
import { describe, it, expect } from 'vitest'
import { compareToObserved, DISAGREEMENT_POINTS } from '../ocObservedFit'

const obs = (over = {}) => ({
  runs: 180, successes: 140, rate: 140 / 180, enough: true,
  buckets: [
    { lo: 62, hi: 70, meanCpr: 66, runs: 120, successes: 90, rate: 0.75 },
    { lo: 70, hi: 80, meanCpr: 75, runs: 60, successes: 50, rate: 0.833 },
  ],
  roles: [], ...over,
})

describe('compareToObserved', () => {
  it('picks the bucket nearest the crew being published', () => {
    const r = compareToObserved({ observed: obs(), predicted: 0.76, crewCpr: 75 })
    expect(r.bucket.meanCpr).toBe(75)
    expect(r.observedRate).toBeCloseTo(0.833, 3)
  })

  it('⚠️ is absent, not agreeing, when there is no history', () => {
    // "No disagreement" and "nothing to compare" must not look the same — the
    // first says the model is corroborated, the second says nobody checked.
    const r = compareToObserved({ observed: obs({ enough: false, buckets: [] }), predicted: 0.8, crewCpr: 75 })
    expect(r.status).toBe('no-history')
    expect(r.disagrees).toBe(false)
    expect(r.observedRate).toBeNull()
  })

  it('flags a material gap between the model and the faction', () => {
    // Break the Bank at Forge: the model expects the bar to buy success the
    // history does not show.
    const r = compareToObserved({ observed: obs(), predicted: 0.95, crewCpr: 75 })
    expect(r.disagrees).toBe(true)
    expect(r.gap).toBeCloseTo(0.95 - 0.833, 3)
    expect(r.direction).toBe('model-optimistic')
  })

  it('reports the model reading LOW as its own direction', () => {
    const r = compareToObserved({ observed: obs(), predicted: 0.55, crewCpr: 75 })
    expect(r.disagrees).toBe(true)
    expect(r.direction).toBe('model-pessimistic')
  })

  it('does not flag a gap inside the tolerance', () => {
    const r = compareToObserved({ observed: obs(), predicted: 0.833 + DISAGREEMENT_POINTS / 2, crewCpr: 75 })
    expect(r.disagrees).toBe(false)
    expect(r.status).toBe('agrees')
  })

  it('⚠️ will not compare against a bucket too far from the published crew', () => {
    // Our history is at 62-80; a bar of 95 has never been run. Comparing it to
    // the 75 bucket would present an extrapolation as a measurement.
    const r = compareToObserved({ observed: obs(), predicted: 0.99, crewCpr: 95 })
    expect(r.status).toBe('out-of-range')
    expect(r.disagrees).toBe(false)
  })

  it('handles an absent prediction without inventing one', () => {
    const r = compareToObserved({ observed: obs(), predicted: null, crewCpr: 75 })
    expect(r.status).toBe('no-prediction')
    expect(r.disagrees).toBe(false)
  })
})
