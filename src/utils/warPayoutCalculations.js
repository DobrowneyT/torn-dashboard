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
 *    afterCosts     = totalReward − mercCost − reviverCost
 *    factionCut     = floor(afterCosts × factionCutPercent / 100)
 *    memberPool     = afterCosts ��� factionCut + factionTopUp
 *
 *  TERMED WAR — FLAT SHARES
 *    memberPool     = totalReward − factionCut
 *    payout[i]      = floor((shares[i] / Σ shares) × memberPool)
 *
 *  TERMED WAR — SCALING (automatic shares)
 *    memberPool     = totalReward − factionCut
 *    preCutoffScore = Σ respect_gain for outgoing ranked-war wins before cutoff
 *    postCutoffScore= Σ respect_gain for outgoing ranked-war wins after cutoff
 *    baseShares[i]  = preCutoffScore ≥ threshold ? 1 : 0
 *    addlShares[i]  = postCutoffScore > 0 ? postCutoffScore / threshold : 0
 *    shares[i]      = baseShares[i] + addlShares[i]   (0 if manually ineligible)
 *    payout[i]      = floor((shares[i] / Σ shares) × memberPool)
 *    cutoffHours=0  → all score is post-cutoff → shares[i] = totalScore / threshold
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
 * Empty hit-bucket factory.  All counts mirror the columns shown in the
 * Hit Report and Payout Sheet so both views derive their numbers identically.
 */
function emptyHitBucket() {
  return {
    leaves: 0,
    mugs: 0,
    hosp: 0,
    warHits: 0,
    regularHits: 0,
    won: 0,
    assists: 0,
    losses: 0,
    totalHits: 0,
  }
}

/**
 * Apply a single attack's result to a bucket.  Shared by `buildMemberAttackStats`
 * and `buildHitReport` so both views agree on what counts as a win, loss, etc.
 *
 *   leaves     — wins where result ∈ {Attacked, Arrested, Looted, Special}
 *   mugs       — wins where result = Mugged
 *   hosp       — wins where result = Hospitalized
 *   warHits    — any win where is_ranked_war = true
 *   regularHits — any win where is_ranked_war = false
 *   won        — leaves + mugs + hosp
 *   assists    — result = Assist
 *   losses     — result ∈ {Lost, Timeout, Interrupted, Stalemate, Escape}
 *   totalHits  — won + assists + losses
 */
function applyAttackToBucket(bucket, attack) {
  const result = attack.result || ''
  const isRankedWar = attack.is_ranked_war === true || attack.is_ranked_war === 'true' || attack.is_ranked_war === 1

  if (result === 'Assist') {
    bucket.assists += 1
    bucket.totalHits += 1
  } else if (result === 'Lost' || result === 'Timeout' || result === 'Interrupted' || result === 'Stalemate' || result === 'Escape') {
    bucket.losses += 1
    bucket.totalHits += 1
  } else if (WIN_RESULTS.has(result) || result === 'Special') {
    bucket.won += 1
    if (result === 'Mugged') bucket.mugs += 1
    else if (result === 'Hospitalized') bucket.hosp += 1
    else bucket.leaves += 1  // Attacked, Arrested, Looted, Special

    if (isRankedWar) bucket.warHits += 1
    else bucket.regularHits += 1

    bucket.totalHits += 1
  }
  // Other results (unknown / future types) are ignored.
}


/**
 * Build per-member attack breakdown from faction_attacks rows within a war window.
 *
 * Only considers outgoing attacks by our faction (is_incoming=false, attacker_faction_id=OUR).
 * Uses `applyAttackToBucket` for counting so the Payout Sheet's Hit Report columns
 * match the dedicated Hit Report tab exactly.  Adds `bonusRespect` (the only
 * payout-specific field) on top.
 *
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
      stats.set(memberId, { ...emptyHitBucket(), bonusRespect: 0 })
    }

    const s = stats.get(memberId)
    applyAttackToBucket(s, attack)

    // Bonus respect tracking (payout-specific): only for ranked-war wins at bonus chain counts
    const result = attack.result || ''
    const isRankedWar = attack.is_ranked_war === true || attack.is_ranked_war === 'true' || attack.is_ranked_war === 1
    if (isRankedWar && (WIN_RESULTS.has(result) || result === 'Special')) {
      const chain = Number(attack.chain) || 0
      if (BONUS_HITS.has(chain)) {
        const respectGain = parseFloat(attack.respect_gain) || 0
        s.bonusRespect += Math.max(0, respectGain - 10)
      }
    }
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
        incoming: emptyHitBucket(),
        outgoing: emptyHitBucket(),
      })
    }
    return rows.get(memberId)
  }

  function inFilter(factionId) {
    if (!factionFilter) return true
    return factionFilter.has(Number(factionId) || 0)
  }

  for (const a of attacks) {
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
    applyAttackToBucket(row[direction], a)
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
 * Calculate per-member respect earned before and after a cutoff timestamp
 * from outgoing ranked-war wins.  Bonus chain hits (10, 25, 50, …) are
 * capped at 10 respect to prevent chain milestones from inflating shares.
 *
 * @param {Array} attacks          - faction_attacks rows (pre-filtered to war window)
 * @param {number} cutoffTimestamp - Unix timestamp (seconds); attacks with started <= cutoff are "pre"
 * @returns {Map<number, { preCutoffScore: number, postCutoffScore: number }>}
 */
export function calculateCutoffScores(attacks, cutoffTimestamp) {
  const scores = new Map()
  for (const a of attacks) {
    if (a.is_incoming === true || a.is_incoming === 'true' || a.is_incoming === 1) continue
    if (a.attacker_faction_id !== OUR_FACTION_ID) continue
    const isRankedWar = a.is_ranked_war === true || a.is_ranked_war === 'true' || a.is_ranked_war === 1
    if (!isRankedWar) continue
    const result = a.result || ''
    if (!WIN_RESULTS.has(result)) continue
    const rawRespect = parseFloat(a.respect_gain) || 0
    const chain = Number(a.chain) || 0
    // Cap bonus chain hits at 10 respect (same normalization as real war contribution score)
    const respect = BONUS_HITS.has(chain) ? Math.min(rawRespect, 10) : rawRespect
    const bonusCapped = rawRespect - respect
    const started = Number(a.started) || 0
    const id = a.attacker_id
    if (!scores.has(id)) scores.set(id, { preCutoffScore: 0, postCutoffScore: 0, bonusReduction: 0 })
    const s = scores.get(id)
    s.bonusReduction += bonusCapped
    if (started <= cutoffTimestamp) {
      s.preCutoffScore += respect
    } else {
      s.postCutoffScore += respect
    }
  }
  return scores
}


/**
 * Calculate termed war payouts.
 *
 * Supports two modes:
 *   - 'flat'    — pool split by shares (default 1 per eligible member, 2 for double pay)
 *   - 'scaling' — automatic shares: 1 base share if pre-cutoff score ≥ threshold,
 *                 plus postCutoffScore / threshold additional fractional shares.
 *                 Pool split by total shares.
 */
export function calculateTermedWarPayouts(contributions, settings) {
  const {
    totalReward = 0,
    factionCutPercent = 20,
    minScoreThreshold = 0,
    termedMode = 'flat',
    // Flat mode
    memberShares = {},        // { memberId: shareCount } — default 1 per eligible member
    // Scaling mode
    attacks = [],
    warStartAt = 0,
    cutoffHours = 24,
    // Manual eligibility overrides — members in this set get 0 shares/payout
    ineligibleMembers = new Set(),
  } = settings

  const totalCacheValue = Number(totalReward) || 0
  const factionCutAmount = Math.floor(totalCacheValue * (factionCutPercent / 100))
  const memberPayoutPool = Math.max(0, totalCacheValue - factionCutAmount)

  if (termedMode === 'scaling') {
    // ── Scaling mode ──────────────────────────────────────────────────
    // 1 base share if pre-cutoff score ≥ threshold, plus fractional
    // shares for post-cutoff score (postCutoffScore / threshold).
    const cutoffTimestamp = Number(warStartAt) + (Number(cutoffHours) * 3600)
    const cutoffScores = calculateCutoffScores(attacks, cutoffTimestamp)
    const threshold = Number(minScoreThreshold) || 1 // avoid division by zero

    const memberList = contributions.map(m => {
      const score = Number(m.score) || 0
      const manuallyIneligible = ineligibleMembers.has(m.member_id)
      const cs = cutoffScores.get(m.member_id) || { preCutoffScore: 0, postCutoffScore: 0, bonusReduction: 0 }
      // Base share (1) only if the member hit the threshold before the cutoff
      const baseShares = (!manuallyIneligible && cs.preCutoffScore >= threshold) ? 1 : 0
      // Post-cutoff fractional shares apply regardless of pre-cutoff performance —
      // members who missed the cutoff still earn proportional pay for what they did after
      const additionalShares = (!manuallyIneligible && cs.postCutoffScore > 0)
        ? cs.postCutoffScore / threshold
        : 0
      const shares = Math.round((baseShares + additionalShares) * 100) / 100
      const isEligible = !manuallyIneligible && shares > 0

      return {
        memberId: m.member_id,
        memberName: m.member_name,
        score,
        attacks: m.attacks || 0,
        isEligible,
        preCutoffScore: Math.round(cs.preCutoffScore * 100) / 100,
        postCutoffScore: Math.round(cs.postCutoffScore * 100) / 100,
        bonusReduction: Math.round((cs.bonusReduction ?? 0) * 100) / 100,
        shares,
      }
    })

    const totalShares = memberList.reduce((s, m) => s + m.shares, 0)

    const members = memberList.map(m => ({
      ...m,
      payoutAmount: totalShares > 0 ? Math.floor((m.shares / totalShares) * memberPayoutPool) : 0,
    }))

    const totalPayout = members.reduce((s, m) => s + m.payoutAmount, 0)

    return {
      members,
      totalPayout,
      cacheValue: totalCacheValue,
      memberPayoutPool,
      factionCutAmount,
      totalShares,
      cutoffTimestamp,
      overBudgetWarning: false,
    }
  }

  // ── Flat shares mode (default) ────────────────────────────────────
  const flatAttackStats = buildMemberAttackStats(attacks)

  const members = contributions.map(m => {
    const score = Number(m.score) || 0
    const isEligible = score >= Number(minScoreThreshold) && !ineligibleMembers.has(m.member_id)
    const shares = isEligible ? (Number(memberShares[m.member_id]) || 1) : 0
    const fs = flatAttackStats.get(m.member_id)
    const bonusReduction = fs ? Math.round(fs.bonusRespect * 100) / 100 : 0
    return {
      memberId: m.member_id,
      memberName: m.member_name,
      score,
      attacks: m.attacks || 0,
      isEligible,
      shares,
      bonusReduction,
    }
  })

  const totalShares = members.reduce((s, m) => s + m.shares, 0)
  const membersWithPayout = members.map(m => ({
    ...m,
    payoutAmount: totalShares > 0 ? Math.floor((m.shares / totalShares) * memberPayoutPool) : 0,
  }))

  const totalPayout = membersWithPayout.reduce((s, m) => s + m.payoutAmount, 0)

  return {
    members: membersWithPayout,
    totalPayout,
    cacheValue: totalCacheValue,
    memberPayoutPool,
    factionCutAmount,
    totalShares,
    overBudgetWarning: false,
  }
}


/**
 * Calculate real war payouts using the exact spreadsheet formula.
 *
 * @param {Array} contributions - war_member_contributions rows (our faction only)
 * @param {Array} attacks       - faction_attacks rows (pre-filtered to war window)
 * @param {object} settings     - { totalReward, factionCutPercent, ... }
 */
export function calculateRealWarPayouts(contributions, attacks, settings) {
  const {
    totalReward = 0,
    factionCutPercent = 20,
    // Attack multipliers (global defaults)
    warHitMultiplier     =  1.25,
    assistMultiplier     =  0.50,
    lossMultiplier       =  0.50,
    mugMultiplier        = -1.00,
    regularHitMultiplier =  0.00,
    // Per-member multiplier overrides: { [memberId]: { warHitMultiplier?: n, ... } }
    memberMultiplierOverrides = {},
    // Weight split (must sum to 1; caller is responsible for normalising)
    participationWeight = 0.50,
    contributionWeight  = 0.50,
    // Adjustments applied to the member pool
    mercCost     = 0,
    reviverCost  = 0,
    factionTopUp = 0,
    // Manual eligibility overrides — members in this set get 0 effort/payout
    ineligibleMembers = new Set(),
  } = settings

  const totalCacheValue = Number(totalReward) || 0
  // 1. Start with total reward
  // 2. Subtract mercenary and reviver costs
  const afterCosts = Math.max(0, totalCacheValue - Number(mercCost) - Number(reviverCost))
  // 3. Apply faction cut to that subtotal
  const factionCutAmount = Math.floor(afterCosts * (factionCutPercent / 100))
  const basePool = Math.max(0, afterCosts - factionCutAmount)
  // 4. Add faction top-up to member pool (after faction cut)
  const memberPool = basePool + Number(factionTopUp)

  const attackStats = buildMemberAttackStats(attacks)

  // ── Step 1: raw per-member data ────────────────────────────────────
  const memberData = contributions.map(m => {
    const memberId = m.member_id
    const s = attackStats.get(memberId) ?? { ...emptyHitBucket(), bonusRespect: 0 }

    // Resolve effective multipliers (per-member overrides fall back to globals)
    const overrides = memberMultiplierOverrides[memberId] || {}
    const effWarHitMult  = overrides.warHitMultiplier     ?? warHitMultiplier
    const effAssistMult  = overrides.assistMultiplier      ?? assistMultiplier
    const effLossMult    = overrides.lossMultiplier        ?? lossMultiplier
    const effMugMult     = overrides.mugMultiplier         ?? mugMultiplier
    const effRegularMult = overrides.regularHitMultiplier  ?? regularHitMultiplier

    // Participation score
    const warHitScore     = s.warHits     * effWarHitMult
    const regularHitScore = s.regularHits * effRegularMult
    const mugScore        = s.mugs        * effMugMult
    const assistScore     = s.assists     * effAssistMult
    const lossScore       = s.losses      * effLossMult
    const participationScore = warHitScore + regularHitScore + mugScore + assistScore + lossScore

    // Contribution score
    const respectGained   = Number(m.score) || 0
    const bonusRespect    = Math.round(s.bonusRespect * 100) / 100
    const adjustedRespect = Math.max(0, respectGained - bonusRespect)

    return {
      memberId,
      memberName: m.member_name,
      // Hit report
      leaves:      s.leaves,
      mugs:        s.mugs,
      hosp:        s.hosp,
      warHits:     s.warHits,
      regularHits: s.regularHits,
      won:         s.won,
      assists:     s.assists,
      losses:      s.losses,
      totalHits:   s.totalHits,
      // Effective multipliers (for UI display / per-member override columns)
      effWarHitMult,
      effAssistMult,
      effLossMult,
      effMugMult,
      effRegularMult,
      // Participation breakdown
      warHitScore:        Math.round(warHitScore        * 100) / 100,
      regularHitScore:    Math.round(regularHitScore    * 100) / 100,
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
  // Ineligible members (manually toggled off) are excluded from totals so the pool redistributes
  const eligible = memberData.filter(m => !ineligibleMembers.has(m.memberId))
  const totalParticipation   = eligible.reduce((s, m) => s + Math.max(0, m.participationScore), 0)
  const totalAdjustedRespect = eligible.reduce((s, m) => s + m.adjustedRespect, 0)

  // ── Step 3: payouts ────────────────────────────────────────────────
  const members = memberData.map(m => {
    const isManuallyIneligible = ineligibleMembers.has(m.memberId)
    const participationShare = (!isManuallyIneligible && totalParticipation > 0)
      ? Math.max(0, m.participationScore) / totalParticipation
      : 0
    const contributionShare = (!isManuallyIneligible && totalAdjustedRespect > 0)
      ? m.adjustedRespect / totalAdjustedRespect
      : 0
    const effortShare = participationShare * participationWeight + contributionShare * contributionWeight
    const payoutAmount = Math.floor(effortShare * memberPool)
    const isEligible = !isManuallyIneligible && payoutAmount > 0

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
  // Sum of every member's Total hits (won + assists + losses) — matches the
  // "Total" column shown in the Hit Report.
  const totalWarHits = members.reduce((s, m) => s + (m.totalHits || 0), 0)
  const payPerHit = totalWarHits > 0 ? Math.floor(totalPayout / totalWarHits) : 0

  return {
    members,
    totalPayout,
    cacheValue: totalCacheValue,
    memberPayoutPool: memberPool,
    basePool,
    factionCutAmount,
    mercCost: Number(mercCost) || 0,
    reviverCost: Number(reviverCost) || 0,
    factionTopUp: Number(factionTopUp) || 0,
    totalWarHits,
    payPerHit,
    overBudgetWarning: false, // formula distributes exactly the pool
  }
}


/**
 * Detect the race cutoff timestamp — the moment either faction reaches the target score.
 *
 * Walks ALL attacks sorted by `started` ascending.  For each ranked-war WIN:
 *   - Outgoing (our faction attacking): add respect_gain to our tally
 *   - Incoming (opponent attacking us with a win): add respect_gain to opposing tally
 *
 * Bonus chain hits use FULL respect_gain (not normalized) because the war report
 * score includes the bonus.
 *
 * @param {Array}  attacks     - faction_attacks rows (full war window, both directions)
 * @param {number} targetScore - score threshold (e.g. 500)
 * @returns {number|null} Unix timestamp when either tally crossed target, or null
 */
export function detectRaceCutoff(attacks, targetScore) {
  if (!targetScore || targetScore <= 0) return null

  const sorted = [...attacks].sort((a, b) => (Number(a.started) || 0) - (Number(b.started) || 0))
  let ourScore = 0
  let opposingScore = 0

  for (const a of sorted) {
    const result = a.result || ''
    if (!WIN_RESULTS.has(result)) continue
    const isRankedWar = a.is_ranked_war === true || a.is_ranked_war === 'true' || a.is_ranked_war === 1
    if (!isRankedWar) continue

    const respect = parseFloat(a.respect_gain) || 0
    const isIncoming = a.is_incoming === true || a.is_incoming === 'true' || a.is_incoming === 1

    if (!isIncoming && a.attacker_faction_id === OUR_FACTION_ID) {
      ourScore += respect
    } else if (isIncoming && a.defender_faction_id === OUR_FACTION_ID) {
      opposingScore += respect
    }

    if (ourScore >= targetScore || opposingScore >= targetScore) {
      return Number(a.started) || 0
    }
  }

  return null
}


/**
 * Calculate race war payouts — hybrid real + termed.
 *
 * Splits attacks into pre-cutoff and post-cutoff windows.
 * Pre-cutoff pool uses the real war formula (participation + contribution).
 * Post-cutoff pool uses the termed formula (flat shares or scaling).
 *
 * @param {Array}  contributions - war_member_contributions rows (our faction only)
 * @param {Array}  attacks       - faction_attacks rows (pre-filtered to war window)
 * @param {object} settings      - combined real + termed + race settings
 */
export function calculateRaceWarPayouts(contributions, attacks, settings) {
  const {
    totalReward = 0,
    factionCutPercent = 20,
    mercCost     = 0,
    reviverCost  = 0,
    factionTopUp = 0,
    // Race-specific
    raceCutoffTimestamp,
    racePreCutoffPercent = 50,
    racePostCutoffMode = 'flat',  // 'flat' | 'scaling'
    // Real-war multipliers (for pre-cutoff)
    warHitMultiplier     =  1.25,
    assistMultiplier     =  0.50,
    lossMultiplier       =  0.50,
    mugMultiplier        = -1.00,
    regularHitMultiplier =  0.00,
    memberMultiplierOverrides = {},
    participationWeight = 0.50,
    contributionWeight  = 0.50,
    // Termed settings (for post-cutoff)
    memberShares = {},
    minScoreThreshold = 0,
    cutoffHours = 24,
    // Manual eligibility overrides
    ineligibleMembers = new Set(),
  } = settings

  const totalCacheValue = Number(totalReward) || 0
  const afterCosts = Math.max(0, totalCacheValue - Number(mercCost) - Number(reviverCost))
  const factionCutAmount = Math.floor(afterCosts * (factionCutPercent / 100))
  const basePool = Math.max(0, afterCosts - factionCutAmount)
  const memberPool = basePool + Number(factionTopUp)

  const cutoff = Number(raceCutoffTimestamp) || 0
  const preCutoffPool = Math.floor(memberPool * (Number(racePreCutoffPercent) / 100))
  const postCutoffPool = memberPool - preCutoffPool

  // Split attacks into pre/post cutoff
  const preAttacks = attacks.filter(a => (Number(a.started) || 0) <= cutoff)
  const postAttacks = attacks.filter(a => (Number(a.started) || 0) > cutoff)

  // ── Pre-cutoff: real war formula ──────────────────────────────────
  const preResult = calculateRealWarPayouts(contributions, preAttacks, {
    totalReward: preCutoffPool,  // Directly use as pool (no cuts — already applied)
    factionCutPercent: 0,
    mercCost: 0,
    reviverCost: 0,
    factionTopUp: 0,
    warHitMultiplier,
    assistMultiplier,
    lossMultiplier,
    mugMultiplier,
    regularHitMultiplier,
    memberMultiplierOverrides,
    participationWeight,
    contributionWeight,
    ineligibleMembers,
  })

  // ── Post-cutoff: termed formula ───────────────────────────────────
  const postResult = calculateTermedWarPayouts(contributions, {
    totalReward: postCutoffPool,  // Directly use as pool
    factionCutPercent: 0,
    minScoreThreshold,
    termedMode: racePostCutoffMode,
    memberShares,
    attacks: postAttacks,
    warStartAt: cutoff,  // post-cutoff "start" is the cutoff itself
    cutoffHours,
    ineligibleMembers,
  })

  // ── Combine per-member results ────────────────────────────────────
  const preByMember = new Map(preResult.members.map(m => [m.memberId, m]))
  const postByMember = new Map(postResult.members.map(m => [m.memberId, m]))

  // Hit Report columns must reflect the full war window (pre + post cutoff),
  // not just pre-cutoff.  Build stats from the entire (filtered) attack set.
  const fullStats = buildMemberAttackStats(attacks)

  const members = contributions.map(m => {
    const memberId = m.member_id
    const pre = preByMember.get(memberId) || { payoutAmount: 0 }
    const post = postByMember.get(memberId) || { payoutAmount: 0, shares: 0 }
    const full = fullStats.get(memberId) ?? { ...emptyHitBucket(), bonusRespect: 0 }

    return {
      // Carry participation/contribution score fields from pre-cutoff result
      ...pre,
      memberId,
      memberName: m.member_name,
      // Hit Report columns: full war window
      leaves:      full.leaves,
      mugs:        full.mugs,
      hosp:        full.hosp,
      warHits:     full.warHits,
      regularHits: full.regularHits,
      won:         full.won,
      assists:     full.assists,
      losses:      full.losses,
      totalHits:   full.totalHits,
      // Race-specific breakdowns
      preCutoffPayout: pre.payoutAmount,
      postCutoffPayout: post.payoutAmount,
      postCutoffShares: post.shares || 0,
      payoutAmount: pre.payoutAmount + post.payoutAmount,
      isEligible: !ineligibleMembers.has(memberId) && (pre.payoutAmount + post.payoutAmount) > 0,
    }
  })

  const totalPayout = members.reduce((s, m) => s + m.payoutAmount, 0)
  const totalWarHits = members.reduce((s, m) => s + (m.totalHits || 0), 0)
  const payPerHit = totalWarHits > 0 ? Math.floor(totalPayout / totalWarHits) : 0

  return {
    members,
    totalPayout,
    cacheValue: totalCacheValue,
    memberPayoutPool: memberPool,
    basePool,
    factionCutAmount,
    mercCost: Number(mercCost) || 0,
    reviverCost: Number(reviverCost) || 0,
    factionTopUp: Number(factionTopUp) || 0,
    preCutoffPool,
    postCutoffPool,
    raceCutoffTimestamp: cutoff,
    totalWarHits,
    payPerHit,
    overBudgetWarning: false,
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
