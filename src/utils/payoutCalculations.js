/**
 * Enhanced Payout Calculation Utilities - FIXED PENALTY LOGIC
 * 
 * Key fix: Penalty based on ABSOLUTE threshold (120 hours), not relative to average
 */

const TIER_TICKETS = {
  1: 40,
  2: 30,
  3: 15,
  4: 7,
  5: 3,
  6: 2
}

// CRITICAL: Time thresholds for penalty calculation
const MIN_TIME_FOR_FULL_TICKETS = 120 * 3600 // 120 hours = 432,000 seconds (no penalty)
const MIN_TIME_FOR_ANY_PAYOUT = 48 * 3600   // 48 hours = 172,800 seconds (full penalty below this)

export function getWeekRangeFromDate(date) {
  const d = new Date(date)
  const dayOfWeek = d.getDay()
  
  const monday = new Date(d)
  monday.setDate(d.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1))
  monday.setHours(0, 0, 0, 0)
  
  const sunday = new Date(monday)
  sunday.setDate(monday.getDate() + 6)
  sunday.setHours(23, 59, 59, 999)
  
  return {
    monday,
    sunday,
    mondayTimestamp: Math.floor(monday.getTime() / 1000),
    sundayTimestamp: Math.floor(sunday.getTime() / 1000)
  }
}

export function getCurrentWeekRange() {
  return getWeekRangeFromDate(new Date())
}

export function getPreviousWeekRange() {
  const currentWeek = getCurrentWeekRange()
  const previousWeek = new Date(currentWeek.monday)
  previousWeek.setDate(previousWeek.getDate() - 7)
  return getWeekRangeFromDate(previousWeek)
}

export function getCustomRange(fromDate, toDate) {
  const from = new Date(fromDate)
  from.setHours(0, 0, 0, 0)
  
  const to = new Date(toDate)
  to.setHours(23, 59, 59, 999)
  
  return {
    monday: from,
    sunday: to,
    mondayTimestamp: Math.floor(from.getTime() / 1000),
    sundayTimestamp: Math.floor(to.getTime() / 1000)
  }
}

export function calculateTimeSpent(joinedAt, timeReference, from, to) {
  if (joinedAt > to) {
    return 0
  }
  
  const effectiveStartTime = Math.max(joinedAt, from)
  const effectiveEndTime = Math.min(timeReference, to)
  
  if (effectiveStartTime >= effectiveEndTime) {
    return 0
  }
  
  return effectiveEndTime - effectiveStartTime
}

/**
 * Process item outcomes and requirements from crime slots
 * Tracks both items used (costs) and items rewarded
 */
function processItemOutcomes(crime, itemTransactions, crimeId) {
  const slots = crime.slots || []
  
  // Process each slot
  slots.forEach(slot => {
    // Check if slot has a user (filled position)
    if (slot.user) {
      // Track items that were used
      if (slot.item_requirement && !slot.item_requirement.is_reusable) {
        // Non-reusable item was consumed
        itemTransactions.push({
          id: slot.item_requirement.id.toString(),
          quantity: 1,
          status: 'used',
          crimeId: crimeId,
          position: slot.position,
          userId: slot.user.id
        })
      }
      
      // Track item outcome (if item was consumed or returned as different item)
      if (slot.user.item_outcome) {
        const outcome = slot.user.item_outcome
        
        // Only count if outcome is "used" (consumed)
        // Don't double-count if we already counted from item_requirement
        if (outcome.outcome === 'used' && 
            (!slot.item_requirement || slot.item_requirement.id !== outcome.item_id)) {
          itemTransactions.push({
            id: outcome.item_id.toString(),
            quantity: 1,
            status: 'used',
            crimeId: crimeId,
            position: slot.position,
            userId: slot.user.id
          })
        }
      }
    }
  })
  
  // Process crime-level item rewards
  if (crime.rewards?.items && Array.isArray(crime.rewards.items)) {
    crime.rewards.items.forEach(item => {
      itemTransactions.push({
        id: item.id ? item.id.toString() : item.toString(),
        quantity: item.quantity || 1,
        status: 'reward',
        crimeId: crimeId
      })
    })
  }
}

function estimateItemValue(itemId) {
  const commonValues = {
    '1361': 50000,
    '1362': 100000,
    '1203': 75000,
    '71': 25000,
    '579': 50000,
  }
  
  return commonValues[itemId] || 50000
}

function calculateItemValues(itemTransactions) {
  const itemSummary = {}
  
  for (const transaction of itemTransactions) {
    const key = `${transaction.id}_${transaction.status}`
    if (!itemSummary[key]) {
      itemSummary[key] = {
        id: transaction.id,
        status: transaction.status,
        quantity: 0
      }
    }
    itemSummary[key].quantity += transaction.quantity
  }
  
  let totalRewardValue = 0
  let totalUsedValue = 0
  
  for (const key in itemSummary) {
    const summary = itemSummary[key]
    const marketValue = estimateItemValue(summary.id)
    const totalValue = marketValue * summary.quantity
    
    if (summary.status === 'reward') {
      totalRewardValue += totalValue
    } else if (summary.status === 'used') {
      totalUsedValue += totalValue
    }
  }
  
  return {
    itemReward: totalRewardValue,
    itemCost: totalUsedValue,
    netItemValue: totalRewardValue - totalUsedValue,
    itemDetails: Object.values(itemSummary)
  }
}

/**
 * Calculate sit-out penalty based on ABSOLUTE time thresholds
 * 
 * THRESHOLDS:
 * - >= 120 hours (432,000s): NO penalty (full tickets)
 * - < 48 hours (172,800s): FULL penalty ($0 payout)
 * - Between 48-120 hours: Sliding scale penalty
 */
function calculateSitOutPenalty(timeSpent, baseTickets) {
  // NO PENALTY: >= 120 hours (5 days)
  if (timeSpent >= MIN_TIME_FOR_FULL_TICKETS) {
    return 0
  }
  
  // FULL PENALTY: < 48 hours (2 days) - lose ALL tickets
  if (timeSpent < MIN_TIME_FOR_ANY_PAYOUT) {
    // Remove ALL tickets → adjusted = 0, payout = $0
    return -baseTickets
  }
  
  // SLIDING SCALE: Between 48-120 hours
  // Linear interpolation from full penalty at 48h to no penalty at 120h
  const timeRange = MIN_TIME_FOR_FULL_TICKETS - MIN_TIME_FOR_ANY_PAYOUT // 72 hours
  const timeAboveMin = timeSpent - MIN_TIME_FOR_ANY_PAYOUT
  const percentOfRange = timeAboveMin / timeRange
  
  // At 48h: percentOfRange = 0 → penalty = -baseTickets (full penalty)
  // At 120h: percentOfRange = 1 → penalty = 0 (no penalty)
  // At 84h (middle): percentOfRange = 0.5 → penalty = -0.5 * baseTickets (half penalty)
  const penalty = -(1 - percentOfRange) * baseTickets
  
  return penalty
}

function processParticipantsFromSlots(crime, timeReference, from, to, members, cprData) {
  const slots = crime.slots || []
  
  slots.forEach(slot => {
    if (!slot.user || !slot.user.id) {
      return
    }
    
    const userId = slot.user.id.toString()
    const joinedAt = slot.user.joined_at
    const position = slot.position
    const cpr = slot.checkpoint_pass_rate || 0
    
    if (!members[userId]) {
      const memberData = cprData.members?.[userId] || {}
      members[userId] = {
        userId: slot.user.id,
        name: memberData.name || `Member ${userId}`,
        tier: memberData.tier || 6,
        crimesCount: 0,
        timeSpent: 0,
        positions: []
      }
    }
    
    const timeSpent = calculateTimeSpent(joinedAt, timeReference, from, to)
    
    members[userId].crimesCount++
    members[userId].timeSpent += timeSpent
    members[userId].positions.push({
      difficulty: crime.difficulty,
      position: position,
      cpr: cpr
    })
  })
}

export function calculatePayoutsWithItems(crimesData, cprData, fromTimestamp, toTimestamp, tierConfig, customFactionCut = null) {
  console.log('\n===========================================')
  console.log('PAYOUT CALCULATION START')
  console.log('===========================================')
  console.log('Time thresholds:')
  console.log('  - Full tickets (no penalty): >= 120 hours (432,000 seconds)')
  console.log('  - Sliding penalty range: 48-120 hours (172,800 - 432,000 seconds)')
  console.log('  - Full penalty ($0): < 48 hours (172,800 seconds)')
  
  if (!crimesData?.crimes || !cprData?.members) {
    console.log('❌ Missing data')
    return {
      members: [],
      totalMoneyReward: 0,
      itemReward: 0,
      itemCost: 0,
      factionCut: 0,
      factionCutPercent: 0,
      memberPayout: 0,
      participatingMembers: 0,
      crimesProcessed: 0,
      totalTimeSpent: 0
    }
  }
  
  const members = {}
  const itemTransactions = []
  let totalMoneyReward = 0
  let crimesProcessed = 0
  
  const dataFrom = fromTimestamp - (604800 * 3)
  
  console.log('Date range:', new Date(fromTimestamp * 1000), 'to', new Date(toTimestamp * 1000))
  console.log('Total crimes in database:', Object.keys(crimesData.crimes).length)
  
  Object.entries(crimesData.crimes).forEach(([crimeId, crime]) => {
    const status = crime.status
    const createdAt = crime.created_at || 0
    const executedAt = crime.executed_at || 0
    
    if (createdAt > 0 && createdAt < dataFrom) {
      return
    }
    
    if (status === 'Successful') {
      if (executedAt >= fromTimestamp && executedAt < toTimestamp) {
        crimesProcessed++
        
        const moneyReward = crime.rewards?.money || 0
        totalMoneyReward += moneyReward
        
        processItemOutcomes(crime, itemTransactions, crimeId)
        processParticipantsFromSlots(crime, executedAt, fromTimestamp, toTimestamp, members, cprData)
      } else if (executedAt >= fromTimestamp) {
        processParticipantsFromSlots(crime, toTimestamp, fromTimestamp, toTimestamp, members, cprData)
      }
    }
    else if (status === 'Failure') {
      if (executedAt >= fromTimestamp && executedAt < toTimestamp) {
        processItemOutcomes(crime, itemTransactions, crimeId)
        processParticipantsFromSlots(crime, executedAt, fromTimestamp, toTimestamp, members, cprData)
      } else if (executedAt >= fromTimestamp) {
        processParticipantsFromSlots(crime, toTimestamp, fromTimestamp, toTimestamp, members, cprData)
      }
    }
    else if (status === 'Planning' || status === 'Recruiting') {
      processParticipantsFromSlots(crime, toTimestamp, fromTimestamp, toTimestamp, members, cprData)
    }
  })
  
  console.log('✅ Successful crimes processed:', crimesProcessed)
  console.log('💰 Total money reward:', totalMoneyReward)
  
  const itemValues = calculateItemValues(itemTransactions)
  
  const factionCutPercent = customFactionCut !== null ? customFactionCut : 0.20
  const memberPayoutTotal = (totalMoneyReward + itemValues.itemReward - itemValues.itemCost) * (1 - factionCutPercent)
  const factionCut = totalMoneyReward * factionCutPercent
  
  const memberArray = Object.values(members)
  
  console.log('👥 Members found:', memberArray.length)
  console.log('⏱️ Members with time > 0:', memberArray.filter(m => m.timeSpent > 0).length)
  
  if (memberArray.length === 0) {
    console.log('❌ No members found!')
    return {
      members: [],
      totalMoneyReward,
      itemReward: itemValues.itemReward,
      itemCost: itemValues.itemCost,
      netItemValue: itemValues.netItemValue,
      factionCut,
      factionCutPercent: factionCutPercent * 100,
      memberPayout: memberPayoutTotal,
      participatingMembers: 0,
      payoutPerMember: 0,
      crimesProcessed,
      totalTimeSpent: 0
    }
  }
  
  const totalTimeSpent = memberArray.reduce((sum, m) => sum + m.timeSpent, 0)
  console.log('⏱️ Total time spent:', totalTimeSpent, 'seconds')
  
  const averageTime = totalTimeSpent / memberArray.length
  console.log('⏱️ Average time per member:', averageTime, 'seconds (', (averageTime / 3600).toFixed(2), 'hours)')
  
  // Calculate penalties based on absolute 120-hour threshold
  memberArray.forEach(member => {
    const baseTickets = TIER_TICKETS[member.tier] || TIER_TICKETS[6]
    const sitOutPenalty = calculateSitOutPenalty(member.timeSpent, baseTickets)
    
    member.baseTickets = baseTickets
    member.sitOutPenalty = sitOutPenalty
    member.adjustedTickets = baseTickets + sitOutPenalty
  })
  
  const totalAdjustedTickets = memberArray.reduce((sum, m) => sum + m.adjustedTickets, 0)
  console.log('🎫 Total adjusted tickets:', totalAdjustedTickets)
  
  memberArray.forEach(member => {
    member.sharePercent = member.adjustedTickets / totalAdjustedTickets
    member.payout = Math.floor(member.sharePercent * memberPayoutTotal)
  })
  
  memberArray.sort((a, b) => b.payout - a.payout)
  
  console.log('\n📊 Sample member results (first 5):')
  memberArray.slice(0, 5).forEach(m => {
    const hours = (m.timeSpent / 3600).toFixed(2)
    const penalty = m.sitOutPenalty.toFixed(2)
    console.log(`${m.name}: ${m.timeSpent}s (${hours}h), penalty: ${penalty}, ${m.crimesCount} crimes, $${m.payout.toLocaleString()}`)
  })
  
  console.log('\n===========================================')
  console.log('PAYOUT CALCULATION COMPLETE')
  console.log('===========================================\n')
  
  return {
    members: memberArray,
    totalMoneyReward,
    itemReward: itemValues.itemReward,
    itemCost: itemValues.itemCost,
    netItemValue: itemValues.netItemValue,
    factionCut,
    factionCutPercent: factionCutPercent * 100,
    memberPayout: memberPayoutTotal,
    participatingMembers: memberArray.length,
    payoutPerMember: memberArray.length > 0 ? memberPayoutTotal / memberArray.length : 0,
    crimesProcessed,
    totalTimeSpent,
    averageTime,
    totalAdjustedTickets,
    minTimeForFullTickets: MIN_TIME_FOR_FULL_TICKETS,
    minTimeForAnyPayout: MIN_TIME_FOR_ANY_PAYOUT,
    windowStart: fromTimestamp,
    windowEnd: toTimestamp,
    itemDetails: itemValues.itemDetails
  }
}

// Format as raw seconds (no conversion)
export function formatTimeSpent(seconds) {
  return seconds
}

// Format currency with full value, no abbreviations
export function formatCurrency(amount) {
  return `$${Math.floor(amount).toLocaleString()}`
}

export function formatPercent(value) {
  return `${value.toFixed(2)}%`
}

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
    'OC Payout'
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
    Math.floor(m.payout)
  ])
  
  return [headers.join(','), ...rows.map(row => row.join(','))].join('\n')
}

export function exportPayoutsToJSON(members, metadata, savedBy = 'Unknown') {
  const weekEnding = new Date(metadata.windowEnd * 1000).toISOString().split('T')[0]
  const weekStart = new Date(metadata.windowStart * 1000).toISOString().split('T')[0]
  
  return {
    week_ending: weekEnding,
    week_start: weekStart,
    saved_by: savedBy,
    saved_at: new Date().toISOString(),
    total_money_reward: metadata.totalMoneyReward,
    faction_cut: metadata.factionCut,
    faction_cut_percent: metadata.factionCutPercent,
    member_payout: metadata.memberPayout,
    item_reward: metadata.itemReward,
    item_cost: metadata.itemCost,
    net_item_value: metadata.netItemValue,
    member_count: members.length,
    crimes_processed: metadata.crimesProcessed,
    average_time: metadata.averageTime,
    min_time_for_full_tickets: metadata.minTimeForFullTickets,
    min_time_for_any_payout: metadata.minTimeForAnyPayout,
    total_adjusted_tickets: metadata.totalAdjustedTickets,
    members: members.reduce((acc, m) => {
      acc[m.userId] = {
        member_id: m.userId,
        member_name: m.name,
        tier: m.tier,
        base_tickets: m.baseTickets,
        sit_out_penalty: m.sitOutPenalty,
        adjusted_tickets: m.adjustedTickets,
        share_percent: m.sharePercent,
        time_spent: m.timeSpent,
        crimes_count: m.crimesCount,
        payout: m.payout
      }
      return acc
    }, {})
  }
}

export function generateBatchPayoutURL(members) {
  const validMembers = members.filter(m => m.payout > 0)
  
  if (validMembers.length === 0) {
    return ''
  }
  
  const uids = validMembers.map(m => m.userId).join(',')
  const amounts = validMembers.map(m => Math.floor(m.payout)).join(',')
  
  return `https://www.torn.com/factions.php?step=your#/tab=controls&batbal_uids=${uids}&batbal_amounts=${amounts}`
}