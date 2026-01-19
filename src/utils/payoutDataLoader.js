/**
 * Payout Data Loader - Loads all payout-related data from Supabase
 * 
 * This utility fetches crimes, slots, reward items, and required items
 * from Supabase and transforms them into a format suitable for payout calculations.
 * 
 * IMPORTANT: Time filtering uses >= fromTimestamp AND < toTimestamp to avoid
 * double-counting at week boundaries.
 */

import { supabase } from './supabase'
import * as adminApi from './adminApi'

/**
 * Load all crimes and related data for a given time range
 *
 * Filtering logic:
 * - Load crimes created up to 3 weeks before the analysis window to capture
 *   crimes that were created earlier but members joined/participated during our window
 * - This ensures accurate time tracking for members who joined crimes before
 *   the payout period but the crime executed during the period
 * - Successful/Failed crimes: executed_at >= fromTimestamp AND executed_at < toTimestamp
 * - Planning/Recruiting crimes: Always included for time tracking purposes
 *
 * @param {number} fromTimestamp - Start of period (Unix timestamp, inclusive)
 * @param {number} toTimestamp - End of period (Unix timestamp, exclusive)
 * @returns {Promise<Object>} Crimes data with slots and items
 */
export async function loadCrimesForPayout(fromTimestamp, toTimestamp) {
  try {
    // Calculate lookback window (3 weeks = 1,814,400 seconds)
    const THREE_WEEKS = 604800 * 3
    const dataFromTimestamp = fromTimestamp - THREE_WEEKS

    // Load crimes in multiple queries:
    // 1. Crimes created during lookback window that were executed in our analysis window
    // 2. Crimes created during lookback window that are still in progress
    // 3. In-progress crimes (Planning/Recruiting) - regardless of creation time

    // Query 1: Executed crimes (created in lookback window OR executed in analysis window)
    const { data: executedCrimes, error: executedError } = await supabase
      .from('crimes')
      .select('*')
      .gte('executed_at', fromTimestamp)
      .lt('executed_at', toTimestamp)
      .order('executed_at', { ascending: false })

    if (executedError) throw executedError

    // Query 2: Crimes created before our window but might have member activity during our window
    // Only get crimes that don't have executed_at yet or executed after our lookback starts
    const { data: lookbackCrimes, error: lookbackError } = await supabase
      .from('crimes')
      .select('*')
      .gte('created_at', dataFromTimestamp)
      .lt('created_at', fromTimestamp)
      .order('created_at', { ascending: false })

    if (lookbackError) throw lookbackError

    // Query 3: In-progress crimes (for ongoing time tracking)
    const { data: inProgressCrimes, error: inProgressError } = await supabase
      .from('crimes')
      .select('*')
      .in('status', ['Planning', 'Recruiting'])
      .order('created_at', { ascending: false })

    if (inProgressError) throw inProgressError

    // Combine and deduplicate
    const crimeMap = new Map()

    for (const crime of (executedCrimes || [])) {
      crimeMap.set(crime.crime_id, crime)
    }

    for (const crime of (lookbackCrimes || [])) {
      if (!crimeMap.has(crime.crime_id)) {
        crimeMap.set(crime.crime_id, crime)
      }
    }

    for (const crime of (inProgressCrimes || [])) {
      if (!crimeMap.has(crime.crime_id)) {
        crimeMap.set(crime.crime_id, crime)
      }
    }

    const crimes = Array.from(crimeMap.values())

    if (crimes.length === 0) {
      return { crimes: {}, slots: [], rewardItems: [], requiredItems: [] }
    }

    const crimeIds = crimes.map(c => c.crime_id)

    // Load slots for these crimes
    const { data: slots, error: slotsError } = await supabase
      .from('crime_slots')
      .select('*')
      .in('crime_id', crimeIds)

    if (slotsError) throw slotsError

    // Load reward items for these crimes
    const { data: rewardItems, error: rewardError } = await supabase
      .from('crime_reward_items')
      .select('*')
      .in('crime_id', crimeIds)

    if (rewardError) throw rewardError

    // Load required items for these crimes
    const { data: requiredItems, error: requiredError } = await supabase
      .from('crime_required_items')
      .select('*')
      .in('crime_id', crimeIds)

    if (requiredError) throw requiredError

    // Transform crimes array into object keyed by crime_id
    // Also attach slots, reward items, and required items to each crime
    const crimesMap = {}

    for (const crime of crimes) {
      const crimeId = crime.crime_id

      // Get slots for this crime
      const crimeSlots = (slots || []).filter(s => s.crime_id === crimeId)

      // Get reward items for this crime
      const crimeRewardItems = (rewardItems || []).filter(r => r.crime_id === crimeId)

      // Get required items for this crime
      const crimeRequiredItems = (requiredItems || []).filter(r => r.crime_id === crimeId)

      // Load members data for name enrichment if not already loaded
      let membersMap = {}
      if (Object.keys(membersMap).length === 0) {
        const { data: membersData, error: membersError } = await supabase
          .from('members')
          .select('member_id, member_name')

        if (!membersError && membersData) {
          membersData.forEach(m => {
            membersMap[m.member_id] = m.member_name
          })
        }
      }

      // Transform slots to match expected format with enriched member names
      const transformedSlots = crimeSlots.map(slot => ({
        position: slot.position,
        position_id: slot.position_id,
        position_number: slot.position_number,
        checkpoint_pass_rate: parseFloat(slot.checkpoint_pass_rate) || 0,
        user: slot.user_id ? {
          id: parseInt(slot.user_id),
          name: membersMap[slot.user_id] || slot.user_name || `User ${slot.user_id}`,
          joined_at: slot.joined_at,
          outcome: slot.user_outcome,
          progress: slot.user_progress,
          item_outcome: slot.item_outcome_id ? {
            item_id: slot.item_outcome_id,
            outcome: slot.item_outcome_outcome
          } : null
        } : null,
        item_requirement: slot.item_requirement_id ? {
          id: slot.item_requirement_id,
          name: slot.item_requirement_name,
          is_reusable: slot.item_requirement_is_reusable,
          is_available: slot.item_requirement_is_available
        } : null
      }))

      // Calculate total item reward value
      const itemRewardValue = crimeRewardItems.reduce((sum, item) => {
        return sum + ((item.unit_value || 0) * (item.quantity || 1))
      }, 0)

      // Calculate total consumed item cost
      const itemCostValue = crimeRequiredItems
        .filter(item => item.was_consumed)
        .reduce((sum, item) => sum + (item.unit_value || 0), 0)

      crimesMap[crimeId] = {
        id: crimeId,
        crime_id: crimeId,
        name: crime.name,
        difficulty: crime.difficulty,
        status: crime.status,
        created_at: crime.created_at,
        planning_at: crime.planning_at,
        executed_at: crime.executed_at,
        ready_at: crime.ready_at,
        expired_at: crime.expired_at,
        total_slots: crime.total_slots,
        filled_slots: crime.filled_slots,
        rewards: {
          money: crime.rewards_money || 0,
          respect: crime.rewards_respect || 0,
          items: crimeRewardItems.map(item => ({
            id: item.item_id,
            name: item.item_name,
            quantity: item.quantity,
            unit_value: item.unit_value,
            total_value: (item.unit_value || 0) * (item.quantity || 1)
          }))
        },
        slots: transformedSlots,
        reward_items: crimeRewardItems,
        required_items: crimeRequiredItems,
        // Computed values
        item_reward_value: itemRewardValue,
        item_cost_value: itemCostValue,
        net_item_value: itemRewardValue - itemCostValue,
        total_value: (crime.rewards_money || 0) + itemRewardValue - itemCostValue
      }
    }

    console.log(`Loaded ${Object.keys(crimesMap).length} crimes for payout calculation`)
    console.log(`  - Executed in window: ${(executedCrimes || []).length}`)
    console.log(`  - Lookback crimes (created before window): ${(lookbackCrimes || []).length}`)
    console.log(`  - In-progress: ${(inProgressCrimes || []).length}`)
    console.log(`  - Analysis window: ${new Date(fromTimestamp * 1000).toISOString()} to ${new Date(toTimestamp * 1000).toISOString()}`)
    console.log(`  - Data collection starts: ${new Date(dataFromTimestamp * 1000).toISOString()}`)

    return {
      crimes: crimesMap,
      slots: slots || [],
      rewardItems: rewardItems || [],
      requiredItems: requiredItems || []
    }

  } catch (error) {
    console.error('Error loading crimes for payout:', error)
    throw error
  }
}

/**
 * Load member data from Supabase
 * @returns {Promise<Object>} Members keyed by member_id
 */
export async function loadMembers() {
  try {
    const { data: members, error: membersError } = await supabase
      .from('members')
      .select('*')

    if (membersError) throw membersError

    // Also load CPR data
    const { data: cprData, error: cprError } = await supabase
      .from('member_cpr')
      .select('*')

    if (cprError) throw cprError

    // Transform to expected format
    const membersMap = {}

    for (const member of (members || [])) {
      const memberCpr = (cprData || []).filter(c => c.member_id === member.member_id)

      // Build cpr_by_role structure
      const cprByRole = {}
      for (const cpr of memberCpr) {
        if (!cprByRole[cpr.difficulty_level]) {
          cprByRole[cpr.difficulty_level] = {}
        }
        cprByRole[cpr.difficulty_level][cpr.role_name] = parseFloat(cpr.cpr_value)
      }

      membersMap[member.member_id] = {
        id: member.member_id,
        name: member.member_name,
        tier: member.tier_override || member.tier || 6,
        last_scraped: member.last_scraped,
        cpr_by_role: cprByRole
      }
    }

    return { members: membersMap }

  } catch (error) {
    console.error('Error loading members:', error)
    throw error
  }
}

/**
 * Load historical payout weeks
 * @param {number} limit - Max number of weeks to return
 * @returns {Promise<Array>} Array of payout weeks
 */
export async function loadPayoutWeeks(limit = 20) {
  try {
    const { data, error } = await supabase
      .from('oc_payout_weeks')
      .select('*')
      .order('week_end', { ascending: false })
      .limit(limit)

    if (error) throw error
    return data || []

  } catch (error) {
    console.error('Error loading payout weeks:', error)
    throw error
  }
}

/**
 * Load member payouts for a specific week
 * @param {number} weekId - Payout week ID
 * @returns {Promise<Array>} Array of member payouts
 */
export async function loadWeekMembers(weekId) {
  try {
    const { data, error } = await supabase
      .from('oc_payout_members')
      .select('*')
      .eq('week_id', weekId)
      .order('payout', { ascending: false })

    if (error) throw error
    return data || []

  } catch (error) {
    console.error('Error loading week members:', error)
    throw error
  }
}

/**
 * Load crimes for a specific payout week by week ID
 * @param {number} weekId - Payout week ID
 * @returns {Promise<Array>} Array of crimes
 */
export async function loadWeekCrimes(weekId) {
  try {
    const { data, error } = await supabase
      .from('crimes')
      .select('*')
      .eq('payout_week_id', weekId)
      .order('executed_at', { ascending: false })

    if (error) throw error
    return data || []

  } catch (error) {
    console.error('Error loading week crimes:', error)
    throw error
  }
}

/**
 * Load a specific member's payout history
 * @param {string} memberId - Member ID
 * @returns {Promise<Array>} Array of member's weekly payouts
 */
export async function loadMemberPayoutHistory(memberId) {
  try {
    const { data, error } = await supabase
      .from('oc_payout_members')
      .select(`
        *,
        oc_payout_weeks (
          week_start,
          week_end,
          member_payout_total,
          crimes_processed
        )
      `)
      .eq('member_id', memberId)
      .order('week_end', { ascending: false })

    if (error) throw error
    return data || []

  } catch (error) {
    console.error('Error loading member payout history:', error)
    throw error
  }
}

/**
 * Load a member's crime participation history
 * @param {string} memberId - Member ID
 * @param {number} limit - Max number of crimes to return
 * @returns {Promise<Array>} Array of crimes the member participated in
 */
export async function loadMemberCrimeHistory(memberId, limit = 100) {
  try {
    // First get all crime_slots where this member participated
    const { data: slots, error: slotsError } = await supabase
      .from('crime_slots')
      .select('crime_id, position, joined_at, checkpoint_pass_rate, user_outcome')
      .eq('user_id', memberId)
      .order('joined_at', { ascending: false })
      .limit(limit)

    if (slotsError) throw slotsError

    if (!slots || slots.length === 0) {
      return []
    }

    // Get the crime details
    const crimeIds = [...new Set(slots.map(s => s.crime_id))]

    const { data: crimes, error: crimesError } = await supabase
      .from('crimes')
      .select('*')
      .in('crime_id', crimeIds)
      .order('executed_at', { ascending: false })

    if (crimesError) throw crimesError

    // Merge crime details with slot info
    const crimesWithSlotInfo = (crimes || []).map(crime => {
      const memberSlot = slots.find(s => s.crime_id === crime.crime_id)
      return {
        ...crime,
        member_position: memberSlot?.position,
        member_joined_at: memberSlot?.joined_at,
        member_cpr: memberSlot?.checkpoint_pass_rate,
        member_outcome: memberSlot?.user_outcome
      }
    })

    return crimesWithSlotInfo

  } catch (error) {
    console.error('Error loading member crime history:', error)
    throw error
  }
}

/**
 * Load loaned items for a specific member
 * @param {string} memberId - Member ID
 * @returns {Promise<Array>} Array of loaned items
 */
export async function loadMemberLoanedItems(memberId) {
  try {
    // Query inventory_items where loaned_to contains this member ID
    const { data: items, error } = await supabase
      .from('inventory_items')
      .select('*')
      .gt('loaned', 0)

    if (error) throw error

    // Filter to items loaned to this specific member
    const memberItems = []

    for (const item of (items || [])) {
      if (!item.loaned_to) continue

      let loanedTo = item.loaned_to

      // Parse loaned_to if it's a string
      if (typeof loanedTo === 'string') {
        try {
          loanedTo = JSON.parse(loanedTo)
        } catch (e) {
          // If not JSON, might be comma-separated
          if (loanedTo.includes(',')) {
            loanedTo = loanedTo.split(',').map(id => id.trim())
          } else {
            loanedTo = [loanedTo]
          }
        }
      }

      // Check if member has any of these items
      let memberLoanCount = 0

      if (Array.isArray(loanedTo)) {
        memberLoanCount = loanedTo.filter(id => id.toString() === memberId.toString()).length
      } else if (typeof loanedTo === 'object') {
        memberLoanCount = loanedTo[memberId] || 0
      }

      if (memberLoanCount > 0) {
        memberItems.push({
          ...item,
          loaned_to_member: memberLoanCount
        })
      }
    }

    return memberItems

  } catch (error) {
    console.error('Error loading member loaned items:', error)
    throw error
  }
}

/**
 * Save payout week and link crimes
 * @param {Object} weekData - Week summary data
 * @param {Array} memberData - Array of member payout data
 * @param {Array} crimeIds - Array of crime IDs included in this payout
 * @param {string} savedBy - Username who saved this
 * @param {string} apiKey - Torn API key for authentication
 * @returns {Promise<Object>} Saved week data
 */
export async function savePayoutWeek(weekData, memberData, crimeIds, savedBy, apiKey) {
  try {
    // Prepare week record
    const weekRecord = {
      week_start: weekData.week_start,
      week_end: weekData.week_end,
      week_start_timestamp: weekData.week_start_timestamp,
      week_end_timestamp: weekData.week_end_timestamp,
      total_money_reward: weekData.total_money_reward || 0,
      total_item_reward: weekData.total_item_reward || 0,
      total_item_cost: weekData.total_item_cost || 0,
      net_item_value: weekData.net_item_value || 0,
      faction_cut_percent: weekData.faction_cut_percent || 20,
      faction_cut_amount: weekData.faction_cut_amount || 0,
      member_payout_total: weekData.member_payout_total || 0,
      total_member_payout: weekData.member_payout_total || 0,
      member_count: memberData.length,
      crimes_processed: weekData.crimes_processed || 0,
      total_time_spent: weekData.total_time_spent || 0,
      average_time_spent: weekData.average_time_spent || 0,
      total_adjusted_tickets: weekData.total_adjusted_tickets || 0,
      crime_ids: crimeIds || [],
      min_time_for_full_tickets: 432000,
      min_time_for_any_payout: 172800,
      saved_by: savedBy,
      saved_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }

    // Prepare member records
    const memberRecords = memberData.map(m => ({
      week_start: weekData.week_start,
      week_end: weekData.week_end,
      member_id: m.member_id || m.userId?.toString(),
      member_name: m.member_name || m.name,
      tier: m.tier,
      base_tickets: m.base_tickets || m.baseTickets || 0,
      sit_out_penalty: m.sit_out_penalty || m.sitOutPenalty || 0,
      adjusted_tickets: m.adjusted_tickets || m.adjustedTickets || 0,
      time_spent: m.time_spent || m.timeSpent || 0,
      time_spent_percent: m.time_spent_percent || m.timePercent || 0,
      share_percent: m.share_percent || (m.sharePercent ? m.sharePercent * 100 : 0),
      payout: m.payout || 0,
      theoretical_payout: m.theoretical_payout || m.theoreticalPayout || 0,
      crimes_count: m.crimes_count || m.crimesCount || 0,
      crimes_participated: m.crimes_participated || m.crimeIds || [],
      updated_at: new Date().toISOString()
    }))

    // Call Edge Function to save payout data
    const response = await adminApi.importPayoutData(weekRecord, memberRecords, apiKey)

    if (!response.success) {
      throw new Error(response.error || 'Failed to save payout week')
    }

    // If we have crime IDs to link, update them
    if (crimeIds && crimeIds.length > 0 && response.weekId) {
      // Update crimes to link to this payout week
      for (const crimeId of crimeIds) {
        await adminApi.adminUpdate(
          'crimes',
          { payout_week_id: response.weekId },
          { crime_id: crimeId },
          apiKey
        )
      }
    }

    return { id: response.weekId, ...weekRecord }

  } catch (error) {
    console.error('Error saving payout week:', error)
    throw error
  }
}