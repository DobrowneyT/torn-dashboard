import { describe, it, expect } from 'vitest'
import {
  calculateCacheValue,
  calculateTermedWarPayouts,
  calculateRealWarPayouts,
  buildMemberAttackStats,
  calculateCutoffScores,
  detectRaceCutoff,
  calculateRaceWarPayouts,
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
  // Alice (100): 2 ranked-war wins BEFORE cutoff → pre-cutoff score = 30 + 25 = 55
  { id: 20, attacker_id: 100, attacker_faction_id: 10739, result: 'Hospitalized', is_ranked_war: true, is_incoming: false, started: WAR_START + 3600, respect_gain: 30 },
  { id: 21, attacker_id: 100, attacker_faction_id: 10739, result: 'Attacked',     is_ranked_war: true, is_incoming: false, started: WAR_START + 7200, respect_gain: 25 },
  // Alice: 3 ranked-war wins AFTER cutoff → post-cutoff score = 10 + 15 + 25 = 50
  { id: 22, attacker_id: 100, attacker_faction_id: 10739, result: 'Hospitalized', is_ranked_war: true, is_incoming: false, started: CUTOFF + 100, respect_gain: 10 },
  { id: 23, attacker_id: 100, attacker_faction_id: 10739, result: 'Attacked',     is_ranked_war: true, is_incoming: false, started: CUTOFF + 200, respect_gain: 15 },
  { id: 24, attacker_id: 100, attacker_faction_id: 10739, result: 'Attacked',     is_ranked_war: true, is_incoming: false, started: CUTOFF + 300, respect_gain: 25 },
  // Bob (200): 2 ranked-war wins BEFORE cutoff → pre-cutoff score = 20 + 30 = 50
  { id: 30, attacker_id: 200, attacker_faction_id: 10739, result: 'Attacked',     is_ranked_war: true, is_incoming: false, started: WAR_START + 5000, respect_gain: 20 },
  { id: 31, attacker_id: 200, attacker_faction_id: 10739, result: 'Attacked',     is_ranked_war: true, is_incoming: false, started: WAR_START + 9000, respect_gain: 30 },
  // Bob: 1 ranked-war win AFTER cutoff → post-cutoff score = 25
  { id: 25, attacker_id: 200, attacker_faction_id: 10739, result: 'Hospitalized', is_ranked_war: true, is_incoming: false, started: CUTOFF + 150, respect_gain: 25 },
  // Carol (300): 0 wins (1 assist after cutoff — should not count as score)
  { id: 26, attacker_id: 300, attacker_faction_id: 10739, result: 'Assist',       is_ranked_war: true, is_incoming: false, started: CUTOFF + 250, respect_gain: 0 },
  // Carol: 1 loss after cutoff — should not count
  { id: 27, attacker_id: 300, attacker_faction_id: 10739, result: 'Lost',         is_ranked_war: true, is_incoming: false, started: CUTOFF + 350, respect_gain: 0 },
  // Incoming attack after cutoff — should be ignored
  { id: 28, attacker_id: 100, attacker_faction_id: 10739, result: 'Hospitalized', is_ranked_war: true, is_incoming: true,  started: CUTOFF + 400, respect_gain: 10 },
  // Non-ranked win after cutoff — should be ignored
  { id: 29, attacker_id: 200, attacker_faction_id: 10739, result: 'Attacked',     is_ranked_war: false, is_incoming: false, started: CUTOFF + 500, respect_gain: 10 },
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
  // Threshold = 50
  // Alice (100): pre=55 (≥50 → 1 base share), post=50 → 50/50 = 1 additional → shares = 2.0
  // Bob (200):   pre=50 (≥50 → 1 base share), post=25 → 25/50 = 0.5 additional → shares = 1.5
  // Carol (300): pre=0, post=0 → shares = 0 (no pre-cutoff qualification)
  // Dave (400):  score=50 but pre=0 from attacks (no wins) → shares = 0
  // Total shares = 3.5, pool = 8M
  const baseSettings = {
    totalReward: 10_000_000,
    factionCutPercent: 20,
    minScoreThreshold: 50,
    termedMode: 'scaling',
    attacks: TIMED_ATTACKS,
    warStartAt: WAR_START,
    cutoffHours: 24,
  }

  it('calculates shares from pre/post cutoff scores', () => {
    const { members, totalShares } = calculateTermedWarPayouts(SAMPLE_CONTRIBUTIONS, baseSettings)
    const alice = members.find(m => m.memberId === 100)
    const bob   = members.find(m => m.memberId === 200)
    const carol = members.find(m => m.memberId === 300)

    expect(alice.preCutoffScore).toBe(55)
    expect(alice.postCutoffScore).toBe(50)
    expect(alice.shares).toBe(2.0)  // 1 + 50/50

    expect(bob.preCutoffScore).toBe(50)
    expect(bob.postCutoffScore).toBe(25)
    expect(bob.shares).toBe(1.5)    // 1 + 25/50

    // Carol has no ranked-war wins → 0 pre-cutoff score → no base share
    expect(carol.shares).toBe(0)

    expect(totalShares).toBe(3.5)
  })

  it('distributes pool proportionally by shares', () => {
    const { members, memberPayoutPool } = calculateTermedWarPayouts(SAMPLE_CONTRIBUTIONS, baseSettings)
    expect(memberPayoutPool).toBe(8_000_000)

    const alice = members.find(m => m.memberId === 100)
    const bob   = members.find(m => m.memberId === 200)

    // Alice: floor(2.0 / 3.5 * 8M) = floor(4,571,428.57) = 4,571,428
    expect(alice.payoutAmount).toBe(Math.floor(2.0 / 3.5 * 8_000_000))
    // Bob: floor(1.5 / 3.5 * 8M) = floor(3,428,571.43) = 3,428,571
    expect(bob.payoutAmount).toBe(Math.floor(1.5 / 3.5 * 8_000_000))
  })

  it('member who does not qualify pre-cutoff gets 0 shares', () => {
    const { members } = calculateTermedWarPayouts(SAMPLE_CONTRIBUTIONS, baseSettings)
    const carol = members.find(m => m.memberId === 300)
    expect(carol.shares).toBe(0)
    expect(carol.payoutAmount).toBe(0)
  })

  it('ineligible members (below overall threshold) get nothing', () => {
    // Threshold = 400: Bob (score=300) and Carol (score=200) are ineligible
    const settings = { ...baseSettings, minScoreThreshold: 400 }
    const { members } = calculateTermedWarPayouts(SAMPLE_CONTRIBUTIONS, settings)
    const bob = members.find(m => m.memberId === 200)
    expect(bob.isEligible).toBe(false)
    expect(bob.shares).toBe(0)
    expect(bob.payoutAmount).toBe(0)
  })

  it('eligible member with insufficient pre-cutoff attack score gets 0 shares', () => {
    // Threshold = 100: Alice's overall score (500) qualifies, but her
    // pre-cutoff attack respect is only 55 — below 100 → no base share
    const settings = { ...baseSettings, minScoreThreshold: 100 }
    const { members } = calculateTermedWarPayouts(SAMPLE_CONTRIBUTIONS, settings)
    const alice = members.find(m => m.memberId === 100)
    expect(alice.isEligible).toBe(true)
    expect(alice.preCutoffScore).toBe(55)
    expect(alice.shares).toBe(0) // didn't hit 100 pre-cutoff
    expect(alice.payoutAmount).toBe(0)
  })

  it('member with pre-cutoff score exactly at threshold qualifies', () => {
    // Bob has pre-cutoff = 50, threshold = 50 → should qualify
    const { members } = calculateTermedWarPayouts(SAMPLE_CONTRIBUTIONS, baseSettings)
    const bob = members.find(m => m.memberId === 200)
    expect(bob.shares).toBeGreaterThan(0)
    expect(bob.payoutAmount).toBeGreaterThan(0)
  })

  it('no post-cutoff score means 1 share only', () => {
    // Use attacks with only pre-cutoff hits
    const preCutoffOnly = TIMED_ATTACKS.filter(a => (Number(a.started) || 0) <= CUTOFF)
    const settings = { ...baseSettings, attacks: preCutoffOnly }
    const { members } = calculateTermedWarPayouts(SAMPLE_CONTRIBUTIONS, settings)
    const alice = members.find(m => m.memberId === 100)
    expect(alice.shares).toBe(1) // base share only, no post-cutoff
  })
})


// ---------------------------------------------------------------------------
// calculateCutoffScores
// ---------------------------------------------------------------------------

describe('calculateCutoffScores', () => {
  it('sums respect for ranked-war wins before and after cutoff', () => {
    const scores = calculateCutoffScores(TIMED_ATTACKS, CUTOFF)
    const alice = scores.get(100)
    expect(alice.preCutoffScore).toBe(55)   // 30 + 25
    expect(alice.postCutoffScore).toBe(50)  // 10 + 15 + 25
  })

  it('tracks multiple members independently', () => {
    const scores = calculateCutoffScores(TIMED_ATTACKS, CUTOFF)
    const bob = scores.get(200)
    expect(bob.preCutoffScore).toBe(50)    // 20 + 30
    expect(bob.postCutoffScore).toBe(25)   // 25
  })

  it('ignores incoming attacks', () => {
    const scores = calculateCutoffScores(TIMED_ATTACKS, CUTOFF)
    // id=28 is incoming with respect=10 — should not count
    expect(scores.get(100).postCutoffScore).toBe(50)
  })

  it('ignores non-ranked wins', () => {
    const scores = calculateCutoffScores(TIMED_ATTACKS, CUTOFF)
    // id=29 is non-ranked — should not count for Bob
    expect(scores.get(200).postCutoffScore).toBe(25)
  })

  it('ignores assists and losses', () => {
    const scores = calculateCutoffScores(TIMED_ATTACKS, CUTOFF)
    expect(scores.has(300)).toBe(false)
  })

  it('returns empty map for empty attacks', () => {
    const scores = calculateCutoffScores([], CUTOFF)
    expect(scores.size).toBe(0)
  })

  it('returns all as pre-cutoff when cutoff is far in the future', () => {
    const scores = calculateCutoffScores(TIMED_ATTACKS, CUTOFF + 99999)
    const alice = scores.get(100)
    expect(alice.preCutoffScore).toBe(105)  // 30 + 25 + 10 + 15 + 25
    expect(alice.postCutoffScore).toBe(0)
  })

  it('caps bonus chain hits at 10 respect', () => {
    const attacksWithBonus = [
      // Normal hit: 30 respect, chain 15 → counted as 30
      { id: 40, attacker_id: 100, attacker_faction_id: 10739, result: 'Attacked', is_ranked_war: true, is_incoming: false, started: WAR_START + 1000, respect_gain: 30, chain: 15 },
      // Bonus hit at chain 100: 80 respect → capped to 10
      { id: 41, attacker_id: 100, attacker_faction_id: 10739, result: 'Attacked', is_ranked_war: true, is_incoming: false, started: WAR_START + 2000, respect_gain: 80, chain: 100 },
      // Bonus hit at chain 250: 160 respect → capped to 10 (post-cutoff)
      { id: 42, attacker_id: 100, attacker_faction_id: 10739, result: 'Attacked', is_ranked_war: true, is_incoming: false, started: CUTOFF + 100, respect_gain: 160, chain: 250 },
      // Normal post-cutoff hit: 20 respect, chain 251 → counted as 20
      { id: 43, attacker_id: 100, attacker_faction_id: 10739, result: 'Attacked', is_ranked_war: true, is_incoming: false, started: CUTOFF + 200, respect_gain: 20, chain: 251 },
    ]
    const scores = calculateCutoffScores(attacksWithBonus, CUTOFF)
    const alice = scores.get(100)
    expect(alice.preCutoffScore).toBe(40)   // 30 + 10 (80 capped)
    expect(alice.postCutoffScore).toBe(30)  // 10 (160 capped) + 20
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
// buildMemberAttackStats — regularHits
// ---------------------------------------------------------------------------

describe('buildMemberAttackStats — regularHits', () => {
  it('counts non-ranked wins as regularHits', () => {
    const attacks = [
      { id: 50, attacker_id: 100, attacker_faction_id: 10739, result: 'Hospitalized', is_ranked_war: false, is_incoming: false, chain: 1, respect_gain: 5 },
      { id: 51, attacker_id: 100, attacker_faction_id: 10739, result: 'Attacked',     is_ranked_war: false, is_incoming: false, chain: 2, respect_gain: 3 },
    ]
    const stats = buildMemberAttackStats(attacks)
    expect(stats.get(100).regularHits).toBe(2)
    expect(stats.get(100).warHits).toBe(0)
  })

  it('ranked war wins do not count as regularHits', () => {
    const attacks = [
      { id: 52, attacker_id: 100, attacker_faction_id: 10739, result: 'Hospitalized', is_ranked_war: true, is_incoming: false, chain: 1, respect_gain: 5 },
    ]
    const stats = buildMemberAttackStats(attacks)
    expect(stats.get(100).warHits).toBe(1)
    expect(stats.get(100).regularHits).toBe(0)
  })

  it('mixed ranked and non-ranked wins tracked separately', () => {
    const attacks = [
      { id: 53, attacker_id: 100, attacker_faction_id: 10739, result: 'Hospitalized', is_ranked_war: true,  is_incoming: false, chain: 1, respect_gain: 5 },
      { id: 54, attacker_id: 100, attacker_faction_id: 10739, result: 'Attacked',     is_ranked_war: false, is_incoming: false, chain: 2, respect_gain: 3 },
      { id: 55, attacker_id: 100, attacker_faction_id: 10739, result: 'Mugged',       is_ranked_war: false, is_incoming: false, chain: 3, respect_gain: 2 },
    ]
    const stats = buildMemberAttackStats(attacks)
    expect(stats.get(100).warHits).toBe(1)
    expect(stats.get(100).regularHits).toBe(2)
    expect(stats.get(100).won).toBe(3)
  })

  it('assists and losses do not count as regularHits', () => {
    const attacks = [
      { id: 56, attacker_id: 100, attacker_faction_id: 10739, result: 'Assist', is_ranked_war: false, is_incoming: false, chain: 0, respect_gain: 0 },
      { id: 57, attacker_id: 100, attacker_faction_id: 10739, result: 'Lost',   is_ranked_war: false, is_incoming: false, chain: 0, respect_gain: 0 },
    ]
    const stats = buildMemberAttackStats(attacks)
    expect(stats.get(100).regularHits).toBe(0)
  })
})


// ---------------------------------------------------------------------------
// calculateRealWarPayouts — per-member overrides & regularHitMultiplier
// ---------------------------------------------------------------------------

describe('calculateRealWarPayouts — per-member overrides', () => {
  // Alice has 4 ranked-war hits, Bob has 2 mugs + 1 assist, Carol has 1 war hit + 1 assist
  const baseSettings = {
    totalReward: 10_000_000,
    factionCutPercent: 0,
    warHitMultiplier:    1.25,
    assistMultiplier:    0.50,
    lossMultiplier:      0.50,
    mugMultiplier:      -1.00,
    regularHitMultiplier: 0.00,
    participationWeight: 1.0,
    contributionWeight:  0.0,
  }

  it('regularHitMultiplier of 0 gives regularHits no score', () => {
    const attacks = [
      ...SAMPLE_ATTACKS,
      { id: 60, attacker_id: 100, attacker_faction_id: 10739, result: 'Attacked', is_ranked_war: false, is_incoming: false, chain: 5, respect_gain: 3 },
    ]
    const { members } = calculateRealWarPayouts(SAMPLE_CONTRIBUTIONS, attacks, baseSettings)
    const alice = members.find(m => m.memberId === 100)
    expect(alice.regularHits).toBe(1)
    expect(alice.regularHitScore).toBe(0)
  })

  it('regularHitMultiplier > 0 adds to participation score', () => {
    const attacks = [
      ...SAMPLE_ATTACKS,
      { id: 60, attacker_id: 100, attacker_faction_id: 10739, result: 'Attacked', is_ranked_war: false, is_incoming: false, chain: 5, respect_gain: 3 },
    ]
    const settings = { ...baseSettings, regularHitMultiplier: 0.25 }
    const { members } = calculateRealWarPayouts(SAMPLE_CONTRIBUTIONS, attacks, settings)
    const alice = members.find(m => m.memberId === 100)
    expect(alice.regularHitScore).toBe(0.25) // 1 * 0.25
    // participationScore includes regularHitScore
    expect(alice.participationScore).toBe(
      Math.round((4 * 1.25 + 1 * 0.25 + 0 * 0.50 + 1 * 0.50 + 0 * -1.00) * 100) / 100
    )
  })

  it('per-member override replaces global multiplier for that member', () => {
    const settings = {
      ...baseSettings,
      memberMultiplierOverrides: {
        100: { warHitMultiplier: 2.00 },  // Alice gets 2× per war hit instead of 1.25
      },
    }
    const { members } = calculateRealWarPayouts(SAMPLE_CONTRIBUTIONS, SAMPLE_ATTACKS, settings)
    const alice = members.find(m => m.memberId === 100)
    const bob   = members.find(m => m.memberId === 200)
    // Alice: 4 * 2.00 = 8.0 war hit score
    expect(alice.warHitScore).toBe(8.0)
    expect(alice.effWarHitMult).toBe(2.00)
    // Bob still uses global 1.25
    expect(bob.effWarHitMult).toBe(1.25)
  })

  it('per-member override only affects specified multiplier type', () => {
    const settings = {
      ...baseSettings,
      memberMultiplierOverrides: {
        200: { mugMultiplier: 0 },  // Bob's mug penalty removed
      },
    }
    const { members } = calculateRealWarPayouts(SAMPLE_CONTRIBUTIONS, SAMPLE_ATTACKS, settings)
    const bob = members.find(m => m.memberId === 200)
    // Bob: 2 war hits * 1.25 + 2 mugs * 0 + 1 assist * 0.5 = 3.0
    expect(bob.mugScore).toBe(0)
    expect(bob.participationScore).toBe(3.0)
    expect(bob.effMugMult).toBe(0)
    expect(bob.effWarHitMult).toBe(1.25)  // unchanged
  })

  it('effective multipliers are returned per member', () => {
    const settings = {
      ...baseSettings,
      memberMultiplierOverrides: {
        100: { assistMultiplier: 0.75, regularHitMultiplier: 0.10 },
      },
    }
    const { members } = calculateRealWarPayouts(SAMPLE_CONTRIBUTIONS, SAMPLE_ATTACKS, settings)
    const alice = members.find(m => m.memberId === 100)
    const carol = members.find(m => m.memberId === 300)
    expect(alice.effAssistMult).toBe(0.75)
    expect(alice.effRegularMult).toBe(0.10)
    expect(carol.effAssistMult).toBe(0.50)  // global default
    expect(carol.effRegularMult).toBe(0.00) // global default
  })

  it('empty overrides object uses all globals', () => {
    const settings = { ...baseSettings, memberMultiplierOverrides: {} }
    const { members } = calculateRealWarPayouts(SAMPLE_CONTRIBUTIONS, SAMPLE_ATTACKS, settings)
    const alice = members.find(m => m.memberId === 100)
    expect(alice.effWarHitMult).toBe(1.25)
    expect(alice.effAssistMult).toBe(0.50)
    expect(alice.effLossMult).toBe(0.50)
    expect(alice.effMugMult).toBe(-1.00)
    expect(alice.effRegularMult).toBe(0.00)
  })
})


// ---------------------------------------------------------------------------
// detectRaceCutoff
// ---------------------------------------------------------------------------

describe('detectRaceCutoff', () => {
  // Attacks for race detection: outgoing our hits + incoming opponent hits
  const RACE_ATTACKS = [
    // Our faction outgoing wins (respect adds to our tally)
    { id: 70, attacker_id: 100, attacker_faction_id: 10739, defender_faction_id: 99999, result: 'Hospitalized', is_ranked_war: true, is_incoming: false, started: 1000, respect_gain: 30 },
    { id: 71, attacker_id: 200, attacker_faction_id: 10739, defender_faction_id: 99999, result: 'Attacked',     is_ranked_war: true, is_incoming: false, started: 2000, respect_gain: 25 },
    // Incoming opponent wins (respect adds to opposing tally)
    { id: 72, attacker_id: 500, attacker_faction_id: 99999, defender_id: 100, defender_faction_id: 10739, result: 'Hospitalized', is_ranked_war: true, is_incoming: true, started: 1500, respect_gain: 20 },
    { id: 73, attacker_id: 501, attacker_faction_id: 99999, defender_id: 200, defender_faction_id: 10739, result: 'Attacked',     is_ranked_war: true, is_incoming: true, started: 2500, respect_gain: 35 },
    // More of our hits
    { id: 74, attacker_id: 100, attacker_faction_id: 10739, defender_faction_id: 99999, result: 'Hospitalized', is_ranked_war: true, is_incoming: false, started: 3000, respect_gain: 50 },
  ]

  it('returns timestamp when our faction reaches target first', () => {
    // Target = 100. Our tally: 30 (t=1000) + 25 (t=2000) = 55 ... + 50 (t=3000) = 105 → crosses at t=3000
    // Opposing tally: 20 (t=1500) + 35 (t=2500) = 55, never reaches 100
    const ts = detectRaceCutoff(RACE_ATTACKS, 100)
    expect(ts).toBe(3000)
  })

  it('returns timestamp when opposing faction reaches target first', () => {
    // Target = 50. Sorted by started: t=1000(us+30), t=1500(them+20), t=2000(us+25), t=2500(them+35)
    // Our: 30, then 55 at t=2000
    // Opposing: 20, then 55 at t=2500
    // Our crosses 50 first at t=2000
    const ts = detectRaceCutoff(RACE_ATTACKS, 50)
    expect(ts).toBe(2000)  // our faction hits 55 at t=2000
  })

  it('returns timestamp when opposing faction crosses first', () => {
    // Target = 40. Sorted: t=1000(us=30), t=1500(them=20), t=2000(us=55), t=2500(them=55)
    // Us at t=2000: 30+25=55 ≥ 40 → crosses at t=2000
    // But them at t=1500: only 20 <40
    // So us crosses first at t=2000
    // Let's make a scenario where opponent crosses first:
    const attacks = [
      { id: 80, attacker_id: 100, attacker_faction_id: 10739, defender_faction_id: 99999, result: 'Attacked', is_ranked_war: true, is_incoming: false, started: 5000, respect_gain: 10 },
      { id: 81, attacker_id: 500, attacker_faction_id: 99999, defender_id: 100, defender_faction_id: 10739, result: 'Hospitalized', is_ranked_war: true, is_incoming: true, started: 3000, respect_gain: 50 },
    ]
    const ts = detectRaceCutoff(attacks, 40)
    expect(ts).toBe(3000)  // opponent crosses 40 at t=3000, we don't until t=5000
  })

  it('returns null when neither faction reaches target', () => {
    const ts = detectRaceCutoff(RACE_ATTACKS, 999)
    expect(ts).toBeNull()
  })

  it('returns null for empty attacks', () => {
    expect(detectRaceCutoff([], 100)).toBeNull()
  })

  it('returns null for zero or negative target', () => {
    expect(detectRaceCutoff(RACE_ATTACKS, 0)).toBeNull()
    expect(detectRaceCutoff(RACE_ATTACKS, -10)).toBeNull()
  })

  it('ignores non-ranked attacks', () => {
    const attacks = [
      { id: 90, attacker_id: 100, attacker_faction_id: 10739, result: 'Attacked', is_ranked_war: false, is_incoming: false, started: 1000, respect_gain: 999 },
    ]
    expect(detectRaceCutoff(attacks, 50)).toBeNull()
  })

  it('ignores non-win results (assists, losses)', () => {
    const attacks = [
      { id: 91, attacker_id: 100, attacker_faction_id: 10739, result: 'Assist', is_ranked_war: true, is_incoming: false, started: 1000, respect_gain: 50 },
      { id: 92, attacker_id: 100, attacker_faction_id: 10739, result: 'Lost',   is_ranked_war: true, is_incoming: false, started: 2000, respect_gain: 50 },
    ]
    expect(detectRaceCutoff(attacks, 50)).toBeNull()
  })

  it('uses full respect (no bonus normalization) for detection', () => {
    // A bonus chain hit at chain=100 with 80 respect should count as 80 (not capped to 10)
    const attacks = [
      { id: 93, attacker_id: 100, attacker_faction_id: 10739, result: 'Attacked', is_ranked_war: true, is_incoming: false, started: 1000, respect_gain: 80, chain: 100 },
    ]
    const ts = detectRaceCutoff(attacks, 50)
    expect(ts).toBe(1000)  // 80 ≥ 50
  })
})


// ---------------------------------------------------------------------------
// calculateRaceWarPayouts
// ---------------------------------------------------------------------------

describe('calculateRaceWarPayouts', () => {
  // Use TIMED_ATTACKS which have pre/post cutoff timestamps
  // Alice: pre-cutoff respect 55, post-cutoff 50
  // Bob: pre-cutoff respect 50, post-cutoff 25
  // Carol: no wins
  const baseSettings = {
    totalReward: 10_000_000,
    factionCutPercent: 0,
    mercCost: 0,
    reviverCost: 0,
    factionTopUp: 0,
    raceCutoffTimestamp: CUTOFF,
    racePreCutoffPercent: 50,
    racePostCutoffMode: 'flat',
    warHitMultiplier: 1.25,
    assistMultiplier: 0.50,
    lossMultiplier: 0.50,
    mugMultiplier: -1.00,
    regularHitMultiplier: 0.00,
    participationWeight: 1.0,
    contributionWeight: 0.0,
    minScoreThreshold: 0,
  }

  it('splits pool into pre and post cutoff pools', () => {
    const result = calculateRaceWarPayouts(SAMPLE_CONTRIBUTIONS, TIMED_ATTACKS, baseSettings)
    expect(result.preCutoffPool).toBe(5_000_000)   // 50% of 10M
    expect(result.postCutoffPool).toBe(5_000_000)
    expect(result.memberPayoutPool).toBe(10_000_000)
  })

  it('applies different pool split percentages', () => {
    const settings = { ...baseSettings, racePreCutoffPercent: 70 }
    const result = calculateRaceWarPayouts(SAMPLE_CONTRIBUTIONS, TIMED_ATTACKS, settings)
    expect(result.preCutoffPool).toBe(7_000_000)
    expect(result.postCutoffPool).toBe(3_000_000)
  })

  it('combines pre and post cutoff payouts per member', () => {
    const result = calculateRaceWarPayouts(SAMPLE_CONTRIBUTIONS, TIMED_ATTACKS, baseSettings)
    const alice = result.members.find(m => m.memberId === 100)
    expect(alice.preCutoffPayout).toBeGreaterThanOrEqual(0)
    expect(alice.postCutoffPayout).toBeGreaterThanOrEqual(0)
    expect(alice.payoutAmount).toBe(alice.preCutoffPayout + alice.postCutoffPayout)
  })

  it('pre-cutoff portion uses real war formula', () => {
    // With participationWeight=1, only attack stats matter for pre-cutoff
    // Alice has pre-cutoff ranked war wins, Bob has pre-cutoff ranked war wins
    const result = calculateRaceWarPayouts(SAMPLE_CONTRIBUTIONS, TIMED_ATTACKS, baseSettings)
    const alice = result.members.find(m => m.memberId === 100)
    const bob   = result.members.find(m => m.memberId === 200)
    // Both should have pre-cutoff payouts since they have war hits before cutoff
    expect(alice.preCutoffPayout).toBeGreaterThan(0)
    expect(bob.preCutoffPayout).toBeGreaterThan(0)
  })

  it('post-cutoff flat shares mode splits pool equally among eligible', () => {
    // All 3 contributions are eligible (threshold=0), each gets 1 share
    const result = calculateRaceWarPayouts(SAMPLE_CONTRIBUTIONS, TIMED_ATTACKS, baseSettings)
    const alice = result.members.find(m => m.memberId === 100)
    const bob   = result.members.find(m => m.memberId === 200)
    const carol = result.members.find(m => m.memberId === 300)
    // Flat shares: each member gets floor(5M / 3) = 1,666,666
    expect(alice.postCutoffPayout).toBe(Math.floor(5_000_000 / 3))
    expect(bob.postCutoffPayout).toBe(Math.floor(5_000_000 / 3))
    expect(carol.postCutoffPayout).toBe(Math.floor(5_000_000 / 3))
  })

  it('applies faction cut before splitting pools', () => {
    const settings = { ...baseSettings, factionCutPercent: 20 }
    const result = calculateRaceWarPayouts(SAMPLE_CONTRIBUTIONS, TIMED_ATTACKS, settings)
    // 10M - 20% cut = 8M pool, 50/50 = 4M each
    expect(result.factionCutAmount).toBe(2_000_000)
    expect(result.memberPayoutPool).toBe(8_000_000)
    expect(result.preCutoffPool).toBe(4_000_000)
    expect(result.postCutoffPool).toBe(4_000_000)
  })

  it('total payout does not exceed member pool', () => {
    const result = calculateRaceWarPayouts(SAMPLE_CONTRIBUTIONS, TIMED_ATTACKS, baseSettings)
    expect(result.totalPayout).toBeLessThanOrEqual(result.memberPayoutPool)
  })

  it('handles post-cutoff scaling mode', () => {
    const settings = {
      ...baseSettings,
      racePostCutoffMode: 'scaling',
      minScoreThreshold: 50,
      cutoffHours: 24,
    }
    const result = calculateRaceWarPayouts(SAMPLE_CONTRIBUTIONS, TIMED_ATTACKS, settings)
    // Post-cutoff scaling uses termed scaling formula
    // Members need to qualify based on their scores and post-cutoff attack data
    expect(result.totalPayout).toBeGreaterThanOrEqual(0)
    expect(result.totalPayout).toBeLessThanOrEqual(result.memberPayoutPool)
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
