import { describe, it, expect } from 'vitest'
import {
  calculateCacheValue,
  calculateTermedWarPayouts,
  calculateRealWarPayouts,
  buildMemberAttackStats,
  countPostCutoffHits,
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

// Attacks with timestamps for scaling mode tests
const WAR_START = 1000000
const CUTOFF = WAR_START + 24 * 3600  // 24h after start

const TIMED_ATTACKS = [
  // Alice: 2 ranked-war wins BEFORE cutoff
  { id: 20, attacker_id: 100, attacker_faction_id: 10739, result: 'Hospitalized', is_ranked_war: true, is_incoming: false, started: WAR_START + 3600 },
  { id: 21, attacker_id: 100, attacker_faction_id: 10739, result: 'Attacked',     is_ranked_war: true, is_incoming: false, started: WAR_START + 7200 },
  // Alice: 3 ranked-war wins AFTER cutoff
  { id: 22, attacker_id: 100, attacker_faction_id: 10739, result: 'Hospitalized', is_ranked_war: true, is_incoming: false, started: CUTOFF + 100 },
  { id: 23, attacker_id: 100, attacker_faction_id: 10739, result: 'Attacked',     is_ranked_war: true, is_incoming: false, started: CUTOFF + 200 },
  { id: 24, attacker_id: 100, attacker_faction_id: 10739, result: 'Attacked',     is_ranked_war: true, is_incoming: false, started: CUTOFF + 300 },
  // Bob: 1 ranked-war win AFTER cutoff
  { id: 25, attacker_id: 200, attacker_faction_id: 10739, result: 'Hospitalized', is_ranked_war: true, is_incoming: false, started: CUTOFF + 150 },
  // Carol: 0 post-cutoff hits (1 assist after cutoff — should not count)
  { id: 26, attacker_id: 300, attacker_faction_id: 10739, result: 'Assist',       is_ranked_war: true, is_incoming: false, started: CUTOFF + 250 },
  // Carol: 1 loss after cutoff — should not count
  { id: 27, attacker_id: 300, attacker_faction_id: 10739, result: 'Lost',         is_ranked_war: true, is_incoming: false, started: CUTOFF + 350 },
  // Incoming attack after cutoff — should be ignored
  { id: 28, attacker_id: 100, attacker_faction_id: 10739, result: 'Hospitalized', is_ranked_war: true, is_incoming: true,  started: CUTOFF + 400 },
  // Non-ranked win after cutoff — should be ignored
  { id: 29, attacker_id: 200, attacker_faction_id: 10739, result: 'Attacked',     is_ranked_war: false, is_incoming: false, started: CUTOFF + 500 },
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
// calculateTermedWarPayouts — flat shares mode
// ---------------------------------------------------------------------------

describe('calculateTermedWarPayouts — flat shares', () => {
  // 13.5M total, 20% cut → pool = 10.8M
  const baseSettings = {
    totalReward: 13_500_000,
    factionCutPercent: 20,
    minScoreThreshold: 100,
    termedMode: 'flat',
  }

  it('splits pool equally when all members have 1 share', () => {
    const { members, memberPayoutPool, totalShares } = calculateTermedWarPayouts(SAMPLE_CONTRIBUTIONS, baseSettings)
    expect(memberPayoutPool).toBe(10_800_000)
    expect(totalShares).toBe(3)
    // floor(10.8M / 3) = 3,600,000
    expect(members.every(m => m.isEligible)).toBe(true)
    expect(members.every(m => m.payoutAmount === 3_600_000)).toBe(true)
  })

  it('member with 2 shares gets double', () => {
    const settings = { ...baseSettings, memberShares: { 100: 2 } }
    const { members, totalShares } = calculateTermedWarPayouts(SAMPLE_CONTRIBUTIONS, settings)
    expect(totalShares).toBe(4) // Alice=2, Bob=1, Carol=1
    const alice = members.find(m => m.memberId === 100)
    const bob   = members.find(m => m.memberId === 200)
    expect(alice.payoutAmount).toBe(Math.floor(2 / 4 * 10_800_000)) // 5,400,000
    expect(bob.payoutAmount).toBe(Math.floor(1 / 4 * 10_800_000))   // 2,700,000
  })

  it('marks members below threshold as ineligible with 0 shares and 0 payout', () => {
    const settings = { ...baseSettings, minScoreThreshold: 400 }
    const { members, totalShares } = calculateTermedWarPayouts(SAMPLE_CONTRIBUTIONS, settings)
    const alice = members.find(m => m.memberId === 100)
    const bob   = members.find(m => m.memberId === 200)
    expect(alice.isEligible).toBe(true)
    expect(bob.isEligible).toBe(false)
    expect(bob.shares).toBe(0)
    expect(bob.payoutAmount).toBe(0)
    expect(totalShares).toBe(1)
    // Alice gets full pool
    expect(alice.payoutAmount).toBe(10_800_000)
  })

  it('exactly at threshold is eligible', () => {
    const settings = { ...baseSettings, minScoreThreshold: 300 }
    const { members } = calculateTermedWarPayouts(SAMPLE_CONTRIBUTIONS, settings)
    const bob = members.find(m => m.memberId === 200)
    expect(bob.isEligible).toBe(true)
  })

  it('none eligible when threshold is very high', () => {
    const settings = { ...baseSettings, minScoreThreshold: 9999 }
    const { members, totalPayout, totalShares } = calculateTermedWarPayouts(SAMPLE_CONTRIBUTIONS, settings)
    expect(members.every(m => !m.isEligible)).toBe(true)
    expect(totalShares).toBe(0)
    expect(totalPayout).toBe(0)
  })

  it('overBudgetWarning is always false', () => {
    const { overBudgetWarning } = calculateTermedWarPayouts(SAMPLE_CONTRIBUTIONS, baseSettings)
    expect(overBudgetWarning).toBe(false)
  })

  it('applies faction cut correctly', () => {
    const { memberPayoutPool, cacheValue } = calculateTermedWarPayouts(SAMPLE_CONTRIBUTIONS, baseSettings)
    expect(cacheValue).toBe(13_500_000)
    expect(memberPayoutPool).toBe(10_800_000) // 13.5M * 0.8
  })
})


// ---------------------------------------------------------------------------
// calculateTermedWarPayouts — scaling mode
// ---------------------------------------------------------------------------

describe('calculateTermedWarPayouts — scaling mode', () => {
  // 10M total, 20% cut → pool = 8M
  // 50% base / 50% bonus → basePool = 4M, bonusPool = 4M
  const baseSettings = {
    totalReward: 10_000_000,
    factionCutPercent: 20,
    minScoreThreshold: 100,
    termedMode: 'scaling',
    attacks: TIMED_ATTACKS,
    warStartAt: WAR_START,
    cutoffHours: 24,
    basePoolPercent: 50,
  }

  it('base pay splits equally among eligible members', () => {
    const { members, basePool } = calculateTermedWarPayouts(SAMPLE_CONTRIBUTIONS, baseSettings)
    expect(basePool).toBe(4_000_000)
    // 3 eligible, floor(4M / 3) = 1,333,333
    const basePay = Math.floor(4_000_000 / 3)
    expect(members.filter(m => m.isEligible).every(m => m.basePay === basePay)).toBe(true)
  })

  it('bonus pay distributed proportionally by post-cutoff hits', () => {
    const { members, bonusPool, totalPostCutoffHits } = calculateTermedWarPayouts(SAMPLE_CONTRIBUTIONS, baseSettings)
    expect(bonusPool).toBe(4_000_000)
    // Alice: 3 post-cutoff hits, Bob: 1, Carol: 0 → total 4
    expect(totalPostCutoffHits).toBe(4)

    const alice = members.find(m => m.memberId === 100)
    const bob   = members.find(m => m.memberId === 200)
    const carol = members.find(m => m.memberId === 300)

    expect(alice.postCutoffHits).toBe(3)
    expect(bob.postCutoffHits).toBe(1)
    expect(carol.postCutoffHits).toBe(0)

    expect(alice.bonusPay).toBe(Math.floor(4_000_000 * 3 / 4)) // 3,000,000
    expect(bob.bonusPay).toBe(Math.floor(4_000_000 * 1 / 4))   // 1,000,000
    expect(carol.bonusPay).toBe(0)
  })

  it('member with no post-cutoff hits gets only base pay', () => {
    const { members } = calculateTermedWarPayouts(SAMPLE_CONTRIBUTIONS, baseSettings)
    const carol = members.find(m => m.memberId === 300)
    expect(carol.basePay).toBe(Math.floor(4_000_000 / 3))
    expect(carol.bonusPay).toBe(0)
    expect(carol.payoutAmount).toBe(carol.basePay)
  })

  it('ineligible members get nothing', () => {
    const settings = { ...baseSettings, minScoreThreshold: 400 }
    const { members } = calculateTermedWarPayouts(SAMPLE_CONTRIBUTIONS, settings)
    const bob = members.find(m => m.memberId === 200)
    expect(bob.isEligible).toBe(false)
    expect(bob.basePay).toBe(0)
    expect(bob.bonusPay).toBe(0)
    expect(bob.payoutAmount).toBe(0)
  })

  it('100% base pool means everyone gets equal pay', () => {
    const settings = { ...baseSettings, basePoolPercent: 100 }
    const { members, basePool, bonusPool } = calculateTermedWarPayouts(SAMPLE_CONTRIBUTIONS, settings)
    expect(basePool).toBe(8_000_000)
    expect(bonusPool).toBe(0)
    const basePay = Math.floor(8_000_000 / 3)
    expect(members.filter(m => m.isEligible).every(m => m.payoutAmount === basePay)).toBe(true)
  })

  it('0% base pool means pure proportional by post-cutoff hits', () => {
    const settings = { ...baseSettings, basePoolPercent: 0 }
    const { members, basePool, bonusPool } = calculateTermedWarPayouts(SAMPLE_CONTRIBUTIONS, settings)
    expect(basePool).toBe(0)
    expect(bonusPool).toBe(8_000_000)
    // Carol has 0 post-cutoff hits → 0 payout
    const carol = members.find(m => m.memberId === 300)
    expect(carol.payoutAmount).toBe(0)
    // Alice: 3/4 * 8M = 6M, Bob: 1/4 * 8M = 2M
    const alice = members.find(m => m.memberId === 100)
    expect(alice.payoutAmount).toBe(Math.floor(8_000_000 * 3 / 4))
  })
})


// ---------------------------------------------------------------------------
// countPostCutoffHits
// ---------------------------------------------------------------------------

describe('countPostCutoffHits', () => {
  it('counts only ranked-war wins after cutoff', () => {
    const hits = countPostCutoffHits(TIMED_ATTACKS, CUTOFF)
    expect(hits.get(100)).toBe(3) // Alice: 3 wins after cutoff
    expect(hits.get(200)).toBe(1) // Bob: 1 win after cutoff
    expect(hits.has(300)).toBe(false) // Carol: only assist and loss
  })

  it('ignores incoming attacks', () => {
    const hits = countPostCutoffHits(TIMED_ATTACKS, CUTOFF)
    // Attack id=28 is incoming — should not inflate Alice's count
    expect(hits.get(100)).toBe(3)
  })

  it('ignores non-ranked wins', () => {
    const hits = countPostCutoffHits(TIMED_ATTACKS, CUTOFF)
    // Attack id=29 is non-ranked — should not count for Bob
    expect(hits.get(200)).toBe(1)
  })

  it('ignores assists and losses', () => {
    const hits = countPostCutoffHits(TIMED_ATTACKS, CUTOFF)
    expect(hits.has(300)).toBe(false)
  })

  it('returns empty map for empty attacks array', () => {
    const hits = countPostCutoffHits([], CUTOFF)
    expect(hits.size).toBe(0)
  })

  it('returns empty map when all attacks are before cutoff', () => {
    const hits = countPostCutoffHits(TIMED_ATTACKS, CUTOFF + 99999)
    expect(hits.size).toBe(0)
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
    totalReward: 13_500_000,
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
