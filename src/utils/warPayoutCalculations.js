/**
 * War Payout Calculations
 *
 * Exact formula matching the faction DL War Pay spreadsheet:
 *
 *  PARTICIPATION (from faction_attacks outgoing hits)
 *    War hit  (is_ranked_war=true, won)         × 1.25
 *    Assist   (result='Assist')                  × 0.50
 *    Loss     (result='Lost')                    × 0.50
 *    Mug      (result='Mugged', any target)      × −1.00  (penalty, stacks with War hit)
 *    Regular  (won, is_ranked_war=false)          × 0.00
 *
 *    participationShare[i] = max(0, score[i]) / Σ max(0, score[j])
 *
 *  CONTRIBUTION (from rankedwarreport score + faction_attacks chain bonuses)
 *    Respect gained   = score from war_member_contributions (API source of truth)
 *    Bonus respect    = Σ (respect_gain − 10) for outgoing ranked-war attacks
 *                       where chain ∈ BONUS_HITS (auto-normalized)
 *    Adjusted respect = max(0, Respect gained − Bonus respect)
 *    contributionShare[i] = adjusted[i] / Σ adjusted[j]
 *
 *  EFFORT & PAYOUT
 *    effortShare[i] = (participationShare[i] + contributionShare[i]) / 2
 *    payout[i]      = floor(effortShare[i] × memberPool)
 *    memberPool     = floor(totalCacheValue × (1 − factionCut/100))
 */

const OUR_FACTION_ID = 10739

// Torn chain milestones that inflate respect gain
export const BONUS_HITS = new Set([10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000])

// Win result types from the Torn API
const WIN_RESULTS = new Set(['Attacked', 'Mugged', 'Hospitalized', 'Arrested', 'Looted'])

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

    breakdown.push({ name: item.name, quantity: qty, priceEach: price, totalValue: value })
    totalCacheValue += value
  }

  return { totalCacheValue, breakdown }
}


/**
 * Build per-member attack breakdown from faction_attacks rows within a war window.
 *
 * Only considers outgoing attacks by our faction (is_incoming=false, attacker_faction_id=OUR).
 *
 * Column definitions matching the spreadsheet:
 *   leaves     — wins where result ∈ {Attacked, Arrested, Looted}
 *   mugs       — wins where result = Mugged  (penalty in participation, independent of war/non-war)
 *   hosp       — wins where result = Hospitalized
 *   warHits    — wins (any result) where is_ranked_war = true  (overlaps with above)
 *   won        — leaves + mugs + hosp  (total wins)
 *   assists    — result = Assist
 *   losses     — result = Lost
 *   totalHits  — won + assists + losses
 *   bonusRespect — Σ max(0, respect_gain − 10) for outgoing ranked-war attacks at bonus chain counts
 *
 * @param {Array} attacks - faction_attacks rows (pre-filtered to war window)
 * @returns {Map<number, object>} memberId → stats object
 */
export function buildMemberAttackStats(attacks) {
  const stats = new Map()

  for (const attack of attacks) {
    // Only outgoing attacks by our faction
    if (attack.is_incoming === true || attack.is_incoming === 'true' || attack.is_incoming === 1) continue
    if (attack.attacker_faction_id !== OUR_FACTION_ID) continue

    const memberId = attack.attacker_id
    if (!stats.has(memberId)) {
      stats.set(memberId, {
        leaves: 0,
        mugs: 0,
        hosp: 0,
        warHits: 0,
        won: 0,
        assists: 0,
        losses: 0,
        bonusRespect: 0,
      })
    }

    const s = stats.get(memberId)
    const result = attack.result || ''
    const respectGain = parseFloat(attack.respect_gain) || 0
    const chain = Number(attack.chain) || 0
    const isRankedWar = attack.is_ranked_war === true || attack.is_ranked_war === 'true' || attack.is_ranked_war === 1

    if (result === 'Assist') {
      s.assists += 1
    } else if (result === 'Lost' || result === 'Timeout' || result === 'Interrupted') {
      s.losses += 1
    } else if (WIN_RESULTS.has(result)) {
      s.won += 1
      if (result === 'Mugged') s.mugs += 1
      else if (result === 'Hospitalized') s.hosp += 1
      else s.leaves += 1  // Attacked, Arrested, Looted

      if (isRankedWar) {
        s.warHits += 1
        // Normalize bonus chain hits: subtract the inflated portion, leaving a base of 10
        if (BONUS_HITS.has(chain)) {
          s.bonusRespect += Math.max(0, respectGain - 10)
        }
      }
    }
    // Stalemate, Escape, Special → not counted in any column
  }

  return stats
}


/**
 * Build per-member Hit Report with separate incoming / outgoing breakdowns.
 *
 * For each of our faction's members that appears as attacker OR defender in the
 * supplied attack set, produce:
 *   { memberId, memberName, incoming: {...}, outgoing: {...} }
 *
 * Each direction has the columns:
 *   { leaves, mugs, hosp, warHits, assists, losses, totalHits }
 *
 *   - OUTGOING rows (we are attacker) are filtered by defender_faction_id ∈ factionFilter.
 *   - INCOMING rows (we are defender) are filtered by attacker_faction_id ∈ factionFilter.
 *
 * @param {Array} attacks           - faction_attacks rows (war window)
 * @param {Set<number>|null} factionFilter - set of opposing faction IDs to include; pass `null` to include all
 * @returns {Array<object>}
 */
export function buildHitReport(attacks, factionFilter = null) {
  const rows = new Map() // memberId → row

  function ensure(memberId, memberName) {
    if (!rows.has(memberId)) {
      rows.set(memberId, {
        memberId,
        memberName,
        incoming: { leaves: 0, mugs: 0, hosp: 0, warHits: 0, assists: 0, losses: 0, totalHits: 0 },
        outgoing: { leaves: 0, mugs: 0, hosp: 0, warHits: 0, assists: 0, losses: 0, totalHits: 0 },
      })
    }
    return rows.get(memberId)
  }

  function inFilter(factionId) {
    if (!factionFilter) return true
    return factionFilter.has(Number(factionId) || 0)
  }

  for (const a of attacks) {
    const result = a.result || ''
    const isRankedWar = a.is_ranked_war === true || a.is_ranked_war === 'true' || a.is_ranked_war === 1
    const isIncoming = a.is_incoming === true || a.is_incoming === 'true' || a.is_incoming === 1

    // Determine which direction this attack contributes to and the opposing faction
    let direction, memberId, memberName, opposingFactionId
    if (isIncoming) {
      // We are defender → incoming
      if (a.defender_faction_id !== OUR_FACTION_ID) continue
      direction = 'incoming'
      memberId = a.defender_id
      memberName = a.defender_name
      opposingFactionId = a.attacker_faction_id
    } else {
      // We are attacker → outgoing
      if (a.attacker_faction_id !== OUR_FACTION_ID) continue
      direction = 'outgoing'
      memberId = a.attacker_id
      memberName = a.attacker_name
      opposingFactionId = a.defender_faction_id
    }

    if (!memberId) continue
    if (!inFilter(opposingFactionId)) continue

    const row = ensure(memberId, memberName)
    const bucket = row[direction]

    if (result === 'Assist') {
      bucket.assists += 1
      bucket.totalHits += 1
    } else if (result === 'Lost' || result === 'Timeout' || result === 'Interrupted' || result === 'Stalemate' || result === 'Escape') {
      bucket.losses += 1
      bucket.totalHits += 1
    } else if (WIN_RESULTS.has(result) || result === 'Special') {
      if (result === 'Mugged') bucket.mugs += 1
      else if (result === 'Hospitalized') bucket.hosp += 1
      else bucket.leaves += 1 // Attacked, Arrested, Looted, Special
      if (isRankedWar) bucket.warHits += 1
      bucket.totalHits += 1
    }
    // other results: ignored
  }

  return Array.from(rows.values()).sort((a, b) =>
    a.memberName.localeCompare(b.memberName)
  )
}

/**
 * Collect unique opposing faction IDs from a set of attacks (from our faction's perspective).
 */
export function collectOpposingFactionIds(attacks) {
  const ids = new Set()
  for (const a of attacks) {
    const isIncoming = a.is_incoming === true || a.is_incoming === 'true' || a.is_incoming === 1
    if (isIncoming) {
      if (a.defender_faction_id === OUR_FACTION_ID && a.attacker_faction_id) ids.add(Number(a.attacker_faction_id))
    } else {
      if (a.attacker_faction_id === OUR_FACTION_ID && a.defender_faction_id) ids.add(Number(a.defender_faction_id))
    }
  }
  return ids
}


/**
 * Calculate termed war payouts.
 * Members with score >= minScoreThreshold each receive flatPayoutAmount.
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
 * Calculate real war payouts using the exact spreadsheet formula.
 *
 * @param {Array} contributions - war_member_contributions rows (our faction only)
 * @param {Array} attacks       - faction_attacks rows (pre-filtered to war window)
 * @param {object} settings     - { rewardsItems, cachePrices, factionCutPercent }
 */
export function calculateRealWarPayouts(contributions, attacks, settings) {
  const {
    rewardsItems,
    cachePrices,
    factionCutPercent = 20,
    // Attack multipliers
    warHitMultiplier  =  1.25,
    assistMultiplier  =  0.50,
    lossMultiplier    =  0.50,
    mugMultiplier     = -1.00,
    // Weight split (must sum to 1; caller is responsible for normalising)
    participationWeight = 0.50,
    contributionWeight  = 0.50,
    // Adjustments applied to the member pool
    mercCost     = 0,
    reviverCost  = 0,
    factionTopUp = 0,
  } = settings

  const { totalCacheValue, breakdown } = calculateCacheValue(rewardsItems, cachePrices)
  // Order of ops: subtract mercs/revivers & add top-up from gross cache FIRST, then apply faction cut.
  const grossAfterCosts = Math.max(
    0,
    totalCacheValue - Number(mercCost) - Number(reviverCost) + Number(factionTopUp)
  )
  const basePool = Math.floor(grossAfterCosts * (1 - factionCutPercent / 100))
  const memberPool = basePool

  const attackStats = buildMemberAttackStats(attacks)

  // ── Step 1: raw per-member data ────────────────────────────────────
  const memberData = contributions.map(m => {
    const memberId = m.member_id
    const s = attackStats.get(memberId) ?? {
      leaves: 0, mugs: 0, hosp: 0, warHits: 0, won: 0, assists: 0, losses: 0, bonusRespect: 0,
    }

    // Participation score
    const warHitScore  = s.warHits * warHitMultiplier
    const mugScore     = s.mugs    * mugMultiplier
    const assistScore  = s.assists * assistMultiplier
    const lossScore    = s.losses  * lossMultiplier
    const participationScore = warHitScore + mugScore + assistScore + lossScore
    // regularHits (non-war wins) multiply at ×0, so they're shown but don't contribute

    // Contribution score
    const respectGained   = Number(m.score) || 0
    const bonusRespect    = Math.round(s.bonusRespect * 100) / 100
    const adjustedRespect = Math.max(0, respectGained - bonusRespect)

    return {
      memberId,
      memberName: m.member_name,
      // Hit report
      leaves:    s.leaves,
      mugs:      s.mugs,
      hosp:      s.hosp,
      warHits:   s.warHits,
      won:       s.won,
      assists:   s.assists,
      losses:    s.losses,
      totalHits: s.won + s.assists + s.losses,
      // Participation breakdown
      warHitScore:        Math.round(warHitScore        * 100) / 100,
      assistScore:        Math.round(assistScore        * 100) / 100,
      lossScore:          Math.round(lossScore          * 100) / 100,
      mugScore:           Math.round(mugScore           * 100) / 100,
      participationScore: Math.round(participationScore * 100) / 100,
      // Contribution breakdown
      respectGained,
      bonusRespect,
      adjustedRespect,
    }
  })

  // ── Step 2: shares ─────────────────────────────────────────────────
  // Members with negative participation score get 0 share (don't dilute the pool)
  const totalParticipation   = memberData.reduce((s, m) => s + Math.max(0, m.participationScore), 0)
  const totalAdjustedRespect = memberData.reduce((s, m) => s + m.adjustedRespect, 0)

  // ── Step 3: payouts ────────────────────────────────────────────────
  const members = memberData.map(m => {
    const participationShare = totalParticipation > 0
      ? Math.max(0, m.participationScore) / totalParticipation
      : 0
    const contributionShare = totalAdjustedRespect > 0
      ? m.adjustedRespect / totalAdjustedRespect
      : 0
    const effortShare = participationShare * participationWeight + contributionShare * contributionWeight
    const payoutAmount = Math.floor(effortShare * memberPool)
    const isEligible = payoutAmount > 0

    return {
      ...m,
      participationShare,
      contributionShare,
      effortShare,
      isEligible,
      payoutAmount,
    }
  })

  const totalPayout = members.reduce((s, m) => s + m.payoutAmount, 0)
  const totalWarHits = members.reduce((s, m) => s + (m.warHits || 0), 0)
  const payPerHit = totalWarHits > 0 ? Math.floor(totalPayout / totalWarHits) : 0

  return {
    members,
    totalPayout,
    cacheValue: totalCacheValue,
    cacheBreakdown: breakdown,
    memberPayoutPool: memberPool,
    basePool,
    mercCost: Number(mercCost) || 0,
    reviverCost: Number(reviverCost) || 0,
    factionTopUp: Number(factionTopUp) || 0,
    totalWarHits,
    payPerHit,
    overBudgetWarning: false, // formula distributes exactly the pool
  }
}


/**
 * Generate the Torn batch balance URL for war payouts.
 */
export function generateWarBatchPayoutURL(members) {
  const eligible = members.filter(m => m.isEligible && m.payoutAmount > 0)
  if (eligible.length === 0) return ''

  const uids    = eligible.map(m => m.memberId).join(',')
  const amounts = eligible.map(m => Math.floor(m.payoutAmount)).join(',')
  return `https://www.torn.com/factions.php?step=your#/tab=controls&batbal_uids=${uids}&batbal_amounts=${amounts}`
}


export function formatWarDate(timestamp) {
  if (!timestamp) return 'N/A'
  return new Date(timestamp * 1000).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
  })
}

export function formatWarDateRange(startAt, endAt) {
  const start = formatWarDate(startAt)
  if (!endAt || endAt === 0) return `${start} — Ongoing`
  return `${start} — ${formatWarDate(endAt)}`
}
