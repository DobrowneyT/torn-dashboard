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

    // Phase 1: Load all crime queries in parallel
    // We need 4 categories to match the Google Sheets algorithm:
    // 1. Crimes executed within the payout window (for rewards + time)
    // 2. Crimes created before the window (lookback — members joined early, crime executed in window)
    // 3. Crimes still in Planning/Recruiting (in-progress — time tracking only)
    // 4. Crimes created during the window but executed AFTER it (time tracking only)
    //    These are no longer Planning/Recruiting, so query 3 misses them.
    //    They weren't executed in the window, so query 1 misses them.
    //    They weren't created before the window, so query 2 misses them.
    const [executedResult, lookbackResult, inProgressResult, postWindowResult] = await Promise.all([
      supabase
        .from('crimes')
        .select('*')
        .gte('executed_at', fromTimestamp)
        .lt('executed_at', toTimestamp)
        .order('executed_at', { ascending: false }),
      supabase
        .from('crimes')
        .select('*')
        .gte('created_at', dataFromTimestamp)
        .lt('created_at', fromTimestamp)
        .order('created_at', { ascending: false }),
      supabase
        .from('crimes')
        .select('*')
        .in('status', ['Planning', 'Recruiting'])
        .order('created_at', { ascending: false }),
      // Crimes created during the window that executed after it
      // (members were sitting in these crimes, accumulating time within the window)
      supabase
        .from('crimes')
        .select('*')
        .gte('created_at', fromTimestamp)
        .lt('created_at', toTimestamp)
        .gte('executed_at', toTimestamp)
        .order('executed_at', { ascending: false })
    ])

    if (executedResult.error) throw executedResult.error
    if (lookbackResult.error) throw lookbackResult.error
    if (inProgressResult.error) throw inProgressResult.error
    if (postWindowResult.error) throw postWindowResult.error

    const executedCrimes = executedResult.data || []
    const lookbackCrimes = lookbackResult.data || []
    const inProgressCrimes = inProgressResult.data || []
    const postWindowCrimes = postWindowResult.data || []

    // Combine and deduplicate
    const crimeMap = new Map()

    for (const crime of executedCrimes) {
      crimeMap.set(crime.crime_id, crime)
    }

    for (const crime of lookbackCrimes) {
      if (!crimeMap.has(crime.crime_id)) {
        crimeMap.set(crime.crime_id, crime)
      }
    }

    for (const crime of inProgressCrimes) {
      if (!crimeMap.has(crime.crime_id)) {
        crimeMap.set(crime.crime_id, crime)
      }
    }

    for (const crime of postWindowCrimes) {
      if (!crimeMap.has(crime.crime_id)) {
        crimeMap.set(crime.crime_id, crime)
      }
    }

    const crimes = Array.from(crimeMap.values())

    if (crimes.length === 0) {
      return { crimes: {}, slots: [], rewardItems: [], requiredItems: [] }
    }

    const crimeIds = crimes.map(c => c.crime_id)

    // Phase 2: Load all related data + members in parallel
    const [slotsResult, rewardResult, requiredResult, membersResult] = await Promise.all([
      supabase.from('crime_slots').select('*').in('crime_id', crimeIds),
      supabase.from('crime_reward_items').select('*').in('crime_id', crimeIds),
      supabase.from('crime_required_items').select('*').in('crime_id', crimeIds),
      supabase.from('members').select('member_id, member_name')
    ])

    if (slotsResult.error) throw slotsResult.error
    if (rewardResult.error) throw rewardResult.error
    if (requiredResult.error) throw requiredResult.error

    const slots = slotsResult.data || []
    const rewardItems = rewardResult.data || []
    const requiredItems = requiredResult.data || []

    // Build member name lookup map (loaded once, used for all crimes)
    const membersMap = {}
    if (!membersResult.error && membersResult.data) {
      membersResult.data.forEach(m => {
        membersMap[m.member_id] = m.member_name
      })
    }

    // Pre-index related data by crime_id for O(1) lookup instead of O(n) filtering
    const slotsByCrime = new Map()
    for (const slot of slots) {
      if (!slotsByCrime.has(slot.crime_id)) slotsByCrime.set(slot.crime_id, [])
      slotsByCrime.get(slot.crime_id).push(slot)
    }

    const rewardsByCrime = new Map()
    for (const item of rewardItems) {
      if (!rewardsByCrime.has(item.crime_id)) rewardsByCrime.set(item.crime_id, [])
      rewardsByCrime.get(item.crime_id).push(item)
    }

    const requiredByCrime = new Map()
    for (const item of requiredItems) {
      if (!requiredByCrime.has(item.crime_id)) requiredByCrime.set(item.crime_id, [])
      requiredByCrime.get(item.crime_id).push(item)
    }

    // Transform crimes array into object keyed by crime_id
    const crimesMap = {}

    for (const crime of crimes) {
      const crimeId = crime.crime_id

      // O(1) lookups from pre-indexed maps
      const crimeSlots = slotsByCrime.get(crimeId) || []
      const crimeRewardItems = rewardsByCrime.get(crimeId) || []
      const crimeRequiredItems = requiredByCrime.get(crimeId) || []

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
    console.log(`  - Executed in window: ${executedCrimes.length}`)
    console.log(`  - Lookback crimes (created before window): ${lookbackCrimes.length}`)
    console.log(`  - In-progress: ${inProgressCrimes.length}`)
    console.log(`  - Post-window (created during, executed after): ${postWindowCrimes.length}`)
    console.log(`  - Analysis window: ${new Date(fromTimestamp * 1000).toISOString()} to ${new Date(toTimestamp * 1000).toISOString()}`)
    console.log(`  - Data collection starts: ${new Date(dataFromTimestamp * 1000).toISOString()}`)

    return {
      crimes: crimesMap,
      slots: slots,
      rewardItems: rewardItems,
      requiredItems: requiredItems
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
    // Load members and CPR data in parallel
    const [membersResult, cprResult] = await Promise.all([
      supabase.from('members').select('*'),
      supabase.from('member_cpr').select('*')
    ])

    if (membersResult.error) throw membersResult.error
    if (cprResult.error) throw cprResult.error

    const members = membersResult.data || []
    const cprData = cprResult.data || []

    // Pre-index CPR data by member_id for O(1) lookup
    const cprByMember = new Map()
    for (const cpr of cprData) {
      if (!cprByMember.has(cpr.member_id)) cprByMember.set(cpr.member_id, [])
      cprByMember.get(cpr.member_id).push(cpr)
    }

    // Transform to expected format
    const membersMap = {}

    for (const member of members) {
      const memberCpr = cprByMember.get(member.member_id) || []

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
        is_current: member.is_current,
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

    // Pre-index slots by crime_id for efficient merging
    const slotsByCrime = new Map()
    for (const slot of slots) {
      if (!slotsByCrime.has(slot.crime_id)) slotsByCrime.set(slot.crime_id, slot)
    }

    // Merge crime details with slot info
    const crimesWithSlotInfo = (crimes || []).map(crime => {
      const memberSlot = slotsByCrime.get(crime.crime_id)
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
    // Query the view with prices so we get market_value/weighted_avg_price
    const { data: items, error } = await supabase
      .from('inventory_items_with_prices')
      .select('*')
      .gt('loaned', 0)

    if (error) {
      // Fallback to raw table if view doesn't exist
      console.warn('Falling back to inventory_items table:', error.message)
      const { data: rawItems, error: rawError } = await supabase
        .from('inventory_items')
        .select('*')
        .gt('loaned', 0)

      if (rawError) throw rawError
      return filterItemsForMember(rawItems, memberId)
    }

    return filterItemsForMember(items, memberId)

  } catch (error) {
    console.error('Error loading member loaned items:', error)
    throw error
  }
}

/**
 * Filter inventory items to those loaned to a specific member
 * @param {Array} items - All loaned inventory items
 * @param {string} memberId - Member ID to filter for
 * @returns {Array} Items loaned to this member with normalized fields
 */
function filterItemsForMember(items, memberId) {
  const memberItems = []

  for (const item of (items || [])) {
    if (!item.loaned_to) continue

    let loanedTo = item.loaned_to

    // Parse loaned_to into an array of user ID strings
    if (typeof loanedTo === 'string') {
      // Comma-separated is the most common format from Torn API
      // e.g. "2250591" or "2250591,2749598,3228747"
      if (loanedTo.includes(',')) {
        loanedTo = loanedTo.split(',').map(id => id.trim())
      } else if (loanedTo.startsWith('{') || loanedTo.startsWith('[')) {
        // JSON object or array
        try {
          loanedTo = JSON.parse(loanedTo)
        } catch (e) {
          loanedTo = [loanedTo]
        }
      } else {
        // Single ID as string, e.g. "2250591"
        loanedTo = [loanedTo]
      }
    }

    // Normalize to number → single-element array
    if (typeof loanedTo === 'number') {
      loanedTo = [loanedTo.toString()]
    }

    // Check if member has any of these items
    let memberLoanCount = 0

    if (Array.isArray(loanedTo)) {
      memberLoanCount = loanedTo.filter(id => id.toString() === memberId.toString()).length
    } else if (typeof loanedTo === 'object' && loanedTo !== null) {
      memberLoanCount = loanedTo[memberId] || 0
    }

    if (memberLoanCount > 0) {
      // Normalize field names across table/view differences
      const itemName = item.item_name || item.name || `Item ${item.item_id || item.id}`
      const marketValue = parseFloat(item.weighted_avg_price) || parseFloat(item.market_value) || 0
      memberItems.push({
        ...item,
        name: itemName,
        item_name: itemName,
        market_value: marketValue,
        loaned_to_member: memberLoanCount
      })
    }
  }

  return memberItems
}

/**
 * Check if a payout week already exists for the given date range.
 * Used to warn users before overwriting an existing payout.
 *
 * @param {string} weekStart - ISO date string (e.g. '2026-03-16')
 * @param {string} weekEnd - ISO date string (e.g. '2026-03-22')
 * @returns {Promise<Object|null>} Existing week record or null
 */
export async function checkExistingWeek(weekStart, weekEnd) {
  try {
    const { data, error } = await supabase
      .from('oc_payout_weeks')
      .select('id, week_start, week_end, saved_at, saved_by, member_count, member_payout_total')
      .eq('week_start', weekStart)
      .eq('week_end', weekEnd)
      .limit(1)
      .single()

    if (error) {
      // PGRST116 = no rows found, which is expected when no week exists
      if (error.code === 'PGRST116') return null
      throw error
    }
    return data
  } catch (error) {
    console.error('Error checking existing week:', error)
    return null
  }
}

/**
 * Save payout week and link crimes
 * Now sends crimeIds to the Edge Function so crime linking happens server-side
 * in a single bulk update instead of N individual round-trips.
 *
 * @param {Object} weekData - Week summary data
 * @param {Array} memberData - Array of member payout data
 * @param {Array} crimeIds - Array of crime IDs included in this payout
 * @param {string} savedBy - Username who saved this
 * @param {string} apiKey - Torn API key for authentication
 * @returns {Promise<Object>} Saved week data
 */
export async function savePayoutWeek(weekData, memberData, crimeIds, savedBy, apiKey) {
  try {
    // Prepare week record — floor all numeric values to avoid bigint errors
    const weekRecord = {
      week_start: weekData.week_start,
      week_end: weekData.week_end,
      week_start_timestamp: weekData.week_start_timestamp,
      week_end_timestamp: weekData.week_end_timestamp,
      total_money_reward: Math.floor(weekData.total_money_reward || 0),
      total_item_reward: Math.floor(weekData.total_item_reward || 0),
      total_item_cost: Math.floor(weekData.total_item_cost || 0),
      net_item_value: Math.floor(weekData.net_item_value || 0),
      faction_cut_percent: weekData.faction_cut_percent || 20,
      faction_cut_amount: Math.floor(weekData.faction_cut_amount || 0),
      member_payout_total: Math.floor(weekData.member_payout_total || 0),
      total_member_payout: Math.floor(weekData.member_payout_total || 0),
      member_count: memberData.length,
      crimes_processed: Math.floor(weekData.crimes_processed || 0),
      total_time_spent: Math.floor(weekData.total_time_spent || 0),
      average_time_spent: Math.floor(weekData.average_time_spent || 0),
      total_adjusted_tickets: Math.floor(weekData.total_adjusted_tickets || 0),
      crime_ids: crimeIds || [],
      min_time_for_full_tickets: 432000,
      min_time_for_any_payout: 172800
    }

    // Prepare member records
    const memberRecords = memberData.map(m => ({
      week_start: weekRecord.week_start,
      week_end: weekRecord.week_end,
      member_id: m.member_id || m.userId?.toString(),
      member_name: m.member_name || m.name,
      tier: m.tier,
      base_tickets: Math.floor(m.base_tickets || m.baseTickets || 0),
      sit_out_penalty: Math.floor(m.sit_out_penalty || m.sitOutPenalty || 0),
      adjusted_tickets: Math.floor(m.adjusted_tickets || m.adjustedTickets || 0),
      time_spent: Math.floor(m.time_spent || m.timeSpent || 0),
      time_spent_percent: m.time_spent_percent || m.timePercent || 0,
      share_percent: m.share_percent || (m.sharePercent ? m.sharePercent * 100 : 0),
      payout: Math.floor(m.payout || 0),
      theoretical_payout: Math.floor(m.theoretical_payout || m.theoreticalPayout || 0),
      crimes_count: Math.floor(m.crimes_count || m.crimesCount || 0),
      crimes_participated: m.crimes_participated || m.crimeIds || []
    }))

    // Single Edge Function call: saves week, members, AND links crimes
    const response = await adminApi.importPayoutData(
      weekRecord,
      memberRecords,
      apiKey,
      crimeIds && crimeIds.length > 0 ? crimeIds : null
    )

    if (!response.success) {
      throw new Error(response.error || 'Failed to save payout week')
    }

    const weekId = response.weekId

    console.log(`Saved payout week ${weekId} with ${memberRecords.length} members and ${(crimeIds || []).length} crimes`)

    return { id: weekId, ...weekRecord }

  } catch (error) {
    console.error('Error saving payout week:', error)
    throw error
  }
}