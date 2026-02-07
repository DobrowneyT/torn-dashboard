import { supabase } from './supabase'
import { parsePayoutCSV } from './payoutCalculations'
import * as adminApi from './adminApi'

/**
 * Import a payout CSV file
 * @param {File} file - CSV file with format YYYYMMDD-Forge_OC_Payout.csv
 * @param {string} apiKey - Torn API key for authentication
 * @param {string} userName - Name of user importing
 * @returns {Promise<Object>} Import result
 */
export async function importPayoutCSV(file, apiKey, userName) {
    try {
        // Validate inputs
        if (!apiKey) {
            throw new Error('API key is required for import. Please log out and log back in.')
        }

        if (!userName) {
            throw new Error('User name is required for import.')
        }

        console.log('Starting CSV import with user:', userName)

        // Parse week start from filename: "20251215-Forge_OC_Payout.csv"
        const dateMatch = file.name.match(/^(\d{8})/)
        if (!dateMatch) {
            throw new Error('Filename must start with date in YYYYMMDD format (e.g., 20251215-Forge_OC_Payout.csv)')
        }

        const dateStr = dateMatch[1]
        const year = parseInt(dateStr.substring(0, 4))
        const month = parseInt(dateStr.substring(4, 6)) - 1
        const day = parseInt(dateStr.substring(6, 8))

        // Week start is the date in the filename at 00:00:00 UTC
        const weekStart = new Date(Date.UTC(year, month, day, 0, 0, 0, 0))

        // Week end is 6 days later at 23:59:59 UTC
        const weekEnd = new Date(weekStart)
        weekEnd.setUTCDate(weekEnd.getUTCDate() + 6)
        weekEnd.setUTCHours(23, 59, 59, 999)

        const weekStartTs = Math.floor(weekStart.getTime() / 1000)
        const weekEndTs = Math.floor(weekEnd.getTime() / 1000)

        console.log('CSV Import Date Range:')
        console.log('  Week Start:', weekStart.toISOString(), '(', weekStartTs, ')')
        console.log('  Week End:', weekEnd.toISOString(), '(', weekEndTs, ')')

        // Parse the CSV
        const text = await file.text()
        const parsed = parsePayoutCSV(text)

        if (parsed.members.length === 0) {
            throw new Error('No valid member data found in CSV')
        }

        // Load crimes executed in this date range
        const { data: weekCrimes, error: crimesError } = await supabase
            .from('crimes')
            .select('crime_id, rewards_money, item_reward_value, item_cost_value')
            .gte('executed_at', weekStartTs)
            .lt('executed_at', weekEndTs)
            .eq('status', 'Successful')

        if (crimesError) throw crimesError

        const crimeIds = (weekCrimes || []).map(c => c.crime_id)

        console.log(`Found ${crimeIds.length} successful crimes in date range`)

        // Load crime slots for these crimes to determine member participation
        const { data: crimeSlots, error: slotsError } = await supabase
            .from('crime_slots')
            .select('crime_id, user_id')
            .in('crime_id', crimeIds)

        if (slotsError) throw slotsError

        // Build map of member participation
        const memberCrimeMap = {}
        for (const slot of (crimeSlots || [])) {
            if (!slot.user_id) continue

            const userId = slot.user_id.toString()
            if (!memberCrimeMap[userId]) {
                memberCrimeMap[userId] = {
                    crimesCount: 0,
                    crimeIds: []
                }
            }

            // Only count each crime once per member
            if (!memberCrimeMap[userId].crimeIds.includes(slot.crime_id)) {
                memberCrimeMap[userId].crimesCount++
                memberCrimeMap[userId].crimeIds.push(slot.crime_id)
            }
        }

        console.log(`Built participation map for ${Object.keys(memberCrimeMap).length} members`)

        // Calculate totals from crimes
        const totalMoneyReward = (weekCrimes || []).reduce((sum, c) => sum + (c.rewards_money || 0), 0)
        const totalItemReward = (weekCrimes || []).reduce((sum, c) => sum + (c.item_reward_value || 0), 0)
        const totalItemCost = (weekCrimes || []).reduce((sum, c) => sum + (c.item_cost_value || 0), 0)

        // Calculate the actual faction cut
        // Gross total = total money + item rewards - item costs
        const grossTotal = totalMoneyReward + totalItemReward - totalItemCost

        // Member payout is what's in the CSV (after faction cut was taken)
        // Faction cut = gross total - member payout
        const actualFactionCut = Math.max(0, grossTotal - parsed.totalPayout)
        const factionCutPercent = grossTotal > 0 ? (actualFactionCut / grossTotal) * 100 : 20

        console.log('Calculated totals:')
        console.log('  Money Reward:', totalMoneyReward)
        console.log('  Item Rewards:', totalItemReward)
        console.log('  Item Costs:', totalItemCost)
        console.log('  Gross Total:', grossTotal)
        console.log('  Member Payout from CSV:', parsed.totalPayout)
        console.log('  Calculated Faction Cut:', actualFactionCut, `(${factionCutPercent.toFixed(1)}%)`)

        // Enhance member data with crime participation
        const enhancedMembers = parsed.members.map(member => {
            const memberData = memberCrimeMap[member.member_id] || { crimesCount: 0, crimeIds: [] }

            return {
                ...member,
                crimes_count: memberData.crimesCount,
                crimes_participated: memberData.crimeIds
            }
        })

        console.log('Enhanced member data with participation counts')

        const weekData = {
            week_start: weekStart.toISOString().split('T')[0],
            week_end: weekEnd.toISOString().split('T')[0],
            week_start_timestamp: weekStartTs,
            week_end_timestamp: weekEndTs,
            total_money_reward: totalMoneyReward,
            total_item_reward: totalItemReward,
            total_item_cost: totalItemCost,
            net_item_value: totalItemReward - totalItemCost,
            faction_cut_percent: factionCutPercent,
            faction_cut_amount: Math.floor(grossTotal * (factionCutPercent / 100)),
            member_payout_total: parsed.totalPayout,
            crimes_processed: crimeIds.length,
            total_time_spent: parsed.totalTime,
            average_time_spent: parsed.memberCount > 0 ? Math.floor(parsed.totalTime / parsed.memberCount) : 0,
            total_adjusted_tickets: parsed.totalTickets
        }

        // Import using adminApi
        const response = await adminApi.importPayoutData(weekData, enhancedMembers, apiKey)

        if (!response.success) {
            throw new Error(response.error || 'Failed to import payout data')
        }

        return {
            success: true,
            weekStart: weekStart.toISOString().split('T')[0],
            memberCount: parsed.memberCount,
            crimesLinked: crimeIds.length,
            weekId: response.weekId
        }

    } catch (error) {
        console.error('Error importing CSV:', error)
        throw error
    }
}