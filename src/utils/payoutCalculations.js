/**
 * Payout Calculation Utilities - Supabase Version
 * 
 * Calculates member payouts based on tier, time spent, and crime participation.
 * Works directly with data loaded from Supabase.
 * 
 * All times use TCT (Torn City Time) which is UTC/GMT.
 */

const TIER_TICKETS = {
  1: 40,
  2: 30,
  3: 15,
  4: 7,
  5: 3,
  6: 2
}

// Time thresholds for penalty calculation (in seconds)
const MIN_TIME_FOR_FULL_TICKETS = 120 * 3600  // 120 hours = 432,000 seconds
const MIN_TIME_FOR_ANY_PAYOUT = 48 * 3600     // 48 hours = 172,800 seconds

/**
 * Get week range from a date (Monday 00:00:00 UTC to Sunday 23:59:59 UTC)
 * Uses TCT (UTC) exclusively
 */
export function getWeekRangeFromDate(date) {
  // Create date in UTC
  const d = new Date(date)

  // Get day of week in UTC (0 = Sunday, 1 = Monday, etc.)
  const dayOfWeek = d.getUTCDay()

  // Calculate Monday of this week in UTC
  const monday = new Date(d)
  const daysToSubtract = dayOfWeek === 0 ? 6 : dayOfWeek - 1
  monday.setUTCDate(d.getUTCDate() - daysToSubtract)
  monday.setUTCHours(0, 0, 0, 0)

  // Sunday is 6 days after Monday, ends at 23:59:59.999
  const sunday = new Date(monday)
  sunday.setUTCDate(monday.getUTCDate() + 6)
  sunday.setUTCHours(23, 59, 59, 999)

  return {
    monday,
    sunday,
    // Use >= fromTimestamp and < toTimestamp+1 to avoid overlap
    // Monday 00:00:00 UTC timestamp
    mondayTimestamp: Math.floor(monday.getTime() / 1000),
    // Sunday 23:59:59 UTC timestamp (we'll use < next Monday for filtering)
    sundayTimestamp: Math.floor(sunday.getTime() / 1000)
  }
}

/**
 * Get current week range in TCT (UTC)
 */
export function getCurrentWeekRange() {
  return getWeekRangeFromDate(new Date())
}

/**
 * Get previous week range in TCT (UTC)
 */
export function getPreviousWeekRange() {
  const currentWeek = getCurrentWeekRange()
  const previousMonday = new Date(currentWeek.monday)
  previousMonday.setUTCDate(previousMonday.getUTCDate() - 7)
  return getWeekRangeFromDate(previousMonday)
}

/**
 * Format a date to YYYY-MM-DD in UTC
 */
export function formatDateUTC(date) {
  const d = new Date(date)
  const year = d.getUTCFullYear()
  const month = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Parse a YYYY-MM-DD string as UTC midnight
 */
export function parseDateAsUTC(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0))
}

/**
 * Calculate time spent in a crime for a specific member
 * @param {number} joinedAt - When the member joined (Unix timestamp)
 * @param {number} timeReference - End time reference (executed_at or toTimestamp)
 * @param {number} fromTimestamp - Start of payout period
 * @param {number} toTimestamp - End of payout period
 * @returns {number} Time spent in seconds
 */
export function calculateTimeSpent(joinedAt, timeReference, fromTimestamp, toTimestamp) {
  if (!joinedAt || joinedAt > toTimestamp) {
    return 0
  }

  // Clamp to the payout window
  const effectiveStart = Math.max(joinedAt, fromTimestamp)
  const effectiveEnd = Math.min(timeReference, toTimestamp)

  if (effectiveStart >= effectiveEnd) {
    return 0
  }

  return effectiveEnd - effectiveStart
}

/**
 * Calculate sit-out penalty based on absolute time thresholds
 * 
 * >= 120 hours: NO penalty (full tickets)
 * < 48 hours: FULL penalty ($0 payout)
 * 48-120 hours: Sliding scale
 */
function calculateSitOutPenalty(timeSpent, baseTickets) {
  if (timeSpent >= MIN_TIME_FOR_FULL_TICKETS) {
    return 0
  }

  if (timeSpent < MIN_TIME_FOR_ANY_PAYOUT) {
    return -baseTickets
  }

  // Sliding scale between 48-120 hours
  const timeRange = MIN_TIME_FOR_FULL_TICKETS - MIN_TIME_FOR_ANY_PAYOUT
  const timeAboveMin = timeSpent - MIN_TIME_FOR_ANY_PAYOUT
  const percentOfRange = timeAboveMin / timeRange

  return -(1 - percentOfRange) * baseTickets
}

/**
 * Calculate theoretical payout for a member (equal share of the member pool based on crime participation)
 *
 * This distributes the member pool proportionally by the number of successful crimes
 * each member participated in, relative to total participation slots.
 * The sum of all theoretical payouts equals the member pool.
 *
 * @param {number} memberCrimesCount - Number of successful crimes this member participated in
 * @param {number} totalParticipationSlots - Sum of all members' crime counts
 * @param {number} memberPayoutTotal - Total pool available for members
 * @returns {number} Theoretical payout for this member
 */
function calculateTheoreticalPayout(memberCrimesCount, totalParticipationSlots, memberPayoutTotal) {
  if (totalParticipationSlots <= 0 || memberCrimesCount <= 0) return 0
  return Math.floor((memberCrimesCount / totalParticipationSlots) * memberPayoutTotal)
}

/**
 * Validate that no member appears in two active (non-completed) crimes at the same time.
 * Members cannot be in two OC crimes simultaneously in Torn, so any overlap indicates a data issue.
 *
 * @param {Object} crimesData - { crimes: { [crime_id]: crimeObject } }
 * @returns {{ valid: boolean, warnings: string[] }}
 */
export function validateNoOverlappingCrimes(crimesData) {
  const crimes = crimesData?.crimes || {}
  const warnings = []

  // Build intervals per member: { userId: [{ crimeId, start, end }] }
  const memberIntervals = {}

  for (const [crimeId, crime] of Object.entries(crimes)) {
    const slots = crime.slots || []
    const executedAt = crime.executed_at || 0
    const status = crime.status

    for (const slot of slots) {
      if (!slot.user || !slot.user.id) continue
      const userId = slot.user.id.toString()
      const joinedAt = slot.user.joined_at
      if (!joinedAt) continue

      // End of participation is when the crime completed (or now if still in progress)
      let endTime
      if (status === 'Successful' || status === 'Failed' || status === 'Failure') {
        endTime = executedAt
      } else {
        endTime = Math.floor(Date.now() / 1000)
      }

      if (!memberIntervals[userId]) memberIntervals[userId] = []
      memberIntervals[userId].push({ crimeId, start: joinedAt, end: endTime })
    }
  }

  // Check for overlaps within each member
  for (const [userId, intervals] of Object.entries(memberIntervals)) {
    if (intervals.length < 2) continue

    // Sort by start time
    const sorted = [...intervals].sort((a, b) => a.start - b.start)

    for (let i = 0; i < sorted.length - 1; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        if (sorted[j].start < sorted[i].end) {
          warnings.push(
            `Member ${userId}: overlap between crime ${sorted[i].crimeId} ` +
            `(${sorted[i].start}-${sorted[i].end}) and crime ${sorted[j].crimeId} ` +
            `(${sorted[j].start}-${sorted[j].end})`
          )
        }
      }
    }
  }

  return { valid: warnings.length === 0, warnings }
}

/**
 * Main payout calculation function
 * Works with data loaded from Supabase via payoutDataLoader.js
 * 
 * IMPORTANT: Uses >= fromTimestamp and < toTimestamp to avoid overlaps
 * 
 * @param {Object} crimesData - { crimes: { [crime_id]: crimeObject } }
 * @param {Object} membersData - { members: { [member_id]: memberObject } }
 * @param {number} fromTimestamp - Start of payout period (inclusive)
 * @param {number} toTimestamp - End of payout period (exclusive for filtering, but use full range for time)
 * @param {number} factionCutPercent - Faction cut as decimal (e.g., 0.20 for 20%)
 * @returns {Object} Payout calculation results
 */
export function calculatePayouts(crimesData, membersData, fromTimestamp, toTimestamp, factionCutPercent = 0.20) {
  console.log('\n===========================================')
  console.log('PAYOUT CALCULATION START (Supabase)')
  console.log('===========================================')
  console.log('Time range:', new Date(fromTimestamp * 1000).toISOString(), 'to', new Date(toTimestamp * 1000).toISOString())
  console.log('Faction cut:', (factionCutPercent * 100).toFixed(1) + '%')

  const crimes = crimesData?.crimes || {}
  const members = membersData?.members || {}

  if (Object.keys(crimes).length === 0) {
    console.log('No crimes data available')
    return createEmptyResult()
  }

  // Track participating members
  const participatingMembers = {}

  // Track totals - ONLY for crimes executed within range
  let totalMoneyReward = 0
  let totalItemReward = 0
  let totalItemCost = 0
  let crimesProcessed = 0
  const crimeIds = []

  // Item details for display
  const rewardItemDetails = []
  const consumedItemDetails = []

  // Crime statistics - ONLY for crimes executed within range
  const crimesByDifficulty = {}
  const crimesByStatus = { Successful: 0, Failed: 0, Planning: 0, Recruiting: 0 }

  // Process each crime
  for (const [crimeId, crime] of Object.entries(crimes)) {
    const status = crime.status
    const executedAt = crime.executed_at || 0
    const createdAt = crime.created_at || 0
    const difficulty = crime.difficulty || 1

    // Determine time reference for this crime
    let timeReference
    if (status === 'Successful' || status === 'Failed' || status === 'Failure') {
      timeReference = executedAt
    } else {
      // For in-progress crimes, use current time, not toTimestamp
      // This prevents showing 168h for crimes still in progress
      timeReference = Math.min(Math.floor(Date.now() / 1000), toTimestamp)
    }

    // Check if crime was executed within our window
    // Use >= fromTimestamp and < toTimestamp to avoid double-counting at boundaries
    const inTimeWindow = executedAt >= fromTimestamp && executedAt < toTimestamp

    // Process successful crimes for rewards (only if in time window)
    if (status === 'Successful' && inTimeWindow) {
      crimesProcessed++
      crimeIds.push(crimeId)

      totalMoneyReward += crime.rewards?.money || 0
      totalItemReward += crime.item_reward_value || 0
      totalItemCost += crime.item_cost_value || 0

      crimesByStatus.Successful++

      // Initialize difficulty tracking
      if (!crimesByDifficulty[difficulty]) {
        crimesByDifficulty[difficulty] = { success: 0, failed: 0, total: 0 }
      }
      crimesByDifficulty[difficulty].success++
      crimesByDifficulty[difficulty].total++

      // Collect reward item details
      if (crime.reward_items && crime.reward_items.length > 0) {
        for (const item of crime.reward_items) {
          rewardItemDetails.push({
            crimeId,
            crimeName: crime.name,
            itemId: item.item_id,
            itemName: item.item_name,
            quantity: item.quantity,
            unitValue: item.unit_value || 0,
            totalValue: (item.unit_value || 0) * (item.quantity || 1)
          })
        }
      }

      // Collect consumed item details
      if (crime.required_items && crime.required_items.length > 0) {
        for (const item of crime.required_items) {
          if (item.was_consumed) {
            consumedItemDetails.push({
              crimeId,
              crimeName: crime.name,
              itemId: item.item_id,
              itemName: item.item_name,
              userId: item.user_id,
              unitValue: item.unit_value || 0,
              outcome: item.outcome
            })
          }
        }
      }
    } else if ((status === 'Failed' || status === 'Failure') && inTimeWindow) {
      crimeIds.push(crimeId)
      crimesByStatus.Failed++

      if (!crimesByDifficulty[difficulty]) {
        crimesByDifficulty[difficulty] = { success: 0, failed: 0, total: 0 }
      }
      crimesByDifficulty[difficulty].failed++
      crimesByDifficulty[difficulty].total++
    }
    // Note: Planning and Recruiting crimes are counted but not in time window stats

    // Process slots for time tracking (all crimes, not just successful ones)
    const slots = crime.slots || []

    for (const slot of slots) {
      if (!slot.user || !slot.user.id) continue

      const userId = slot.user.id.toString()
      const joinedAt = slot.user.joined_at

      // Skip if joined after our time window
      if (joinedAt > toTimestamp) continue

      // Get member data
      const memberData = members[userId] || {}

      // Initialize member tracking
      if (!participatingMembers[userId]) {
        const memberName = slot.user.name || memberData.name || 'Unknown'
        const displayName = memberName !== 'Unknown' ? `${memberName} [${userId}]` : `User ${userId}`

        participatingMembers[userId] = {
          userId: slot.user.id,
          name: displayName,
          tier: memberData.tier || 6,
          crimesCount: 0,
          timeSpent: 0,
          crimeIds: [],
          positions: []
        }
      }

      // Calculate time spent in this crime within the payout window
      const timeSpent = calculateTimeSpent(joinedAt, timeReference, fromTimestamp, toTimestamp)

      participatingMembers[userId].timeSpent += timeSpent
      participatingMembers[userId].crimeIds.push(crimeId)

      // Only count as participated if crime is successful and in time window
      if (status === 'Successful' && inTimeWindow) {
        participatingMembers[userId].crimesCount++
      }

      participatingMembers[userId].positions.push({
        crimeId,
        difficulty,
        position: slot.position,
        cpr: slot.checkpoint_pass_rate || 0,
        status
      })
    }
  }

  console.log('Crimes processed (successful in window):', crimesProcessed)
  console.log('Total money reward:', totalMoneyReward)
  console.log('Total item reward:', totalItemReward)
  console.log('Total item cost:', totalItemCost)
  console.log('Participating members:', Object.keys(participatingMembers).length)

  // Calculate total pool after faction cut
  const grossTotal = totalMoneyReward + totalItemReward - totalItemCost
  const factionCut = Math.floor(grossTotal * factionCutPercent)
  const memberPayoutTotal = grossTotal - factionCut

  // Convert to array and calculate tickets/penalties
  let memberArray = Object.values(participatingMembers)

  // Filter to only include members who participated in successful crimes during the window
  // OR are current members (who should see $0 if they didn't participate)
  memberArray = memberArray.filter(member => {
    // Check if member participated in any successful crime during the window
    const participatedInWindow = member.crimesCount > 0

    // Check if member is current
    const memberData = members[member.userId.toString()]
    const isCurrent = memberData?.is_current === true

    return participatedInWindow || isCurrent
  })

  if (memberArray.length === 0) {
    console.log('No participating members found')
    return createEmptyResult()
  }

  const totalTimeSpent = memberArray.reduce((sum, m) => sum + m.timeSpent, 0)
  const averageTime = totalTimeSpent / memberArray.length

  // Calculate tickets and penalties for each member
  for (const member of memberArray) {
    const baseTickets = TIER_TICKETS[member.tier] || TIER_TICKETS[6]
    const sitOutPenalty = calculateSitOutPenalty(member.timeSpent, baseTickets)

    member.baseTickets = baseTickets
    member.sitOutPenalty = sitOutPenalty
    member.adjustedTickets = Math.max(0, baseTickets + sitOutPenalty)
  }

  // Calculate total participation slots (sum of all members' successful crime counts)
  const totalParticipationSlots = memberArray.reduce((sum, m) => sum + m.crimesCount, 0)

  // Calculate theoretical payout for each member (proportional share of pool by crime participation)
  for (const member of memberArray) {
    member.theoreticalPayout = calculateTheoreticalPayout(
      member.crimesCount,
      totalParticipationSlots,
      memberPayoutTotal
    )
  }

  // Calculate total adjusted tickets
  const totalAdjustedTickets = memberArray.reduce((sum, m) => sum + m.adjustedTickets, 0)

  // Calculate share and payout for each member
  for (const member of memberArray) {
    if (totalAdjustedTickets > 0) {
      member.sharePercent = member.adjustedTickets / totalAdjustedTickets
      member.payout = Math.floor(member.sharePercent * memberPayoutTotal)
    } else {
      member.sharePercent = 0
      member.payout = 0
    }

    // Calculate time percentage
    member.timePercent = totalTimeSpent > 0 ? (member.timeSpent / totalTimeSpent) * 100 : 0
  }

  // Sort by payout descending
  memberArray.sort((a, b) => b.payout - a.payout)

  // Calculate crime statistics
  const totalCrimes = crimesByStatus.Successful + crimesByStatus.Failed
  const successRate = totalCrimes > 0 ? (crimesByStatus.Successful / totalCrimes) * 100 : 0

  console.log('Crime stats - Successful:', crimesByStatus.Successful, 'Failed:', crimesByStatus.Failed)
  console.log('Success rate:', successRate.toFixed(1) + '%')
  console.log('===========================================\n')

  // Create item breakdown structure
  const itemBreakdown = {
    rewards: {},
    costs: {}
  }

  // Aggregate reward items
  for (const item of rewardItemDetails) {
    if (!itemBreakdown.rewards[item.itemId]) {
      itemBreakdown.rewards[item.itemId] = {
        name: item.itemName || `Item ${item.itemId}`,
        quantity: 0,
        totalValue: 0
      }
    }
    itemBreakdown.rewards[item.itemId].quantity += item.quantity
    itemBreakdown.rewards[item.itemId].totalValue += item.totalValue
  }

  // Aggregate consumed items
  for (const item of consumedItemDetails) {
    if (!itemBreakdown.costs[item.itemId]) {
      itemBreakdown.costs[item.itemId] = {
        name: item.itemName || `Item ${item.itemId}`,
        quantity: 0,
        totalValue: 0
      }
    }
    itemBreakdown.costs[item.itemId].quantity += 1
    itemBreakdown.costs[item.itemId].totalValue += item.unitValue
  }

  console.log('Item breakdown - Rewards:', Object.keys(itemBreakdown.rewards).length, 'unique items')
  console.log('Item breakdown - Costs:', Object.keys(itemBreakdown.costs).length, 'unique items')

  return {
    members: memberArray,
    totalMoneyReward,
    totalItemReward,
    totalItemCost,
    netItemValue: totalItemReward - totalItemCost,
    grossTotal,
    factionCut,
    factionCutPercent: factionCutPercent * 100,
    memberPayoutTotal,
    participatingMembers: memberArray.length,
    payoutPerMember: memberArray.length > 0 ? Math.floor(memberPayoutTotal / memberArray.length) : 0,
    crimesProcessed,
    totalCrimes,  // Add total crimes (successful + failed)
    crimeIds,
    totalTimeSpent,
    averageTime,
    totalAdjustedTickets,
    minTimeForFullTickets: MIN_TIME_FOR_FULL_TICKETS,
    minTimeForAnyPayout: MIN_TIME_FOR_ANY_PAYOUT,
    windowStart: fromTimestamp,
    windowEnd: toTimestamp,
    // Crime statistics
    crimeStats: {
      successful: crimesByStatus.Successful,
      failed: crimesByStatus.Failed,
      planning: crimesByStatus.Planning,
      recruiting: crimesByStatus.Recruiting,
      total: totalCrimes,
      successRate,
      totalMoneyFromCrimes: totalMoneyReward,
      byDifficulty: crimesByDifficulty
    },
    // Item details for display
    rewardItemDetails,
    consumedItemDetails,
    itemBreakdown
  }
}

/**
 * Create empty result object
 */
function createEmptyResult() {
  return {
    members: [],
    totalMoneyReward: 0,
    totalItemReward: 0,
    totalItemCost: 0,
    grossTotal: 0,
    factionCut: 0,
    factionCutPercent: 20,
    memberPayoutTotal: 0,
    participatingMembers: 0,
    payoutPerMember: 0,
    crimesProcessed: 0,
    crimeIds: [],
    totalTimeSpent: 0,
    averageTime: 0,
    totalAdjustedTickets: 0,
    minTimeForFullTickets: MIN_TIME_FOR_FULL_TICKETS,
    minTimeForAnyPayout: MIN_TIME_FOR_ANY_PAYOUT,
    windowStart: 0,
    windowEnd: 0,
    crimeStats: {
      successful: 0,
      failed: 0,
      planning: 0,
      recruiting: 0,
      total: 0,
      successRate: 0,
      totalMoneyFromCrimes: 0,
      byDifficulty: {}
    },
    rewardItemDetails: [],
    consumedItemDetails: []
  }
}

/**
 * Format currency with full value (no abbreviation)
 * e.g., $2,020,221,000
 */
export function formatCurrency(amount) {
  if (amount === null || amount === undefined) return '$0'
  return '$' + Math.floor(amount).toLocaleString()
}

/**
 * Format currency short (with abbreviation for display where space is limited)
 * e.g., $2.02B
 */
export function formatCurrencyShort(amount) {
  if (amount === null || amount === undefined) return '$0'

  const absAmount = Math.abs(amount)
  const sign = amount < 0 ? '-' : ''

  if (absAmount >= 1e9) {
    return sign + '$' + (absAmount / 1e9).toFixed(2) + 'B'
  } else if (absAmount >= 1e6) {
    return sign + '$' + (absAmount / 1e6).toFixed(2) + 'M'
  } else if (absAmount >= 1e3) {
    return sign + '$' + (absAmount / 1e3).toFixed(1) + 'K'
  }
  return sign + '$' + Math.floor(absAmount).toLocaleString()
}

/**
 * Format percentage
 */
export function formatPercent(value) {
  if (value === null || value === undefined) return '0%'
  return value.toFixed(2) + '%'
}

/**
 * Format time in hours
 */
export function formatTimeHours(seconds) {
  if (!seconds) return '0h'
  const hours = seconds / 3600
  return hours.toFixed(1) + 'h'
}

/**
 * Format time in hours and minutes
 */
export function formatTimeHM(seconds) {
  if (!seconds) return '0h 0m'
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return `${hours}h ${minutes}m`
}

/**
 * Export payouts to CSV
 */
export function exportPayoutsToCSV(members, metadata) {
  const headers = [
    'Member',
    'ID',
    'Time Spent (seconds)',
    'Time %',
    'Tier',
    'Base Tickets',
    'Sit-Out Penalty',
    'Adjusted Tickets',
    'OC Share %',
    'Crimes',
    'OC Payout',
    'Theoretical'
  ]

  const totalTime = metadata.totalTimeSpent || 1

  const rows = members.map(m => [
    m.name,
    m.userId,
    m.timeSpent,
    ((m.timeSpent / totalTime) * 100).toFixed(4) + '%',
    m.tier,
    m.baseTickets || 0,
    (m.sitOutPenalty || 0).toFixed(4),
    (m.adjustedTickets || 0).toFixed(4),
    ((m.sharePercent || 0) * 100).toFixed(6) + '%',
    m.crimesCount,
    Math.floor(m.payout),
    Math.floor(m.theoreticalPayout || 0)
  ])

  return [headers.join(','), ...rows.map(row => row.join(','))].join('\n')
}

/**
 * Generate batch payout URL for Torn
 */
export function generateBatchPayoutURL(members) {
  const validMembers = members.filter(m => m.payout > 0)

  if (validMembers.length === 0) {
    return ''
  }

  const uids = validMembers.map(m => m.userId).join(',')
  const amounts = validMembers.map(m => Math.floor(m.payout)).join(',')

  return `https://www.torn.com/factions.php?step=your#/tab=controls&batbal_uids=${uids}&batbal_amounts=${amounts}`
}

// /**
//  * Parse payout CSV for import
//  */
// export function parsePayoutCSV(csvText) {
//   const lines = csvText.trim().split('\n')

//   if (lines.length < 2) {
//     throw new Error('CSV file is empty or invalid')
//   }

//   const headers = lines[0].split(',').map(h => h.trim().toLowerCase())

//   // Find column indexes - based on actual CSV structure
//   const memberCol = headers.findIndex(h => h.includes('member'))
//   const idCol = headers.findIndex(h => h === 'id')
//   const timeCol = headers.findIndex(h => h.includes('time spent') && !h.includes('%'))
//   const timePercentCol = headers.findIndex(h => h.includes('time') && h.includes('%'))
//   const tierCol = headers.findIndex(h => h === 'tier')
//   const ticketsCol = headers.findIndex(h => h.includes('tickets') && !h.includes('adjusted'))
//   const penaltyCol = headers.findIndex(h => h.includes('penalty'))
//   const shareCol = headers.findIndex(h => h.includes('share'))
//   const payoutCol = headers.findIndex(h => h.includes('payout') && !h.includes('theoretical'))

//   if (idCol === -1 || payoutCol === -1) {
//     throw new Error('CSV must have ID and Payout columns')
//   }

//   const members = []
//   let totalPayout = 0
//   let totalTime = 0
//   let totalTickets = 0

//   for (let i = 1; i < lines.length; i++) {
//     const line = lines[i].trim()
//     if (!line) continue

//     const values = line.split(',').map(v => v.trim())

//     const memberId = values[idCol]
//     if (!memberId || memberId === 'undefined') continue

//     const payoutStr = values[payoutCol]?.replace(/[$,"]/g, '') || '0'
//     const payout = parseInt(payoutStr) || 0

//     const timeSpent = timeCol !== -1 ? parseInt(values[timeCol]) || 0 : 0
//     const timePercent = timePercentCol !== -1 ? parseFloat(values[timePercentCol]?.replace('%', '')) || 0 : 0
//     const tier = tierCol !== -1 ? parseInt(values[tierCol]) || 6 : 6
//     const baseTickets = ticketsCol !== -1 ? parseInt(values[ticketsCol]) || 0 : 0
//     const penalty = penaltyCol !== -1 ? parseFloat(values[penaltyCol]) || 0 : 0
//     const sharePercent = shareCol !== -1 ? parseFloat(values[shareCol]?.replace('%', '')) || 0 : 0

//     members.push({
//       member_id: memberId,
//       member_name: memberCol !== -1 ? values[memberCol] : `Member ${memberId}`,
//       tier,
//       base_tickets: baseTickets,
//       sit_out_penalty: penalty,
//       adjusted_tickets: baseTickets + penalty,
//       time_spent: timeSpent,
//       time_spent_percent: timePercent,
//       share_percent: sharePercent,
//       payout,
//       theoretical_payout: 0, // Not in CSV, will be recalculated if needed
//       crimes_count: 0, // Will be filled by import function
//       crimes_participated: [] // Will be filled by import function
//     })

//     totalPayout += payout
//     totalTime += timeSpent
//     totalTickets += (baseTickets + penalty)
//   }

//   return {
//     members,
//     totalPayout,
//     totalTime,
//     totalTickets,
//     memberCount: members.length
//   }
// }

/**
 * Get crime statistics from crimes data
 * @param {Object} crimes - Crimes object with crime data
 * @returns {Object} Statistics about crimes
 */
export function getCrimeStats(crimes) {
  const stats = {
    totals: {
      count: 0,
      success: 0,
      failed: 0,
      totalMoney: 0
    },
    byDifficulty: {},
    crimesList: []
  }

  if (!crimes) return stats

  Object.values(crimes).forEach(crime => {
    const isSuccess = crime.status === 'Successful' || crime.status === 'Success'
    const isFailed = crime.status === 'Failed' || crime.status === 'Failure'
    const isPending = crime.status === 'Planning' || crime.status === 'Recruiting'

    stats.totals.count++

    // Count by status
    if (isSuccess) {
      stats.totals.success++
      stats.totals.totalMoney += crime.rewards?.money || crime.rewards_money || 0
    } else if (isFailed) {
      stats.totals.failed++
    }

    // Count by difficulty - ONLY for executed crimes (success or failed)
    const difficulty = crime.difficulty || 1
    if (!stats.byDifficulty[difficulty]) {
      stats.byDifficulty[difficulty] = {
        total: 0,
        success: 0,
        failed: 0
      }
    }

    // Only count in difficulty stats if the crime was executed (not pending)
    if (!isPending) {
      stats.byDifficulty[difficulty].total++
      if (isSuccess) {
        stats.byDifficulty[difficulty].success++
      } else if (isFailed) {
        stats.byDifficulty[difficulty].failed++
      }
    }

    // Extract participant IDs from slots
    const participantIds = (crime.slots || [])
      .filter(slot => slot.user && slot.user.id)
      .map(slot => slot.user.id)

    // Add to crimes list for expandable view
    stats.crimesList.push({
      id: crime.crime_id,
      name: crime.name,
      difficulty: crime.difficulty,
      status: crime.status,
      moneyReward: crime.rewards?.money || crime.rewards_money || 0,
      executed_at: crime.executed_at,
      slots: crime.slots || [],
      participants: participantIds
    })
  })

  // Sort crimes list by execution time (most recent first)
  stats.crimesList.sort((a, b) => (b.executed_at || 0) - (a.executed_at || 0))

  return stats
}

/**
 * Parse a single CSV line respecting quoted fields.
 * Handles values like "$15,170,274" where commas appear inside quotes.
 */
function parseCSVLine(line) {
  const values = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      inQuotes = !inQuotes
    } else if (ch === ',' && !inQuotes) {
      values.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  values.push(current.trim())
  return values
}

/**
 * Find a column index using flexible matching against multiple possible header names.
 * Returns -1 if no match found.
 */
function findColumn(headers, ...patterns) {
  for (const pattern of patterns) {
    const idx = headers.findIndex(h => {
      if (typeof pattern === 'function') return pattern(h)
      return h === pattern || h.includes(pattern)
    })
    if (idx !== -1) return idx
  }
  return -1
}

/**
 * Clean a numeric string by removing currency symbols, commas, quotes, and percent signs.
 */
function cleanNumeric(val) {
  if (val === null || val === undefined || val === '') return 0
  const cleaned = String(val).replace(/[$,"%]/g, '').trim()
  return cleaned
}

/**
 * Parse payout CSV for import.
 * Handles both system-exported CSVs and Google Sheets-exported CSVs.
 * Properly parses quoted fields with embedded commas.
 * Includes all members (even those with 0 payout).
 */
export function parsePayoutCSV(csvText, weekStart, weekEnd) {
  const lines = csvText.trim().split('\n')

  if (lines.length < 2) {
    throw new Error('CSV file is empty or invalid')
  }

  const headers = parseCSVLine(lines[0]).map(h => h.trim().toLowerCase())

  // Flexible column detection supporting both system-export and Google Sheets formats
  const memberCol = findColumn(headers, 'member', 'name')
  const idCol = findColumn(headers, h => h === 'id', 'member id', 'user_id')
  const timeCol = findColumn(headers,
    h => h.includes('time spent') && !h.includes('%'),
    h => h.includes('time') && h.includes('oc') && !h.includes('%'),
    'time_in_crimes'
  )
  const timePercentCol = findColumn(headers,
    h => h.includes('time') && h.includes('%'),
    'time spent %', 'time_pct'
  )
  const tierCol = findColumn(headers, h => h === 'tier')
  const ticketsCol = findColumn(headers, 'base tickets', h => h === 'tickets')
  const adjustedTicketsCol = findColumn(headers, 'adjusted tickets', 'adj tickets')
  const penaltyCol = findColumn(headers, 'penalty', 'sit-out', 'sitout', 'sit_out')
  const shareCol = findColumn(headers, 'share', 'oc share')
  const payoutCol = findColumn(headers, 'oc payout', 'payout')
  const theoreticalCol = findColumn(headers, 'theoretical')
  const crimesCol = findColumn(headers, h => h === 'crimes', 'crime_count', 'crimes_count')

  if (idCol === -1) {
    throw new Error('CSV must have an ID column')
  }
  if (payoutCol === -1) {
    throw new Error('CSV must have a Payout column (e.g., "OC Payout")')
  }

  const members = []
  let totalPayout = 0
  let totalTime = 0
  let totalTickets = 0

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue

    const values = parseCSVLine(line)

    const memberId = values[idCol]?.replace(/['"]/g, '').trim()
    if (!memberId || memberId === 'undefined' || memberId === '') continue

    const payout = parseInt(cleanNumeric(values[payoutCol])) || 0
    const timeSpent = timeCol !== -1 ? parseInt(cleanNumeric(values[timeCol])) || 0 : 0
    const timePercent = timePercentCol !== -1 ? parseFloat(cleanNumeric(values[timePercentCol])) || 0 : 0
    const tier = tierCol !== -1 ? parseInt(cleanNumeric(values[tierCol])) || 6 : 6
    const baseTickets = ticketsCol !== -1 ? parseFloat(cleanNumeric(values[ticketsCol])) || 0 : 0
    const penalty = penaltyCol !== -1 ? parseFloat(cleanNumeric(values[penaltyCol])) || 0 : 0
    const adjustedTickets = adjustedTicketsCol !== -1
      ? parseFloat(cleanNumeric(values[adjustedTicketsCol])) || 0
      : Math.max(0, baseTickets + penalty)
    const sharePercent = shareCol !== -1 ? parseFloat(cleanNumeric(values[shareCol])) || 0 : 0
    const theoretical = theoreticalCol !== -1 ? parseInt(cleanNumeric(values[theoreticalCol])) || 0 : 0
    const crimesCount = crimesCol !== -1 ? parseInt(cleanNumeric(values[crimesCol])) || 0 : 0

    // Extract clean member name (strip bracketed ID if present, e.g., "Pierce [2163818]")
    let memberName = memberCol !== -1 ? values[memberCol]?.trim() : `Member ${memberId}`
    memberName = memberName.replace(/\s*\[\d+\]\s*$/, '')

    members.push({
      member_id: memberId,
      member_name: memberName,
      tier,
      base_tickets: baseTickets,
      sit_out_penalty: penalty,
      adjusted_tickets: adjustedTickets,
      time_spent: timeSpent,
      time_spent_percent: timePercent,
      share_percent: sharePercent,
      payout,
      theoretical_payout: theoretical,
      crimes_count: crimesCount,
      week_start: weekStart,
      week_end: weekEnd
    })

    totalPayout += payout
    totalTime += timeSpent
    totalTickets += adjustedTickets
  }

  return {
    members,
    totalPayout,
    totalTime,
    totalTickets,
    memberCount: members.length
  }
}

/**
 * Parse an XLSX file's Payout_Calculator sheet for import.
 * Also extracts item_outcomes data if present.
 *
 * @param {Array<Array>} payoutRows - 2D array of the Payout_Calculator sheet (with headers in row 0)
 * @param {Array<Array>|null} itemRows - 2D array of the item_outcomes sheet (optional)
 * @param {string} weekStart - Week start date string (YYYY-MM-DD)
 * @param {string} weekEnd - Week end date string (YYYY-MM-DD)
 * @returns {Object} Parsed payout data
 */
export function parsePayoutXLSX(payoutRows, itemRows, weekStart, weekEnd) {
  if (!payoutRows || payoutRows.length < 2) {
    throw new Error('Payout_Calculator sheet is empty or invalid')
  }

  const headers = payoutRows[0].map(h => (h || '').toString().trim().toLowerCase())

  const memberCol = findColumn(headers, 'member', 'name')
  const idCol = findColumn(headers, h => h === 'id', 'member id', 'user_id')
  const timeCol = findColumn(headers,
    h => h.includes('time spent') && !h.includes('%'),
    h => h.includes('time') && h.includes('oc') && !h.includes('%')
  )
  const timePercentCol = findColumn(headers, h => h.includes('time') && h.includes('%'))
  const tierCol = findColumn(headers, h => h === 'tier')
  const ticketsCol = findColumn(headers, 'base tickets', h => h === 'tickets')
  const penaltyCol = findColumn(headers, 'penalty', 'sit-out', 'sitout')
  const shareCol = findColumn(headers, 'share', 'oc share')
  const payoutCol = findColumn(headers, 'oc payout', 'payout')

  if (idCol === -1) {
    throw new Error('Payout_Calculator sheet must have an ID column')
  }
  if (payoutCol === -1) {
    throw new Error('Payout_Calculator sheet must have a Payout column')
  }

  const members = []
  let totalPayout = 0
  let totalTime = 0
  let totalTickets = 0

  for (let i = 1; i < payoutRows.length; i++) {
    const row = payoutRows[i]
    if (!row) continue

    const rawId = row[idCol]
    if (rawId === null || rawId === undefined || rawId === '') continue

    const memberId = String(Math.floor(Number(rawId)))
    if (!memberId || memberId === 'NaN' || memberId === '0') continue

    const payout = Math.floor(Number(row[payoutCol]) || 0)
    const timeSpent = Math.floor(Number(row[timeCol]) || 0)
    const tier = Math.floor(Number(row[tierCol]) || 6)
    const baseTickets = Number(row[ticketsCol]) || 0
    const penalty = Number(row[penaltyCol]) || 0
    const adjustedTickets = Math.max(0, baseTickets + penalty)

    // Share percent: XLSX stores as decimal (e.g., 0.02134), convert to percentage
    let sharePercent = Number(row[shareCol]) || 0
    if (sharePercent > 0 && sharePercent < 1) {
      sharePercent = sharePercent * 100
    }

    let timePercent = Number(row[timePercentCol]) || 0
    if (timePercent > 0 && timePercent < 1) {
      timePercent = timePercent * 100
    }

    let memberName = memberCol !== -1 ? String(row[memberCol] || '').trim() : `Member ${memberId}`
    memberName = memberName.replace(/\s*\[\d+\]\s*$/, '')

    members.push({
      member_id: memberId,
      member_name: memberName,
      tier,
      base_tickets: baseTickets,
      sit_out_penalty: penalty,
      adjusted_tickets: adjustedTickets,
      time_spent: timeSpent,
      time_spent_percent: timePercent,
      share_percent: sharePercent,
      payout,
      theoretical_payout: 0,
      crimes_count: 0,
      week_start: weekStart,
      week_end: weekEnd
    })

    totalPayout += payout
    totalTime += timeSpent
    totalTickets += adjustedTickets
  }

  // Parse item outcomes if available
  let itemOutcomes = null
  if (itemRows && itemRows.length > 1) {
    itemOutcomes = {
      items: [],
      netTotal: 0,
      rewardsTotal: 0,
      usedTotal: 0
    }

    const itemHeaders = itemRows[0].map(h => (h || '').toString().trim().toLowerCase())
    const itemIdCol = findColumn(itemHeaders, h => h === 'id')
    const itemNameCol = findColumn(itemHeaders, 'name')
    const itemStatusCol = findColumn(itemHeaders, 'status')
    const itemValueCol = findColumn(itemHeaders, 'market value', 'value')
    const itemQtyCol = findColumn(itemHeaders, 'quantity', 'qty')
    const itemTotalCol = findColumn(itemHeaders, 'total price', 'total')

    for (let i = 1; i < itemRows.length; i++) {
      const row = itemRows[i]
      if (!row || !row[itemIdCol]) continue

      const id = Number(row[itemIdCol])
      if (isNaN(id) || id === 0) continue

      const status = String(row[itemStatusCol] || '').trim().toLowerCase()
      const marketValue = Number(row[itemValueCol]) || 0
      const quantity = Number(row[itemQtyCol]) || 0
      const totalPrice = itemTotalCol !== -1 ? Number(row[itemTotalCol]) || 0 : 0

      itemOutcomes.items.push({
        id,
        name: String(row[itemNameCol] || ''),
        status,
        marketValue,
        quantity,
        totalPrice
      })

      if (status === 'reward') {
        itemOutcomes.rewardsTotal += Math.abs(totalPrice)
      } else if (status === 'used') {
        itemOutcomes.usedTotal += Math.abs(totalPrice)
      }
    }
    itemOutcomes.netTotal = itemOutcomes.rewardsTotal - itemOutcomes.usedTotal
  }

  return {
    members,
    totalPayout,
    totalTime,
    totalTickets,
    memberCount: members.length,
    itemOutcomes
  }
}

/**
 * Fetch market prices for items from Torn API
 * @param {Array} itemIds - Array of item IDs to fetch
 * @param {string} apiKey - Torn API key
 * @returns {Promise<Object>} Map of itemId -> market_price
 */
export async function fetchItemMarketPrices(itemIds, apiKey) {
  if (!itemIds || itemIds.length === 0) return {}

  const uniqueIds = [...new Set(itemIds)]
  const idsString = uniqueIds.join(',')

  try {
    const response = await fetch(
      `https://api.torn.com/v2/torn/${idsString}/items?sort=ASC&key=${apiKey}`
    )

    if (!response.ok) {
      throw new Error('Failed to fetch item prices from Torn API')
    }

    const data = await response.json()

    if (data.error) {
      throw new Error(data.error.error || 'Unknown API error')
    }

    const priceMap = {}
    if (data.items) {
      data.items.forEach(item => {
        priceMap[item.id.toString()] = item.value?.market_price || 0
      })
    }

    return priceMap
  } catch (error) {
    console.error('Error fetching item market prices:', error)
    return {}
  }
}