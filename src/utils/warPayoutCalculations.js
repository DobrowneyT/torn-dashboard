/**
 * War Payout Calculations
 *
 * Two payout modes:
 *   - 'termed': flat amount if member score >= minScoreThreshold
 *   - 'real':   weighted formula using war report score + attack effort data
 *
 * Cache value is the only payout pool (no money rewards in ranked wars).
 * Faction cut is applied before distributing.
 */

// Our faction ID — kept in sync with config
const OUR_FACTION_ID = 10739

// Attack results considered "successful" (full credit) for effort scoring
const SUCCESSFUL_RESULTS = new Set([
  'Attacked', 'Mugged', 'Hospitalized', 'Arrested', 'Looted'
])

// Assist attacks are tracked separately and weighted by assistMultiplier (< 1.0)
const ASSIST_RESULT = 'Assist'

// Item name → price field mapping (matches war_payouts table columns)
export const CACHE_ITEM_MAP = {
  'Melee Cache':       'price_melee_cache',
  'Armor Cache':       'price_armor_cache',
  'Small Arms Cache':  'price_small_arms_cache',
  'Medium Arms Cache': 'price_medium_arms_cache',
  'Heavy Arms Cache':  'price_heavy_arms_cache',
}


/**
 * Calculate total cache value from war report rewards and user-entered prices.
 *
 * @param {Array} rewardsItems - [{id, name, quantity}] from war.rewards_items (JSONB)
 * @param {object} cachePrices - { price_melee_cache, price_armor_cache, ... }
 * @returns {{ totalCacheValue: number, breakdown: Array }}
 */
export function calculateCacheValue(rewardsItems, cachePrices) {
  if (!rewardsItems || rewardsItems.length === 0) {
    return { totalCacheValue: 0, breakdown: [] }
  }

  const breakdown = []
  let totalCacheValue = 0

  for (const item of rewardsItems) {
    const priceField = CACHE_ITEM_MAP[item.name]
    if (!priceField) continue

    const price = Number(cachePrices[priceField]) || 0
    const qty = Number(item.quantity) || 0
    const value = price * qty

    breakdown.push({
      name: item.name,
      quantity: qty,
      priceEach: price,
      totalValue: value,
    })
    totalCacheValue += value
  }

  return { totalCacheValue, breakdown }
}


/**
 * Calculate termed war payouts.
 * Members with score >= minScoreThreshold each receive flatPayoutAmount.
 *
 * @param {Array} contributions - war_member_contributions rows (our faction only)
 * @param {object} settings - {
 *   rewardsItems, cachePrices, factionCutPercent,
 *   minScoreThreshold, flatPayoutAmount
 * }
 * @returns {{
 *   members: Array,
 *   totalPayout: number,
 *   cacheValue: number,
 *   memberPayoutPool: number,
 *   overBudgetWarning: boolean
 * }}
 */
export function calculateTermedWarPayouts(contributions, settings) {
  const {
    rewardsItems,
    cachePrices,
    factionCutPercent = 20,
    minScoreThreshold = 0,
    flatPayoutAmount = 0,
  } = settings

  const { totalCacheValue, breakdown } = calculateCacheValue(rewardsItems, cachePrices)
  const memberPayoutPool = Math.floor(totalCacheValue * (1 - factionCutPercent / 100))

  const members = contributions.map(m => {
    const score = Number(m.score) || 0
    const isEligible = score >= Number(minScoreThreshold)
    return {
      memberId: m.member_id,
      memberName: m.member_name,
      score,
      attacks: m.attacks || 0,
      isEligible,
      payoutAmount: isEligible ? Number(flatPayoutAmount) : 0,
    }
  })

  const eligibleCount = members.filter(m => m.isEligible).length
  const totalPayout = eligibleCount * Number(flatPayoutAmount)
  const overBudgetWarning = totalPayout > memberPayoutPool

  return {
    members,
    totalPayout,
    cacheValue: totalCacheValue,
    cacheBreakdown: breakdown,
    memberPayoutPool,
    overBudgetWarning,
  }
}


/**
 * Build per-member attack stats from faction_attacks rows filtered to a war window.
 * Only considers outgoing attacks made by our faction (attacker_faction_id === OUR_FACTION_ID).
 *
 * Assists count at a reduced rate (assistMultiplier < 1.0) toward the weighted effort score.
 * This rewards members who assisted teammates during the war without giving full credit.
 *
 * @param {Array}  attacks          - faction_attacks rows (pre-filtered to war window)
 * @param {number} assistMultiplier - Fraction of a full attack that an assist counts as (default 0.25)
 * @returns {Map<number, object>} memberId → {
 *   totalAttacks, successfulAttacks, assistAttacks,
 *   weightedSuccessful, totalRespect, avgFairFight
 * }
 */
export function buildMemberAttackStats(attacks, assistMultiplier = 0.25) {
  const stats = new Map()

  for (const attack of attacks) {
    if (attack.attacker_faction_id !== OUR_FACTION_ID) continue

    const memberId = attack.attacker_id
    if (!stats.has(memberId)) {
      stats.set(memberId, {
        totalAttacks: 0,
        successfulAttacks: 0,
        assistAttacks: 0,
        totalRespect: 0,
        fairFightSum: 0,
        weightedFairFightCount: 0,
      })
    }

    const s = stats.get(memberId)
    s.totalAttacks += 1

    const result = attack.result || ''
    if (result === ASSIST_RESULT) {
      s.assistAttacks += 1
      // Assists contribute at assistMultiplier weight toward avg fair fight
      s.fairFightSum += (Number(attack.fair_fight) || 1) * assistMultiplier
      s.weightedFairFightCount += assistMultiplier
    } else if (SUCCESSFUL_RESULTS.has(result)) {
      s.successfulAttacks += 1
      s.fairFightSum += Number(attack.fair_fight) || 1
      s.weightedFairFightCount += 1
    }

    s.totalRespect += Number(attack.respect_gain) || 0
  }

  // Compute derived fields
  for (const [, s] of stats) {
    s.weightedSuccessful = s.successfulAttacks + (s.assistAttacks * assistMultiplier)
    s.avgFairFight = s.weightedFairFightCount > 0
      ? s.fairFightSum / s.weightedFairFightCount
      : 1
  }

  return stats
}


/**
 * Calculate real war payouts using a weighted composite formula.
 *
 * Formula:
 *   scorePercent[i]   = member.score / totalFactionScore
 *   attackEffort[i]   = (successfulAttacks[i] / maxSuccessfulInWar) * avgFairFight[i]
 *   composite[i]      = (scorePercent[i] * scoreMultiplier * attacksWeight)
 *                     + (attackEffort[i] * effortWeight)
 *   sharePercent[i]   = composite[i] / sum(composite)
 *   rawPayout[i]      = floor(sharePercent[i] * memberPayoutPool)
 *   payout[i]         = rawPayout[i] >= minPayoutThreshold ? rawPayout[i] : 0
 *
 * @param {Array} contributions - war_member_contributions rows (our faction only)
 * @param {Array} attacks - war_attacks rows
 * @param {object} settings - {
 *   rewardsItems, cachePrices, factionCutPercent,
 *   scoreMultiplier, attacksWeight, effortWeight, minPayoutThreshold
 * }
 * @returns {{
 *   members: Array,
 *   totalPayout: number,
 *   cacheValue: number,
 *   memberPayoutPool: number,
 * }}
 */
export function calculateRealWarPayouts(contributions, attacks, settings) {
  const {
    rewardsItems,
    cachePrices,
    factionCutPercent = 20,
    scoreMultiplier = 1.0,
    attacksWeight = 0.5,
    effortWeight = 0.5,
    assistMultiplier = 0.25,
    minPayoutThreshold = 0,
  } = settings

  const { totalCacheValue, breakdown } = calculateCacheValue(rewardsItems, cachePrices)
  const memberPayoutPool = Math.floor(totalCacheValue * (1 - factionCutPercent / 100))

  const attackStats = buildMemberAttackStats(attacks, Number(assistMultiplier))
  const totalWarScore = contributions.reduce((sum, m) => sum + (Number(m.score) || 0), 0)

  // Find max weighted successful attacks for normalization
  let maxSuccessful = 0
  for (const s of attackStats.values()) {
    if (s.weightedSuccessful > maxSuccessful) maxSuccessful = s.weightedSuccessful
  }

  // Step 1: Compute composite scores
  const memberData = contributions.map(m => {
    const memberId = m.member_id
    const score = Number(m.score) || 0
    const scorePercent = totalWarScore > 0 ? score / totalWarScore : 0

    const stats = attackStats.get(memberId) || { weightedSuccessful: 0, successfulAttacks: 0, assistAttacks: 0, avgFairFight: 1 }
    const attackEffort = maxSuccessful > 0
      ? (stats.weightedSuccessful / maxSuccessful) * stats.avgFairFight
      : 0

    const composite = (scorePercent * Number(scoreMultiplier) * Number(attacksWeight))
                    + (attackEffort * Number(effortWeight))

    return {
      memberId,
      memberName: m.member_name,
      score,
      attacks: m.attacks || 0,
      successfulAttacks: stats.successfulAttacks,
      assistAttacks: stats.assistAttacks,
      weightedSuccessful: Math.round(stats.weightedSuccessful * 100) / 100,
      avgFairFight: Math.round(stats.avgFairFight * 100) / 100,
      scorePercent,
      attackEffort,
      composite,
    }
  })

  // Step 2: Normalize
  const totalComposite = memberData.reduce((sum, m) => sum + m.composite, 0)

  // Step 3: Compute payouts
  const members = memberData.map(m => {
    const sharePercent = totalComposite > 0 ? m.composite / totalComposite : 0
    const rawPayout = Math.floor(sharePercent * memberPayoutPool)
    const isEligible = rawPayout >= Number(minPayoutThreshold)

    return {
      ...m,
      sharePercent,
      rawPayout,
      isEligible,
      payoutAmount: isEligible ? rawPayout : 0,
    }
  })

  const totalPayout = members.reduce((sum, m) => sum + m.payoutAmount, 0)

  return {
    members,
    totalPayout,
    cacheValue: totalCacheValue,
    cacheBreakdown: breakdown,
    memberPayoutPool,
  }
}


/**
 * Generate the Torn batch balance URL for war payouts.
 * Only includes members who are eligible AND have payout > 0.
 *
 * @param {Array} members - Payout results with { memberId, payoutAmount, isEligible }
 * @returns {string} Torn URL or empty string if no eligible members
 */
export function generateWarBatchPayoutURL(members) {
  const eligible = members.filter(m => m.isEligible && m.payoutAmount > 0)
  if (eligible.length === 0) return ''

  const uids = eligible.map(m => m.memberId).join(',')
  const amounts = eligible.map(m => Math.floor(m.payoutAmount)).join(',')

  return `https://www.torn.com/factions.php?step=your#/tab=controls&batbal_uids=${uids}&batbal_amounts=${amounts}`
}


/**
 * Format a Unix timestamp as a human-readable date string.
 *
 * @param {number} timestamp - Unix timestamp (seconds)
 * @returns {string}
 */
export function formatWarDate(timestamp) {
  if (!timestamp) return 'N/A'
  return new Date(timestamp * 1000).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric'
  })
}


/**
 * Format a war's date range as a display string.
 *
 * @param {number} startAt - Unix timestamp
 * @param {number|null} endAt - Unix timestamp or null/0 for ongoing
 * @returns {string}
 */
export function formatWarDateRange(startAt, endAt) {
  const start = formatWarDate(startAt)
  if (!endAt || endAt === 0) return `${start} — Ongoing`
  const end = formatWarDate(endAt)
  return `${start} — ${end}`
}
