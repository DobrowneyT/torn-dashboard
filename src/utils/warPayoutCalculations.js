/**
 * War Payout Calculations
 *
 * Exact formula matching the faction DL War Pay spreadsheet:
 *
 *  PARTICIPATION (from faction_attacks outgoing hits) — non-overlapping
 *  categories so each column is one count × one multiplier with no
 *  double-counting:
 *    War hit  (is_ranked_war=true, won, NOT mugged)         × 1.25
 *    Assist   (is_ranked_war=true, result='Assist')         × 0.50
 *    Loss     (is_ranked_war=true, result ∈ Lost/Timeout/…) × 0.50
 *    War Mug  (is_ranked_war=true, result='Mugged')         × −1.00 (standalone, NOT additive)
 *    Outside  (is_ranked_war=false, any win type)           × 0.00
 *
 *    participationShare[i] = max(0, score[i]) / Σ max(0, score[j])
 *
 *  Non-war assists/losses are NOT scored. Non-war mugs fall into Outside
 *  along with non-war leaves/hosp — the type distinction only matters
 *  inside a war hit, where mugs are penalised for delivering less respect.
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
export const WIN_RESULTS = new Set(['Attacked', 'Mugged', 'Hospitalized', 'Arrested', 'Looted'])

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
    // Raw totals — surfaced by the Hit Report tab so leaders see the full
    // result-type breakdown regardless of war/non-war context.
    leaves: 0,
    mugs: 0,
    hosp: 0,
    warHits: 0,         // any win where is_ranked_war = true (includes war mugs)
    regularHits: 0,     // any win where is_ranked_war = false (all non-war wins)
    won: 0,             // leaves + mugs + hosp
    assists: 0,         // result = Assist (war + non-war)
    losses: 0,          // result ∈ Lost/Timeout/... (war + non-war)
    totalHits: 0,
    // War-scoped slices — used by the Participation calculator so that
    //   • mug penalty applies only to mugs that happened during a war hit
    //   • assist/loss credit applies only when the attack was a war hit
    //   • non-war wins (regularHits) are grouped as "outside hits" with no
    //     result-type distinction
    warMugs: 0,         // wins where result = Mugged AND is_ranked_war = true
    warAssists: 0,      // assists where is_ranked_war = true
    warLosses: 0,       // losses where is_ranked_war = true
  }
}

/**
 * Apply a single attack's result to a bucket.  Shared by `buildMemberAttackStats`
 * and `buildHitReport` so both views agree on what counts as a win, loss, etc.
 *
 * See `emptyHitBucket` for the meaning of each field. The war-scoped slices
 * (warMugs / warAssists / warLosses) are populated here so the Participation
 * calculator can score non-overlapping columns.
 */
function applyAttackToBucket(bucket, attack) {
  const result = attack.result || ''
  const isRankedWar = attack.is_ranked_war === true || attack.is_ranked_war === 'true' || attack.is_ranked_war === 1

  if (result === 'Assist') {
    bucket.assists += 1
    if (isRankedWar) bucket.warAssists += 1
    bucket.totalHits += 1
  } else if (result === 'Lost' || result === 'Timeout' || result === 'Interrupted' || result === 'Stalemate' || result === 'Escape') {
    bucket.losses += 1
    if (isRankedWar) bucket.warLosses += 1
    bucket.totalHits += 1
  } else if (WIN_RESULTS.has(result) || result === 'Special') {
    bucket.won += 1
    if (result === 'Mugged') bucket.mugs += 1
    else if (result === 'Hospitalized') bucket.hosp += 1
    else bucket.leaves += 1  // Attacked, Arrested, Looted, Special

    if (isRankedWar) {
      bucket.warHits += 1
      if (result === 'Mugged') bucket.warMugs += 1
    } else {
      bucket.regularHits += 1
    }

    bucket.totalHits += 1
  }
  // Other results (unknown / future types) are ignored.
}

/**
 * Distribute the integer remainder (pool − Σ payoutAmount) to eligible members
 * top-down by getSortValue descending, adding $1 each until exhausted.
 * Only members with payoutAmount > 0 are eligible for a bump.
 * Returns a new array; does not mutate.
 */
function distributeRemainder(members, pool, getSortValue) {
  const remainder = pool - members.reduce((s, m) => s + (m.payoutAmount || 0), 0)
  if (remainder <= 0) return members

  // Only eligible (non-zero payout) members can receive a bump
  const eligible = members
    .map((m, idx) => ({ idx, v: getSortValue(m) }))
    .filter(e => members[e.idx].payoutAmount > 0)
    .sort((a, b) => b.v - a.v)

  const bump = new Set(eligible.slice(0, remainder).map(e => e.idx))
  return members.map((m, idx) => bump.has(idx) ? { ...m, payoutAmount: m.payoutAmount + 1 } : m)
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
    // Manual eligibility overrides
    ineligibleMembers = new Set(),    // members forced to 0 shares/payout
    forceEligibleMembers = new Set(), // members eligible regardless of threshold
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
      const forceEligible = forceEligibleMembers.has(m.member_id)
      const cs = cutoffScores.get(m.member_id) || { preCutoffScore: 0, postCutoffScore: 0, bonusReduction: 0 }
      // Base share (1) only if the member hit the threshold before the cutoff
      const baseShares = (!manuallyIneligible && cs.preCutoffScore >= threshold) ? 1 : 0
      // Post-cutoff fractional shares apply regardless of pre-cutoff performance —
      // members who missed the cutoff still earn proportional pay for what they did after
      const additionalShares = (!manuallyIneligible && cs.postCutoffScore > 0)
        ? cs.postCutoffScore / threshold
        : 0
      const shares = Math.round((baseShares + additionalShares) * 100) / 100
      const isEligible = forceEligible || (!manuallyIneligible && shares > 0)

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

    const members = distributeRemainder(
      memberList.map(m => ({
        ...m,
        payoutAmount: totalShares > 0 ? Math.floor((m.shares / totalShares) * memberPayoutPool) : 0,
      })),
      memberPayoutPool,
      m => m.shares
    )

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
    const isEligible = forceEligibleMembers.has(m.member_id)
      || (score >= Number(minScoreThreshold) && !ineligibleMembers.has(m.member_id))
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
  const membersWithPayout = distributeRemainder(
    members.map(m => ({
      ...m,
      payoutAmount: totalShares > 0 ? Math.floor((m.shares / totalShares) * memberPayoutPool) : 0,
    })),
    memberPayoutPool,
    m => m.shares
  )

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

    // Participation score — non-overlapping categories:
    //   • War Hit  = war wins that aren't mugs (warHits − warMugs)
    //   • War Mug  = war wins that are mugs (was: any mug, war or non-war —
    //                that double-counted non-war mugs against regularHits)
    //   • Assist   = war assists only (non-war assists are ignored)
    //   • Loss     = war losses only (non-war losses are ignored)
    //   • Outside  = all non-war wins, type-agnostic (regularHits)
    // NOTE: mugMultiplier is now standalone (per-mug score), not additive on
    // top of warHitMultiplier as it was pre-fix. A leader who had mugMult=-1
    // expecting a 0.25 net (1.25 + -1) will now see -1 per war mug — they
    // should set mugMult ≈ 0.25 for the equivalent effective weight.
    const warNonMugHits   = Math.max(0, s.warHits - s.warMugs)
    const warHitScore     = warNonMugHits * effWarHitMult
    const regularHitScore = s.regularHits * effRegularMult
    const mugScore        = s.warMugs     * effMugMult
    const assistScore     = s.warAssists  * effAssistMult
    const lossScore       = s.warLosses   * effLossMult
    const participationScore = warHitScore + regularHitScore + mugScore + assistScore + lossScore

    // Contribution score
    const respectGained   = Number(m.score) || 0
    const bonusRespect    = Math.round(s.bonusRespect * 100) / 100
    const adjustedRespect = Math.max(0, respectGained - bonusRespect)

    return {
      memberId,
      memberName: m.member_name,
      // Hit report (raw totals — all attacks, war + non-war)
      leaves:      s.leaves,
      mugs:        s.mugs,
      hosp:        s.hosp,
      warHits:     s.warHits,
      regularHits: s.regularHits,
      won:         s.won,
      assists:     s.assists,
      losses:      s.losses,
      totalHits:   s.totalHits,
      // War-scoped slices used by the Participation calculator
      warMugs:     s.warMugs,
      warAssists:  s.warAssists,
      warLosses:   s.warLosses,
      // Count actually scored under the War Hit multiplier (war wins ex-mugs)
      warNonMugHits,
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

  const membersD = distributeRemainder(members, memberPool, m => m.totalHits || 0)
  const totalPayout = membersD.reduce((s, m) => s + m.payoutAmount, 0)
  // Sum of every member's Total hits (won + assists + losses) — matches the
  // "Total" column shown in the Hit Report.
  const totalWarHits = membersD.reduce((s, m) => s + (m.totalHits || 0), 0)
  const payPerHit = totalWarHits > 0 ? Math.floor(totalPayout / totalWarHits) : 0

  return {
    members: membersD,
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
    overBudgetWarning: false,
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
 * Sum raw outgoing ranked-war WIN respect per member within an attack window.
 *
 * This is the same metric Torn reports as each member's war contribution `score`
 * in the post-war `rankedwarreport` (raw respect, INCLUDING chain-bonus
 * inflation — no normalization), so it doubles as:
 *   • the windowed "contribution" score fed to the real-war formula for each
 *     race sub-period (pre / post cutoff), and
 *   • the attack-derived figure we cross-check against the official
 *     `war_member_contributions.score` once the report lands.
 *
 * NOTE: deliberately NOT bonus-capped (unlike loadLiveContributionsFromAttacks'
 * leaderboard score) — the official score it mirrors is uncapped.
 *
 * @param {Array} attacks - faction_attacks rows
 * @returns {Map<number, number>} memberId → Σ raw respect_gain
 */
export function deriveWarScoresByMember(attacks) {
  const m = new Map()
  for (const a of attacks) {
    const isIncoming = a.is_incoming === true || a.is_incoming === 'true' || a.is_incoming === 1
    if (isIncoming || a.attacker_faction_id !== OUR_FACTION_ID) continue
    if (!WIN_RESULTS.has(a.result || '')) continue
    const isRankedWar = a.is_ranked_war === true || a.is_ranked_war === 'true' || a.is_ranked_war === 1
    if (!isRankedWar) continue
    const id = a.attacker_id
    m.set(id, (m.get(id) || 0) + (parseFloat(a.respect_gain) || 0))
  }
  return m
}

// Back-compat alias for the race engine's per-window contribution.
const windowedRespectByMember = deriveWarScoresByMember


/**
 * Cross-check our attack-derived war scores against Torn's official
 * `war_member_contributions` report.
 *
 * Both figures are RAW respect (Σ respect_gain for outgoing ranked-war wins ==
 * the official per-member score), so a meaningful gap means our scraped
 * `faction_attacks` are incomplete for the window (missed attacks, attribution
 * gaps, or report timing) — exactly the kind of error leaders want flagged
 * before trusting a payout.
 *
 * A row is flagged only when BOTH thresholds are exceeded, so rounding and
 * tiny-score noise don't spam the warning:
 *   |derived − api| >= toleranceAbs  AND  |pct| >= tolerancePct
 *
 * @param {Array} apiContributions - war_member_contributions rows (our faction)
 * @param {Array} attacks          - faction_attacks rows (war window)
 * @param {object} [opts]
 * @param {number} [opts.tolerancePct=0.02] - fractional tolerance (0.02 = 2%)
 * @param {number} [opts.toleranceAbs=10]   - absolute respect tolerance
 * @returns {{ rows: Array, flaggedRows: Array, hasDiscrepancies: boolean,
 *             apiTotal: number, derivedTotal: number, totalDiff: number }}
 */
export function compareContributionSources(apiContributions, attacks, opts = {}) {
  const { tolerancePct = 0.02, toleranceAbs = 10 } = opts
  const derived = deriveWarScoresByMember(attacks)

  // Names: prefer the API row, fall back to whatever the attack data carried.
  const names = new Map()
  for (const c of apiContributions || []) {
    if (c.member_id != null) names.set(Number(c.member_id), c.member_name)
  }
  for (const a of attacks || []) {
    const isIncoming = a.is_incoming === true || a.is_incoming === 'true' || a.is_incoming === 1
    if (isIncoming || a.attacker_faction_id !== OUR_FACTION_ID) continue
    const id = Number(a.attacker_id)
    if (id && !names.has(id)) names.set(id, a.attacker_name)
  }

  const apiById = new Map()
  for (const c of apiContributions || []) {
    if (c.member_id != null) apiById.set(Number(c.member_id), Number(c.score) || 0)
  }

  const ids = new Set([...apiById.keys(), ...derived.keys()])
  const rows = []
  for (const id of ids) {
    const apiScore = apiById.get(id) || 0
    const derivedScore = Math.round((derived.get(id) || 0) * 100) / 100
    const diff = Math.round((derivedScore - apiScore) * 100) / 100
    const pct = apiScore !== 0 ? diff / apiScore : (derivedScore !== 0 ? 1 : 0)
    const flagged = Math.abs(diff) >= toleranceAbs && Math.abs(pct) >= tolerancePct
    rows.push({
      memberId: id,
      memberName: names.get(id) || `#${id}`,
      apiScore,
      derivedScore,
      diff,
      pct,
      flagged,
    })
  }

  rows.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))
  const flaggedRows = rows.filter(r => r.flagged)
  const apiTotal = [...apiById.values()].reduce((s, v) => s + v, 0)
  const derivedTotal = [...derived.values()].reduce((s, v) => s + v, 0)

  return {
    rows,
    flaggedRows,
    hasDiscrepancies: flaggedRows.length > 0,
    apiTotal: Math.round(apiTotal * 100) / 100,
    derivedTotal: Math.round(derivedTotal * 100) / 100,
    totalDiff: Math.round((derivedTotal - apiTotal) * 100) / 100,
  }
}

/**
 * Flat-shares distribution for a window's pool. Returns a `{ members }` result
 * shaped like calculateRealWarPayouts so the race combiner can treat it uniformly.
 *
 * Two sub-modes:
 *   • Flat (scaleEnabled = false): every member whose windowed score meets the
 *     threshold gets 1 equal share.
 *   • Flat-then-scale (scaleEnabled = true): 1 base share for reaching the
 *     threshold within `scaleHours` of war start, plus `scoreAfter / threshold`
 *     fractional shares for score earned after that mark. (Mirrors the old
 *     Termed scaling mode.)
 *
 * Score is bonus-chain-normalized respect from outgoing ranked-war wins
 * (via calculateCutoffScores), consistent with the rest of the payout math.
 */
function flatWindowResult(contributions, windowAttacks, pool, opts = {}) {
  const {
    threshold = 0, scaleEnabled = false, scaleHours = 24,
    warStartAt = 0, ineligibleMembers = new Set(),
  } = opts
  const stats = buildMemberAttackStats(windowAttacks)
  // When scaling, split the window at warStart + scaleHours; otherwise everything
  // counts as "within" so total score = within.
  const innerCutoff = scaleEnabled ? (Number(warStartAt) + Number(scaleHours) * 3600) : Number.MAX_SAFE_INTEGER
  const cutoffScores = calculateCutoffScores(windowAttacks, innerCutoff)
  const thr = Number(threshold) || 0

  const memberList = contributions.map(m => {
    const id = m.member_id
    const s = stats.get(id) ?? { ...emptyHitBucket(), bonusRespect: 0 }
    const cs = cutoffScores.get(id) || { preCutoffScore: 0, postCutoffScore: 0, bonusReduction: 0 }
    const within = cs.preCutoffScore     // score within threshold period (all of it when no scaling)
    const after  = cs.postCutoffScore    // score after the N-hour mark (0 when no scaling)
    const totalScore = within + after
    const manuallyIneligible = ineligibleMembers.has(id)

    let baseShares, additionalShares
    if (scaleEnabled) {
      baseShares = (!manuallyIneligible && within >= thr) ? 1 : 0
      additionalShares = (!manuallyIneligible && after > 0 && thr > 0) ? after / thr : 0
    } else {
      const meets = thr > 0 ? totalScore >= thr : totalScore > 0
      baseShares = (!manuallyIneligible && meets) ? 1 : 0
      additionalShares = 0
    }
    const shares = Math.round((baseShares + additionalShares) * 100) / 100

    return {
      memberId: id,
      memberName: m.member_name,
      leaves: s.leaves, mugs: s.mugs, hosp: s.hosp, warHits: s.warHits, regularHits: s.regularHits,
      won: s.won, assists: s.assists, losses: s.losses, totalHits: s.totalHits,
      warMugs: s.warMugs, warAssists: s.warAssists, warLosses: s.warLosses,
      warNonMugHits: Math.max(0, s.warHits - s.warMugs),
      score: Math.round(totalScore * 100) / 100,
      scoreWithin: Math.round(within * 100) / 100,
      scoreAfter: Math.round(after * 100) / 100,
      baseShares, additionalShares, shares,
      respectGained: Math.round(totalScore * 100) / 100,
      isEligible: !manuallyIneligible && shares > 0,
    }
  })

  const totalShares = memberList.reduce((s, m) => s + m.shares, 0)
  const withPay = memberList.map(m => ({
    ...m,
    payoutAmount: totalShares > 0 ? Math.floor((m.shares / totalShares) * pool) : 0,
  }))
  return { members: distributeRemainder(withPay, pool, m => m.shares), totalShares }
}

/**
 * Calculate race war payouts — two symmetric real-war calculations.
 *
 * The member pool is split into a pre-cutoff pool and a post-cutoff pool (by
 * `racePreCutoffPercent`). Each window is then run through the SAME real-war
 * formula (participation + contribution) but with its OWN multiplier set and
 * weight, so leaders can, e.g., pay regular/non-war hits during the war but
 * zero them out after the cutoff — without filtering any attacks out.
 *
 * Contribution per window = raw outgoing ranked-war respect earned in that
 * window (not the full-war API score), so pre and post don't double-count.
 *
 * @param {Array}  contributions - war_member_contributions rows (our faction only)
 * @param {Array}  attacks       - faction_attacks rows (pre-filtered to war window)
 * @param {object} settings      - combined real + race settings
 */
export function calculateRaceWarPayouts(contributions, attacks, settings) {
  const {
    totalReward = 0,
    factionCutPercent = 20,
    mercCost     = 0,
    reviverCost  = 0,
    factionTopUp = 0,
    raceCutoffTimestamp,
    racePreCutoffPercent = 50,
    // Pre-cutoff formula
    warHitMultiplier     =  1.00,
    assistMultiplier     =  0.50,
    lossMultiplier       =  0.50,
    mugMultiplier        =  0.00,
    regularHitMultiplier =  1.00,
    participationWeight  =  0.50,
    contributionWeight   =  0.50,
    memberMultiplierOverrides = {},
    // Post-cutoff formula (its own independent set)
    postWarHitMultiplier     =  1.00,
    postAssistMultiplier     =  0.50,
    postLossMultiplier       =  0.50,
    postMugMultiplier        =  0.00,
    postRegularHitMultiplier =  0.00,
    postParticipationWeight  =  0.50,
    postContributionWeight   =  0.50,
    postMemberMultiplierOverrides = {},
    // Post-cutoff distribution: 'formula' (participation+contribution) or 'flat'
    // (equal shares above a score threshold, optionally flat-then-scale).
    postDistMode    = 'formula',
    postFlatThreshold = 0,
    postScaleEnabled  = false,
    postScaleHours    = 24,
    warStartAt        = 0,
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

  // Partition attacks at the cutoff (started <= cutoff is "pre").
  const preAttacks = attacks.filter(a => (Number(a.started) || 0) <= cutoff)
  const postAttacks = attacks.filter(a => (Number(a.started) || 0) > cutoff)

  // Windowed contribution: each window's real-war calc sees only the respect
  // earned in that window (overrides the full-war API score per member).
  const preRespect = windowedRespectByMember(preAttacks)
  const postRespect = windowedRespectByMember(postAttacks)
  const preContribs  = contributions.map(c => ({ ...c, score: preRespect.get(c.member_id) || 0 }))
  const postContribs = contributions.map(c => ({ ...c, score: postRespect.get(c.member_id) || 0 }))

  // ── Pre-cutoff: real-war formula with the pre multiplier set ──────────
  const preResult = calculateRealWarPayouts(preContribs, preAttacks, {
    totalReward: preCutoffPool, factionCutPercent: 0, mercCost: 0, reviverCost: 0, factionTopUp: 0,
    warHitMultiplier, assistMultiplier, lossMultiplier, mugMultiplier, regularHitMultiplier,
    memberMultiplierOverrides, participationWeight, contributionWeight, ineligibleMembers,
  })

  // ── Post-cutoff: either the real-war formula or flat-shares distribution ──
  const postResult = postDistMode === 'flat'
    ? flatWindowResult(contributions, postAttacks, postCutoffPool, {
        threshold: postFlatThreshold, scaleEnabled: postScaleEnabled, scaleHours: postScaleHours,
        warStartAt, ineligibleMembers,
      })
    : calculateRealWarPayouts(postContribs, postAttacks, {
        totalReward: postCutoffPool, factionCutPercent: 0, mercCost: 0, reviverCost: 0, factionTopUp: 0,
        warHitMultiplier: postWarHitMultiplier,
        assistMultiplier: postAssistMultiplier,
        lossMultiplier: postLossMultiplier,
        mugMultiplier: postMugMultiplier,
        regularHitMultiplier: postRegularHitMultiplier,
        memberMultiplierOverrides: postMemberMultiplierOverrides,
        participationWeight: postParticipationWeight,
        contributionWeight: postContributionWeight,
        ineligibleMembers,
      })

  // ── Combine per-member results ────────────────────────────────────
  const preByMember = new Map(preResult.members.map(m => [m.memberId, m]))
  const postByMember = new Map(postResult.members.map(m => [m.memberId, m]))

  const members = contributions.map(m => {
    const memberId = m.member_id
    const pre  = preByMember.get(memberId)  || { payoutAmount: 0 }
    const post = postByMember.get(memberId) || { payoutAmount: 0 }
    const prePay = pre.payoutAmount || 0
    const postPay = post.payoutAmount || 0

    return {
      memberId,
      memberName: m.member_name,
      // Full per-window real-war breakdowns (hit report + participation + contribution).
      pre,
      post,
      // Top-level convenience fields (full window = pre + post) for sorting / totals.
      leaves:        (pre.leaves || 0) + (post.leaves || 0),
      mugs:          (pre.mugs || 0) + (post.mugs || 0),
      hosp:          (pre.hosp || 0) + (post.hosp || 0),
      warHits:       (pre.warHits || 0) + (post.warHits || 0),
      regularHits:   (pre.regularHits || 0) + (post.regularHits || 0),
      won:           (pre.won || 0) + (post.won || 0),
      assists:       (pre.assists || 0) + (post.assists || 0),
      losses:        (pre.losses || 0) + (post.losses || 0),
      totalHits:     (pre.totalHits || 0) + (post.totalHits || 0),
      warMugs:       (pre.warMugs || 0) + (post.warMugs || 0),
      warAssists:    (pre.warAssists || 0) + (post.warAssists || 0),
      warLosses:     (pre.warLosses || 0) + (post.warLosses || 0),
      warNonMugHits: (pre.warNonMugHits || 0) + (post.warNonMugHits || 0),
      respectGained: (pre.respectGained || 0) + (post.respectGained || 0),
      // Payout breakdown.
      preCutoffPayout: prePay,
      postCutoffPayout: postPay,
      payoutAmount: prePay + postPay,
      isEligible: !ineligibleMembers.has(memberId) && (prePay + postPay) > 0,
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
