import { config } from '../config'

/**
 * Calculate a member's progress toward each tier based on their CPR data.
 *
 * The 2/3 rule: a member must meet at least ceil(2/3 * requirements.length)
 * of a tier's requirements to qualify.
 *
 * @param {Object} cprByRole - { [difficulty_level]: { [role_name]: cpr_value } }
 * @param {number} currentTier - The member's current tier (1-6)
 * @returns {Object} { currentTier, qualifiedTiers, nextTier, nextTierProgress, allTierProgress }
 */
export function calculateTierProgress(cprByRole, currentTier) {
  const tierRequirements = config.tierRequirements
  const allTierProgress = {}

  for (const [tierStr, requirements] of Object.entries(tierRequirements)) {
    const tier = parseInt(tierStr)
    const requiredCount = Math.ceil(requirements.length * (2 / 3))

    const reqResults = requirements.map(req => {
      let met = false
      let currentCpr = null

      if (req.isAverage) {
        // Average CPR across all roles at this difficulty level
        const levelCpr = cprByRole?.[req.level]
        if (levelCpr) {
          const values = Object.values(levelCpr)
          if (values.length > 0) {
            currentCpr = values.reduce((a, b) => a + b, 0) / values.length
            met = currentCpr >= req.minCpr
          }
        }
      } else {
        currentCpr = cprByRole?.[req.level]?.[req.role] ?? null
        met = currentCpr !== null && currentCpr >= req.minCpr
      }

      return {
        ...req,
        met,
        currentCpr,
        gap: currentCpr !== null ? req.minCpr - currentCpr : null,
      }
    })

    const metCount = reqResults.filter(r => r.met).length
    const qualified = metCount >= requiredCount

    allTierProgress[tier] = {
      tier,
      requirements: reqResults,
      metCount,
      requiredCount,
      totalRequirements: requirements.length,
      qualified,
      progressPercent: requirements.length > 0
        ? Math.round((metCount / requiredCount) * 100)
        : 0,
    }
  }

  // Find qualified tiers (sorted best to worst)
  const qualifiedTiers = Object.values(allTierProgress)
    .filter(t => t.qualified)
    .map(t => t.tier)
    .sort((a, b) => a - b)

  // Next tier is the tier just above current (lower number = better)
  let nextTier = null
  let nextTierProgress = null

  if (currentTier > 1) {
    const targetTier = currentTier - 1
    nextTier = targetTier
    nextTierProgress = allTierProgress[targetTier] || null
  }

  return {
    currentTier,
    qualifiedTiers,
    bestQualifiedTier: qualifiedTiers.length > 0 ? qualifiedTiers[0] : null,
    nextTier,
    nextTierProgress,
    allTierProgress,
  }
}

/**
 * Get tier display info
 */
export function getTierInfo(tier) {
  const names = {
    1: 'Elite',
    2: 'Advanced',
    3: 'Intermediate',
    4: 'Developing',
    5: 'Beginner',
    6: 'Default',
  }
  const tickets = config.payoutTickets[tier] || 2
  return { name: names[tier] || 'Unknown', tickets, tier }
}
