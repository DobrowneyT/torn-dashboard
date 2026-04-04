import { describe, it, expect } from 'vitest'
import {
  calculateCacheValue,
  calculateTermedWarPayouts,
  calculateRealWarPayouts,
  buildMemberAttackStats,
  generateWarBatchPayoutURL,
} from '../warPayoutCalculations.js'

// Note: attacks come from faction_attacks table (daily scrape, no war_id).
// Callers pre-filter by war timestamp window before passing to these functions.

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const CACHE_PRICES = {
  price_melee_cache:       1_000_000,
  price_armor_cache:       2_000_000,
  price_small_arms_cache:  500_000,
  price_medium_arms_cache: 1_500_000,
  price_heavy_arms_cache:  5_000_000,
}

const SAMPLE_REWARDS = [
  { id: 1119, name: 'Melee Cache',       quantity: 3 },
  { id: 1118, name: 'Armor Cache',       quantity: 2 },
  { id: 1120, name: 'Small Arms Cache',  quantity: 1 },
  { id: 1121, name: 'Medium Arms Cache', quantity: 4 },
  { id: 1122, name: 'Heavy Arms Cache',  quantity: 0 },
]
// Expected: 3*1M + 2*2M + 1*0.5M + 4*1.5M + 0*5M = 3M + 4M + 0.5M + 6M = 13.5M

const SAMPLE_CONTRIBUTIONS = [
  { member_id: 100, member_name: 'Alice', score: 500, attacks: 10 },
  { member_id: 200, member_name: 'Bob',   score: 300, attacks:  6 },
  { member_id: 300, member_name: 'Carol', score: 200, attacks:  4 },
]

const SAMPLE_ATTACKS = [
  // Alice: 4 successful, avg fair_fight 2.0
  { id: 1, attacker_id: 100, attacker_faction_id: 10739, result: 'Hospitalized', fair_fight: 2.0, respect_gain: 5 },
  { id: 2, attacker_id: 100, attacker_faction_id: 10739, result: 'Hospitalized', fair_fight: 2.0, respect_gain: 5 },
  { id: 3, attacker_id: 100, attacker_faction_id: 10739, result: 'Hospitalized', fair_fight: 2.0, respect_gain: 5 },
  { id: 4, attacker_id: 100, attacker_faction_id: 10739, result: 'Hospitalized', fair_fight: 2.0, respect_gain: 5 },
  // Bob: 2 successful, avg fair_fight 1.5
  { id: 5, attacker_id: 200, attacker_faction_id: 10739, result: 'Mugged',       fair_fight: 1.5, respect_gain: 3 },
  { id: 6, attacker_id: 200, attacker_faction_id: 10739, result: 'Mugged',       fair_fight: 1.5, respect_gain: 3 },
  // Carol: 1 successful
  { id: 7, attacker_id: 300, attacker_faction_id: 10739, result: 'Attacked',     fair_fight: 1.0, respect_gain: 2 },
  // Non-our-faction attack (should be ignored)
  { id: 8, attacker_id: 999, attacker_faction_id: 41929, result: 'Hospitalized', fair_fight: 3.0, respect_gain: 10 },
  // Lost attack (not successful)
  { id: 9,  attacker_id: 100, attacker_faction_id: 10739, result: 'Lost',         fair_fight: 1.0, respect_gain: 0 },
  // Assist attacks — should count at reduced rate
  { id: 10, attacker_id: 200, attacker_faction_id: 10739, result: 'Assist',       fair_fight: 2.0, respect_gain: 1 },
  { id: 11, attacker_id: 300, attacker_faction_id: 10739, result: 'Assist',       fair_fight: 2.0, respect_gain: 1 },
]


// ---------------------------------------------------------------------------
// calculateCacheValue
// ---------------------------------------------------------------------------

describe('calculateCacheValue', () => {
  it('calculates correct total from mixed cache types', () => {
    const { totalCacheValue } = calculateCacheValue(SAMPLE_REWARDS, CACHE_PRICES)
    expect(totalCacheValue).toBe(13_500_000)
  })

  it('produces correct per-item breakdown', () => {
    const { breakdown } = calculateCacheValue(SAMPLE_REWARDS, CACHE_PRICES)
    const melee = breakdown.find(b => b.name === 'Melee Cache')
    expect(melee.totalValue).toBe(3_000_000)
    expect(melee.quantity).toBe(3)
  })

  it('returns 0 for a cache type with quantity 0', () => {
    const { breakdown } = calculateCacheValue(SAMPLE_REWARDS, CACHE_PRICES)
    const heavy = breakdown.find(b => b.name === 'Heavy Arms Cache')
    expect(heavy).toBeDefined()
    expect(heavy.totalValue).toBe(0)
  })

  it('returns 0 for unknown cache name', () => {
    const rewards = [{ id: 999, name: 'Unknown Cache', quantity: 5 }]
    const { totalCacheValue, breakdown } = calculateCacheValue(rewards, CACHE_PRICES)
    expect(totalCacheValue).toBe(0)
    expect(breakdown).toHaveLength(0)
  })

  it('returns 0 when rewards is empty', () => {
    const { totalCacheValue } = calculateCacheValue([], CACHE_PRICES)
    expect(totalCacheValue).toBe(0)
  })

  it('returns 0 when rewards is null', () => {
    const { totalCacheValue } = calculateCacheValue(null, CACHE_PRICES)
    expect(totalCacheValue).toBe(0)
  })

  it('uses 0 when cache price is not set', () => {
    const { totalCacheValue } = calculateCacheValue(
      [{ id: 1119, name: 'Melee Cache', quantity: 5 }],
      {}  // no prices set
    )
    expect(totalCacheValue).toBe(0)
  })
})


// ---------------------------------------------------------------------------
// calculateTermedWarPayouts
// ---------------------------------------------------------------------------

describe('calculateTermedWarPayouts', () => {
  const baseSettings = {
    rewardsItems: SAMPLE_REWARDS,
    cachePrices: CACHE_PRICES,
    factionCutPercent: 20,
    minScoreThreshold: 100,
    flatPayoutAmount: 1_000_000,
  }

  it('marks members above threshold as eligible', () => {
    const { members } = calculateTermedWarPayouts(SAMPLE_CONTRIBUTIONS, baseSettings)
    // All 3 members have score >= 100
    expect(members.every(m => m.isEligible)).toBe(true)
    expect(members.every(m => m.payoutAmount === 1_000_000)).toBe(true)
  })

  it('marks members below threshold as ineligible with 0 payout', () => {
    const settings = { ...baseSettings, minScoreThreshold: 400 }
    const { members } = calculateTermedWarPayouts(SAMPLE_CONTRIBUTIONS, settings)
    const alice = members.find(m => m.memberId === 100)
    const bob   = members.find(m => m.memberId === 200)
    const carol = members.find(m => m.memberId === 300)
    expect(alice.isEligible).toBe(true)
    expect(bob.isEligible).toBe(false)
    expect(carol.isEligible).toBe(false)
    expect(bob.payoutAmount).toBe(0)
  })

  it('exactly at threshold is eligible', () => {
    const settings = { ...baseSettings, minScoreThreshold: 300 }
    const { members } = calculateTermedWarPayouts(SAMPLE_CONTRIBUTIONS, settings)
    const bob = members.find(m => m.memberId === 200)
    expect(bob.isEligible).toBe(true)
  })

  it('none eligible when threshold is very high', () => {
    const settings = { ...baseSettings, minScoreThreshold: 9999 }
    const { members, totalPayout } = calculateTermedWarPayouts(SAMPLE_CONTRIBUTIONS, settings)
    expect(members.every(m => !m.isEligible)).toBe(true)
    expect(totalPayout).toBe(0)
  })

  it('flags overBudgetWarning when total payout exceeds pool', () => {
    // Pool = 13.5M * 0.8 = 10.8M; 3 members * 5M each = 15M > 10.8M
    const settings = { ...baseSettings, flatPayoutAmount: 5_000_000 }
    const { overBudgetWarning, memberPayoutPool } = calculateTermedWarPayouts(SAMPLE_CONTRIBUTIONS, settings)
    expect(overBudgetWarning).toBe(true)
    expect(memberPayoutPool).toBe(10_800_000)
  })

  it('no overBudgetWarning when payout fits in pool', () => {
    const { overBudgetWarning } = calculateTermedWarPayouts(SAMPLE_CONTRIBUTIONS, baseSettings)
    // 3 * 1M = 3M < 10.8M
    expect(overBudgetWarning).toBe(false)
  })

  it('applies faction cut correctly', () => {
    const { memberPayoutPool, cacheValue } = calculateTermedWarPayouts(SAMPLE_CONTRIBUTIONS, baseSettings)
    expect(cacheValue).toBe(13_500_000)
    expect(memberPayoutPool).toBe(10_800_000) // 13.5M * 0.8
  })
})


// ---------------------------------------------------------------------------
// buildMemberAttackStats
// ---------------------------------------------------------------------------

describe('buildMemberAttackStats', () => {
  it('only counts our faction attacks', () => {
    const stats = buildMemberAttackStats(SAMPLE_ATTACKS)
    expect(stats.has(999)).toBe(false)  // opponent attacker ignored
  })

  it('counts successful attacks correctly', () => {
    const stats = buildMemberAttackStats(SAMPLE_ATTACKS)
    expect(stats.get(100).successfulAttacks).toBe(4)
    expect(stats.get(200).successfulAttacks).toBe(2)
    expect(stats.get(300).successfulAttacks).toBe(1)
  })

  it('does not count Lost as successful', () => {
    const stats = buildMemberAttackStats(SAMPLE_ATTACKS)
    // Alice: 4 Hospitalized + 1 Lost = 4 successful, 5 total
    expect(stats.get(100).successfulAttacks).toBe(4)
    expect(stats.get(100).totalAttacks).toBe(5)
  })

  it('counts assists separately from successful attacks', () => {
    const stats = buildMemberAttackStats(SAMPLE_ATTACKS)
    expect(stats.get(200).assistAttacks).toBe(1)  // Bob has 1 Assist
    expect(stats.get(300).assistAttacks).toBe(1)  // Carol has 1 Assist
    expect(stats.get(100).assistAttacks).toBe(0)  // Alice has no assists
  })

  it('applies assistMultiplier to weightedSuccessful', () => {
    const stats = buildMemberAttackStats(SAMPLE_ATTACKS, 0.25)
    // Bob: 2 successful + 1 assist * 0.25 = 2.25
    expect(stats.get(200).weightedSuccessful).toBeCloseTo(2.25)
    // Carol: 1 successful + 1 assist * 0.25 = 1.25
    expect(stats.get(300).weightedSuccessful).toBeCloseTo(1.25)
    // Alice: 4 successful + 0 assists = 4.0
    expect(stats.get(100).weightedSuccessful).toBeCloseTo(4.0)
  })

  it('weightedSuccessful equals successfulAttacks when no assists', () => {
    const stats = buildMemberAttackStats(SAMPLE_ATTACKS, 0.25)
    expect(stats.get(100).weightedSuccessful).toBe(stats.get(100).successfulAttacks)
  })

  it('zero assistMultiplier makes assists count nothing', () => {
    const stats = buildMemberAttackStats(SAMPLE_ATTACKS, 0)
    expect(stats.get(200).weightedSuccessful).toBe(2)  // only successful attacks
  })

  it('full assistMultiplier (1.0) makes assists count as full attacks', () => {
    const stats = buildMemberAttackStats(SAMPLE_ATTACKS, 1.0)
    expect(stats.get(200).weightedSuccessful).toBe(3)  // 2 + 1
  })

  it('computes avg fair fight weighted by assist multiplier', () => {
    const stats = buildMemberAttackStats(SAMPLE_ATTACKS, 0.25)
    // Alice: 4 successful at FF=2.0 → avg = 2.0
    expect(stats.get(100).avgFairFight).toBeCloseTo(2.0)
    // Bob: 2 successful at FF=1.5 + 1 assist at FF=2.0*0.25 weight
    //   fairFightSum = 1.5+1.5 + 2.0*0.25 = 3.0 + 0.5 = 3.5
    //   weightedCount = 2 + 0.25 = 2.25
    //   avg = 3.5 / 2.25 ≈ 1.556
    expect(stats.get(200).avgFairFight).toBeCloseTo(3.5 / 2.25)
  })

  it('returns empty map for empty attacks array', () => {
    const stats = buildMemberAttackStats([])
    expect(stats.size).toBe(0)
  })
})


// ---------------------------------------------------------------------------
// calculateRealWarPayouts
// ---------------------------------------------------------------------------

describe('calculateRealWarPayouts', () => {
  const baseSettings = {
    rewardsItems: SAMPLE_REWARDS,
    cachePrices: CACHE_PRICES,
    factionCutPercent: 20,
    scoreMultiplier: 1.0,
    attacksWeight: 0.5,
    effortWeight: 0.5,
    assistMultiplier: 0.25,
    minPayoutThreshold: 0,
  }

  it('payouts sum to approximately the member payout pool', () => {
    const { members, memberPayoutPool } = calculateRealWarPayouts(
      SAMPLE_CONTRIBUTIONS, SAMPLE_ATTACKS, baseSettings
    )
    const totalPaid = members.reduce((s, m) => s + m.payoutAmount, 0)
    // Due to floor() rounding, total may be slightly less than pool
    expect(totalPaid).toBeLessThanOrEqual(memberPayoutPool)
    expect(totalPaid).toBeGreaterThan(memberPayoutPool * 0.99)
  })

  it('share percents sum to 1.0', () => {
    const { members } = calculateRealWarPayouts(
      SAMPLE_CONTRIBUTIONS, SAMPLE_ATTACKS, baseSettings
    )
    const totalShare = members.reduce((s, m) => s + m.sharePercent, 0)
    expect(totalShare).toBeCloseTo(1.0, 5)
  })

  it('member with zero score and zero attacks still gets a result (0 payout)', () => {
    const contributions = [
      ...SAMPLE_CONTRIBUTIONS,
      { member_id: 999, member_name: 'Zero', score: 0, attacks: 0 }
    ]
    const { members } = calculateRealWarPayouts(contributions, SAMPLE_ATTACKS, baseSettings)
    const zero = members.find(m => m.memberId === 999)
    expect(zero).toBeDefined()
    expect(zero.payoutAmount).toBe(0)
  })

  it('single member receives full pool', () => {
    const contributions = [{ member_id: 100, member_name: 'Solo', score: 1000, attacks: 10 }]
    const { members, memberPayoutPool } = calculateRealWarPayouts(
      contributions, SAMPLE_ATTACKS, baseSettings
    )
    expect(members[0].payoutAmount).toBeLessThanOrEqual(memberPayoutPool)
    expect(members[0].payoutAmount).toBeGreaterThan(memberPayoutPool * 0.99)
  })

  it('minPayoutThreshold filters out low payouts', () => {
    // With a very high threshold, most members should get 0
    const settings = { ...baseSettings, minPayoutThreshold: 999_999_999 }
    const { members } = calculateRealWarPayouts(SAMPLE_CONTRIBUTIONS, SAMPLE_ATTACKS, settings)
    expect(members.every(m => m.payoutAmount === 0)).toBe(true)
    expect(members.every(m => !m.isEligible)).toBe(true)
  })

  it('applies faction cut correctly to pool', () => {
    const { cacheValue, memberPayoutPool } = calculateRealWarPayouts(
      SAMPLE_CONTRIBUTIONS, SAMPLE_ATTACKS, baseSettings
    )
    expect(cacheValue).toBe(13_500_000)
    expect(memberPayoutPool).toBe(10_800_000)
  })

  it('higher score member earns more than lower score member (all else equal)', () => {
    // Alice (score=500) should earn more than Carol (score=200)
    const { members } = calculateRealWarPayouts(
      SAMPLE_CONTRIBUTIONS, SAMPLE_ATTACKS, baseSettings
    )
    const alice = members.find(m => m.memberId === 100)
    const carol = members.find(m => m.memberId === 300)
    expect(alice.payoutAmount).toBeGreaterThan(carol.payoutAmount)
  })
})


// ---------------------------------------------------------------------------
// generateWarBatchPayoutURL
// ---------------------------------------------------------------------------

describe('generateWarBatchPayoutURL', () => {
  const eligibleMembers = [
    { memberId: 100, memberName: 'Alice', isEligible: true,  payoutAmount: 500_000 },
    { memberId: 200, memberName: 'Bob',   isEligible: true,  payoutAmount: 300_000 },
    { memberId: 300, memberName: 'Carol', isEligible: false, payoutAmount: 200_000 },
    { memberId: 400, memberName: 'Dave',  isEligible: true,  payoutAmount: 0 },
  ]

  it('generates correct Torn URL format', () => {
    const url = generateWarBatchPayoutURL(eligibleMembers)
    expect(url).toContain('https://www.torn.com/factions.php?step=your')
    expect(url).toContain('#/tab=controls')
    expect(url).toContain('batbal_uids=')
    expect(url).toContain('batbal_amounts=')
  })

  it('excludes ineligible members', () => {
    const url = generateWarBatchPayoutURL(eligibleMembers)
    // Carol (id=300) is ineligible — check UIDs param specifically.
    // Cannot use toContain('300') on full URL: Bob's payout 300000 also contains '300'.
    const uidsParam = url.match(/batbal_uids=([^&]+)/)?.[1] ?? ''
    const uids = uidsParam.split(',').map(Number)
    expect(uids).not.toContain(300)
  })

  it('excludes zero-payout members', () => {
    const url = generateWarBatchPayoutURL(eligibleMembers)
    expect(url).not.toContain('400')  // Dave has 0 payout
  })

  it('includes eligible members with payout > 0', () => {
    const url = generateWarBatchPayoutURL(eligibleMembers)
    expect(url).toContain('100')
    expect(url).toContain('200')
    expect(url).toContain('500000')
    expect(url).toContain('300000')
  })

  it('returns empty string when no eligible members', () => {
    const noEligible = eligibleMembers.map(m => ({ ...m, isEligible: false }))
    expect(generateWarBatchPayoutURL(noEligible)).toBe('')
  })

  it('returns empty string for empty array', () => {
    expect(generateWarBatchPayoutURL([])).toBe('')
  })

  it('floors payout amounts', () => {
    const members = [{ memberId: 1, memberName: 'A', isEligible: true, payoutAmount: 999.99 }]
    const url = generateWarBatchPayoutURL(members)
    expect(url).toContain('batbal_amounts=999')
    expect(url).not.toContain('999.99')
  })
})
