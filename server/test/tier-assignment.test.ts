// Tier assignment (slice #69) — pure-logic port of scripts/assign_tiers.py:
// proportion-based (2/3) top-down evaluation with KNN fallback. Worked
// examples hand-derived from the Python spec; requirements are injected
// (production reads them from faction_settings.tier_requirements).
import { describe, expect, it } from 'vitest'
import { assignTiers, type TierRequirements } from '../src/scraper/tierAssignment.js'

// Reduced requirement set for worked examples:
//   Tier 1: three role checks at 80 → need ceil(3 * 2/3) = 2
//   Tier 2: average CPR across difficulty-5 crimes ≥ 60 → need 1
const REQUIREMENTS: TierRequirements = {
  1: [
    { crime: 'Heist', role: 'R1', minCpr: 80 },
    { crime: 'Heist', role: 'R2', minCpr: 80 },
    { crime: 'Grab', role: 'R1', minCpr: 80 },
  ],
  2: [{ level: 5, role: 'Average', minCpr: 60, isAverage: true }],
}

const CRIME_TYPES = {
  Heist: { difficulty: 7 },
  Grab: { difficulty: 5 },
  Sweep: { difficulty: 5 },
}

const cpr = (v: number) => ({ cpr_value: v })

describe('assignTiers', () => {
  it('assigns the first tier whose threshold is met on full data (2/3 rule)', () => {
    const result = assignTiers(
      { X: { Heist: { R1: cpr(85), R2: cpr(85) }, Grab: { R1: cpr(10) } } },
      CRIME_TYPES, REQUIREMENTS
    )
    // 3/3 data points, 2 of 3 met ≥ needed 2 → Tier 1.
    expect(result.X.tier).toBe(1)
    expect(result.X.assignment_method).toBe('pass1_requirements')
  })

  it('falls through to an average-based tier when role checks fail', () => {
    const result = assignTiers(
      { Y: { Heist: { R1: cpr(50), R2: cpr(50) }, Grab: { R1: cpr(50) }, Sweep: { R1: cpr(70) } } },
      CRIME_TYPES, REQUIREMENTS
    )
    // Tier 1: full data, 0 met. Tier 2: avg over difficulty-5 crimes
    // (Grab 50, Sweep 70) = 60 ≥ 60 → Tier 2.
    expect(result.Y.tier).toBe(2)
  })

  it('gives tier 0 (manual review) to members with no CPR data at all', () => {
    const result = assignTiers({ Z: {} }, CRIME_TYPES, REQUIREMENTS)
    expect(result.Z.tier).toBe(0)
    expect(result.Z.assignment_method).toContain('NO_DATA')
  })

  it('defaults to tier 6 when full data qualifies for nothing', () => {
    const result = assignTiers(
      { L: { Heist: { R1: cpr(10), R2: cpr(10) }, Grab: { R1: cpr(10) }, Sweep: { R1: cpr(10) } } },
      CRIME_TYPES, REQUIREMENTS
    )
    // Tier 1 full data misses; Tier 2 avg = 10 < 60 → default Tier 6.
    expect(result.L.tier).toBe(6)
    expect(result.L.assignment_method).toBe('pass1_default_tier6')
  })

  it('predicts partial-data members by KNN over pass-1 neighbors', () => {
    // Five pass-1 members near CPR 84 on Heist.R1 land Tier 1; one far
    // neighbor lands Tier 2 via the average. W has ONLY Heist.R1 = 84
    // (partial data at tier 1) → 5 nearest neighbors vote Tier 1.
    const members: Record<string, any> = {
      W: { Heist: { R1: cpr(84) } },
    }
    for (let i = 0; i < 5; i++) {
      members[`N${i}`] = {
        Heist: { R1: cpr(82 + i), R2: cpr(90) },
        Grab: { R1: cpr(90) },
      }
    }
    // Tier 1 fails (0 met); difficulty-5 avg = (60 + 65) / 2 = 62.5 ≥ 60 → Tier 2.
    members.FAR = {
      Heist: { R1: cpr(5), R2: cpr(5) },
      Grab: { R1: cpr(60) },
      Sweep: { R1: cpr(65) },
    }
    const result = assignTiers(members, CRIME_TYPES, REQUIREMENTS)
    expect(result.N0.tier).toBe(1)
    expect(result.FAR.tier).toBe(2)
    expect(result.W.tier).toBe(1)
    expect(result.W.assignment_method).toBe('knn_prediction')
  })

  it('tier 6 when KNN has too few neighbors to vote', () => {
    const result = assignTiers(
      {
        W: { Heist: { R1: cpr(84) } },
        OnlyOne: { Heist: { R1: cpr(80), R2: cpr(90) }, Grab: { R1: cpr(90) } },
      },
      CRIME_TYPES, REQUIREMENTS
    )
    // Only one pass-1 neighbor has Heist.R1 — fewer than k=5 → no vote.
    expect(result.W.tier).toBe(6)
    expect(result.W.assignment_method).toBe('knn_failed_default_tier6')
  })
})
