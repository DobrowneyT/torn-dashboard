import { describe, it, expect } from 'vitest'
import { calculateTierProgress, getTierInfo } from '../tierProgressUtils.js'

describe('calculateTierProgress', () => {
  it('identifies when a member qualifies for the next tier', () => {
    // Member at Tier 3, has CPR that qualifies for Tier 2
    // Tier 2 requires 6 out of 8 (ceil(8 * 2/3) = 6):
    // Break the Bank: Muscle #1 ≥60, Robber ≥60
    // Clinical Precision: Assassin ≥67, Cat Burglar ≥67, Cleaner ≥67
    // Blast from the Past: Muscle ≥75, Engineer ≥75, Bomber ≥75
    const cprV2Data = [
      { crime_name: 'Break the Bank', difficulty: 8, position_label: 'Muscle #1', cpr_value: 80 },
      { crime_name: 'Break the Bank', difficulty: 8, position_label: 'Robber', cpr_value: 75 },
      { crime_name: 'Clinical Precision', difficulty: 8, position_label: 'Assassin', cpr_value: 70 },
      { crime_name: 'Clinical Precision', difficulty: 8, position_label: 'Cat Burglar', cpr_value: 70 },
      { crime_name: 'Clinical Precision', difficulty: 8, position_label: 'Cleaner', cpr_value: 70 },
      { crime_name: 'Clinical Precision', difficulty: 8, position_label: 'Imitator', cpr_value: 50 },
      { crime_name: 'Blast from the Past', difficulty: 7, position_label: 'Muscle', cpr_value: 80 },
      { crime_name: 'Blast from the Past', difficulty: 7, position_label: 'Engineer', cpr_value: 80 },
      { crime_name: 'Blast from the Past', difficulty: 7, position_label: 'Bomber', cpr_value: 80 },
    ]

    const result = calculateTierProgress(cprV2Data, 3)

    expect(result.currentTier).toBe(3)
    expect(result.nextTier).toBe(2)
    expect(result.nextTierProgress.qualified).toBe(true)
    expect(result.nextTierProgress.metCount).toBeGreaterThanOrEqual(6)
  })

  it('shows partial progress when requirements are not met', () => {
    // Member at Tier 4 with limited CPR data — below Tier 3 minimums
    const cprV2Data = [
      { crime_name: 'Blast from the Past', difficulty: 7, position_label: 'Hacker', cpr_value: 50 },
      { crime_name: 'Blast from the Past', difficulty: 7, position_label: 'Picklock #1', cpr_value: 40 },
      { crime_name: 'Bidding War', difficulty: 6, position_label: 'Bomber #2', cpr_value: 60 },
      { crime_name: 'Bidding War', difficulty: 6, position_label: 'Driver', cpr_value: 50 },
    ]

    const result = calculateTierProgress(cprV2Data, 4)

    expect(result.nextTier).toBe(3)
    expect(result.nextTierProgress.qualified).toBe(false)
    expect(result.nextTierProgress.metCount).toBeLessThan(result.nextTierProgress.requiredCount)
  })

  it('returns no next tier for Tier 1 (already highest)', () => {
    const cprV2Data = [
      { crime_name: 'Clinical Precision', difficulty: 8, position_label: 'Imitator', cpr_value: 95 },
      { crime_name: 'Break the Bank', difficulty: 8, position_label: 'Muscle #3', cpr_value: 90 },
      { crime_name: 'Break the Bank', difficulty: 8, position_label: 'Thief #2', cpr_value: 90 },
    ]
    const result = calculateTierProgress(cprV2Data, 1)

    expect(result.currentTier).toBe(1)
    expect(result.nextTier).toBe(null)
    expect(result.nextTierProgress).toBe(null)
  })

  it('handles average CPR requirements (Tier 5/6)', () => {
    // Tier 6 requires Level 4 Average ≥ 75
    // We need difficulty=4 rows so byLevel[4] gets populated
    const cprV2Data = [
      { crime_name: 'SomeCrime', difficulty: 4, position_label: 'Muscle', cpr_value: 80 },
      { crime_name: 'SomeCrime', difficulty: 4, position_label: 'Hacker', cpr_value: 70 },
      { crime_name: 'SomeCrime', difficulty: 4, position_label: 'Bomber', cpr_value: 80 },
    ]

    const result = calculateTierProgress(cprV2Data, 6)
    const tier6Progress = result.allTierProgress[6]

    // Average = (80 + 70 + 80) / 3 ≈ 76.67 → meets ≥ 75
    expect(tier6Progress.requirements[0].met).toBe(true)
    expect(tier6Progress.requirements[0].currentCpr).toBeCloseTo(76.67, 0)
    expect(tier6Progress.qualified).toBe(true)
  })

  it('handles empty CPR data gracefully', () => {
    const result = calculateTierProgress([], 6)

    expect(result.currentTier).toBe(6)
    expect(result.qualifiedTiers).toHaveLength(0)

    // All tiers should have 0 met count
    for (const [tier, progress] of Object.entries(result.allTierProgress)) {
      expect(progress.metCount).toBe(0)
    }
  })

  it('tracks CPR gap for unmet requirements', () => {
    // Tier 3 needs Blast from the Past Hacker ≥ 70
    const cprV2Data = [
      { crime_name: 'Blast from the Past', difficulty: 7, position_label: 'Hacker', cpr_value: 65 },
    ]

    const result = calculateTierProgress(cprV2Data, 4)
    const tier3 = result.allTierProgress[3]
    const hackerReq = tier3.requirements.find(r => r.role === 'Hacker')

    expect(hackerReq.met).toBe(false)
    expect(hackerReq.currentCpr).toBe(65)
    expect(hackerReq.gap).toBe(5) // Need 5 more CPR
  })

  it('returns null gap when no CPR data exists for a requirement', () => {
    const result = calculateTierProgress([], 6)
    const tier1 = result.allTierProgress[1]

    for (const req of tier1.requirements) {
      expect(req.currentCpr).toBe(null)
      expect(req.gap).toBe(null)
    }
  })
})

describe('getTierInfo', () => {
  it('returns correct name and tickets for each tier', () => {
    expect(getTierInfo(1)).toEqual({ name: 'Elite', tickets: 40, tier: 1 })
    expect(getTierInfo(2)).toEqual({ name: 'Advanced', tickets: 30, tier: 2 })
    expect(getTierInfo(3)).toEqual({ name: 'Intermediate', tickets: 15, tier: 3 })
    expect(getTierInfo(4)).toEqual({ name: 'Developing', tickets: 7, tier: 4 })
    expect(getTierInfo(5)).toEqual({ name: 'Beginner', tickets: 3, tier: 5 })
    expect(getTierInfo(6)).toEqual({ name: 'Default', tickets: 2, tier: 6 })
  })
})
