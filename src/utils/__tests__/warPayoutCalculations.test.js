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

// All attacks are outgoing (is_incoming: false) ranked-war attacks.
// Alice: 4 hosp war hits + 1 loss
// Bob:   2 mug war hits + 1 assist
// Carol: 1 leaf (Attacked) war hit + 1 assist
// Member 999: different faction — should be ignored
const SAMPLE_ATTACKS = [
  // Alice — 4 ranked-war hosp hits
  { id: 1, attacker_id: 100, attacker_faction_id: 10739, result: 'Hospitalized', fair_fight: 2.0, respect_gain: 5, is_ranked_war: true,  is_incoming: false, chain: 1 },
  { id: 2, attacker_id: 100, attacker_faction_id: 10739, result: 'Hospitalized', fair_fight: 2.0, respect_gain: 5, is_ranked_war: true,  is_incoming: false, chain: 2 },
  { id: 3, attacker_id: 100, attacker_faction_id: 10739, result: 'Hospitalized', fair_fight: 2.0, respect_gain: 5, is_ranked_war: true,  is_incoming: false, chain: 3 },
  { id: 4, attacker_id: 100, attacker_faction_id: 10739, result: 'Hospitalized', fair_fight: 2.0, respect_gain: 5, is_ranked_war: true,  is_incoming: false, chain: 4 },
  // Bob — 2 ranked-war mugs + 1 assist
  { id: 5, attacker_id: 200, attacker_faction_id: 10739, result: 'Mugged',       fair_fight: 1.5, respect_gain: 3, is_ranked_war: true,  is_incoming: false, chain: 1 },
  { id: 6, attacker_id: 200, attacker_faction_id: 10739, result: 'Mugged',       fair_fight: 1.5, respect_gain: 3, is_ranked_war: true,  is_incoming: false, chain: 2 },
  // Carol — 1 ranked-war attack + 1 assist
  { id: 7, attacker_id: 300, attacker_faction_id: 10739, result: 'Attacked',     fair_fight: 1.0, respect_gain: 2, is_ranked_war: true,  is_incoming: false, chain: 1 },
  // Non-our-faction attack (should be ignored)
  { id: 8, attacker_id: 999, attacker_faction_id: 41929, result: 'Hospitalized', fair_fight: 3.0, respect_gain: 10, is_ranked_war: true, is_incoming: false, chain: 1 },
  // Alice — 1 loss
  { id: 9, attacker_id: 100, attacker_faction_id: 10739, result: 'Lost',         fair_fight: 1.0, respect_gain: 0, is_ranked_war: false, is_incoming: false, chain: 0 },
  // Bob + Carol — assists
  { id: 10, attacker_id: 200, attacker_faction_id: 10739, result: 'Assist',      fair_fight: 2.0, respect_gain: 1, is_ranked_war: true,  is_incoming: false, chain: 1 },
  { id: 11, attacker_id: 300, attacker_faction_id: 10739, result: 'Assist',      fair_fight: 2.0, respect_gain: 1, is_ranked_war: true,  is_incoming: false, chain: 1 },
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

  it('counts won attacks correctly', () => {
    const stats = buildMemberAttackStats(SAMPLE_ATTACKS)
    // Alice: 4 Hospitalized wins; Bob: 2 Mugged wins; Carol: 1 Attacked win
    expect(stats.get(100).won).toBe(4)
    expect(stats.get(200).won).toBe(2)
    expect(stats.get(300).won).toBe(1)
  })

  it('does not count Lost as a win', () => {
    const stats = buildMemberAttackStats(SAMPLE_ATTACKS)
    // Alice: 4 wins + 1 loss
    expect(stats.get(100).won).toBe(4)
    expect(stats.get(100).losses).toBe(1)
  })

  it('counts assists separately', () => {
    const stats = buildMemberAttackStats(SAMPLE_ATTACKS)
    expect(stats.get(100).assists).toBe(0)
    expect(stats.get(200).assists).toBe(1)
    expect(stats.get(300).assists).toBe(1)
  })

  it('counts ranked-war hits (warHits)', () => {
    const stats = buildMemberAttackStats(SAMPLE_ATTACKS)
    // Alice: 4 ranked-war hosp hits; Bob: 2 ranked-war mugs; Carol: 1 ranked-war attack
    expect(stats.get(100).warHits).toBe(4)
    expect(stats.get(200).warHits).toBe(2)
    expect(stats.get(300).warHits).toBe(1)
  })

  it('counts mugs separately from other wins', () => {
    const stats = buildMemberAttackStats(SAMPLE_ATTACKS)
    expect(stats.get(200).mugs).toBe(2)
    expect(stats.get(100).mugs).toBe(0)
    expect(stats.get(300).mugs).toBe(0)
  })

  it('counts hosp and leaves separately', () => {
    const stats = buildMemberAttackStats(SAMPLE_ATTACKS)
    expect(stats.get(100).hosp).toBe(4)
    expect(stats.get(100).leaves).toBe(0)
    expect(stats.get(300).leaves).toBe(1)
    expect(stats.get(300).hosp).toBe(0)
  })

  it('counts totalHits as won + assists + losses', () => {
    const stats = buildMemberAttackStats(SAMPLE_ATTACKS)
    // Alice: 4 won + 0 assists + 1 loss = 5
    const a = stats.get(100)
    expect(a.won + a.assists + a.losses).toBe(5)
    // Bob: 2 won + 1 assist + 0 losses = 3
    const b = stats.get(200)
    expect(b.won + b.assists + b.losses).toBe(3)
  })

  it('does not count Timeout and Interrupted as wins', () => {
    const extra = [
      { id: 20, attacker_id: 100, attacker_faction_id: 10739, result: 'Timeout',     is_incoming: false, is_ranked_war: false, chain: 0, respect_gain: 0 },
      { id: 21, attacker_id: 100, attacker_faction_id: 10739, result: 'Interrupted', is_incoming: false, is_ranked_war: false, chain: 0, respect_gain: 0 },
    ]
    const stats = buildMemberAttackStats(extra)
    expect(stats.get(100).won).toBe(0)
    expect(stats.get(100).losses).toBe(2)
  })

  it('ignores incoming attacks', () => {
    const incoming = [
      { id: 30, attacker_id: 100, attacker_faction_id: 10739, result: 'Hospitalized', is_incoming: true, is_ranked_war: true, chain: 1, respect_gain: 5 },
    ]
    const stats = buildMemberAttackStats(incoming)
    expect(stats.size).toBe(0)
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
    warHitMultiplier:    1.25,
    assistMultiplier:    0.50,
    lossMultiplier:      0.50,
    mugMultiplier:      -1.00,
    participationWeight: 0.50,
    contributionWeight:  0.50,
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

  it('effort shares sum to 1.0', () => {
    const { members } = calculateRealWarPayouts(
      SAMPLE_CONTRIBUTIONS, SAMPLE_ATTACKS, baseSettings
    )
    const totalEffort = members.reduce((s, m) => s + m.effortShare, 0)
    expect(totalEffort).toBeCloseTo(1.0, 5)
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

  it('mug penalty reduces participation share', () => {
    // Bob has 2 mugs (×−1) which reduces his participation score vs Carol who has 1 war hit + 1 assist
    const { members } = calculateRealWarPayouts(
      SAMPLE_CONTRIBUTIONS, SAMPLE_ATTACKS, baseSettings
    )
    const bob   = members.find(m => m.memberId === 200)
    const carol = members.find(m => m.memberId === 300)
    // Bob: participationScore = 2*1.25 + 2*-1 + 1*0.5 = 2.5 - 2 + 0.5 = 1.0
    // Carol: participationScore = 1*1.25 + 1*0.5 = 1.75
    expect(carol.participationScore).toBeGreaterThan(bob.participationScore)
  })

  it('participationWeight and contributionWeight shift payout distribution', () => {
    // Pure contribution weighting (100% contribution)
    const contribOnly = { ...baseSettings, participationWeight: 0, contributionWeight: 1 }
    const { members: cm } = calculateRealWarPayouts(SAMPLE_CONTRIBUTIONS, SAMPLE_ATTACKS, contribOnly)
    // Alice (score=500) should have the largest contribution share
    const sorted = cm.slice().sort((a, b) => b.payoutAmount - a.payoutAmount)
    expect(sorted[0].memberId).toBe(100) // Alice has highest score
  })

  it('overBudgetWarning is always false (formula distributes exactly the pool)', () => {
    const { overBudgetWarning } = calculateRealWarPayouts(
      SAMPLE_CONTRIBUTIONS, SAMPLE_ATTACKS, baseSettings
    )
    expect(overBudgetWarning).toBe(false)
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
