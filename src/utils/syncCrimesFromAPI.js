/**
 * Sync crimes from Torn API to Supabase
 * Can be called from frontend to get latest crime data
 */

import { supabase } from './supabase'

/**
 * Fetch crimes from Torn API and sync to Supabase
 * @param {string} apiKey - Torn API key
 * @param {string} factionId - Faction ID
 * @returns {Promise<Object>} Sync results
 */
export async function syncCrimesFromAPI(apiKey, factionId) {
  try {
    // Fetch crimes from Torn API
    const response = await fetch(
      `https://api.torn.com/v2/faction/${factionId}/crimes?key=${apiKey}`
    )
    
    if (!response.ok) {
      throw new Error(`Torn API error: ${response.status}`)
    }
    
    const data = await response.json()
    
    if (data.error) {
      throw new Error(data.error.error || 'API error')
    }
    
    const crimes = data.crimes || {}
    const crimeIds = Object.keys(crimes)
    
    let crimesUpdated = 0
    let slotsUpdated = 0
    const errors = []
    
    // Process each crime
    for (const [crimeId, crimeData] of Object.entries(crimes)) {
      try {
        // Upsert crime
        const { error: crimeError } = await supabase
          .from('crimes')
          .upsert({
            crime_id: crimeId,
            name: crimeData.name || 'Unknown',
            difficulty: crimeData.difficulty || 1,
            status: crimeData.status || 'Unknown',
            previous_crime_id: crimeData.previous_crime_id?.toString() || null,
            created_at: crimeData.created_at || null,
            planning_at: crimeData.planning_at || null,
            executed_at: crimeData.executed_at || null,
            ready_at: crimeData.ready_at || null,
            expired_at: crimeData.expired_at || null,
            total_slots: crimeData.total_slots || 0,
            filled_slots: crimeData.filled_slots || 0,
            rewards_money: crimeData.rewards?.money || 0,
            rewards_respect: crimeData.rewards?.respect || 0,
            rewards_items: crimeData.rewards?.items ? JSON.stringify(crimeData.rewards.items) : null,
            last_updated: new Date().toISOString(),
            first_seen: crimeData.first_seen || new Date().toISOString(),
            updated_at: new Date().toISOString()
          }, {
            onConflict: 'crime_id'
          })
        
        if (crimeError) {
          errors.push(`Crime ${crimeId}: ${crimeError.message}`)
          continue
        }
        
        crimesUpdated++
        
        // Process slots
        const slots = crimeData.slots || []
        const slotRecords = slots.map(slot => {
          const user = slot.user || {}
          const itemReq = slot.item_requirement || {}
          const itemOutcome = user.item_outcome || {}
          
          return {
            crime_id: crimeId,
            position: slot.position,
            position_id: slot.position_id,
            position_number: slot.position_number,
            checkpoint_pass_rate: slot.checkpoint_pass_rate,
            
            // User info
            user_id: user.id?.toString() || null,
            user_name: user.name || null,
            joined_at: user.joined_at || null,
            user_outcome: user.outcome || null,
            user_progress: user.progress || null,
            
            // Item requirement
            item_requirement_id: itemReq.id?.toString() || null,
            item_requirement_name: itemReq.name || null,
            item_requirement_is_reusable: itemReq.is_reusable || false,
            item_requirement_is_available: itemReq.is_available || false,
            
            // Item outcome
            item_outcome_id: itemOutcome.item_id?.toString() || null,
            item_outcome_outcome: itemOutcome.outcome || null,
            
            updated_at: new Date().toISOString()
          }
        })
        
        if (slotRecords.length > 0) {
          const { error: slotError } = await supabase
            .from('crime_slots')
            .upsert(slotRecords, {
              onConflict: 'crime_id,position_id'
            })
          
          if (slotError) {
            errors.push(`Slots for crime ${crimeId}: ${slotError.message}`)
          } else {
            slotsUpdated += slotRecords.length
          }
        }
        
      } catch (err) {
        errors.push(`Crime ${crimeId}: ${err.message}`)
      }
    }
    
    return {
      success: true,
      crimesTotal: crimeIds.length,
      crimesUpdated,
      slotsUpdated,
      errors
    }
    
  } catch (error) {
    return {
      success: false,
      error: error.message,
      crimesUpdated: 0,
      slotsUpdated: 0,
      errors: [error.message]
    }
  }
}

/**
 * Get sync status message
 */
export function getSyncStatusMessage(result) {
  if (!result.success) {
    return `Sync failed: ${result.error}`
  }
  
  if (result.errors.length > 0) {
    return `Synced ${result.crimesUpdated} crimes with ${result.errors.length} errors`
  }
  
  return `Successfully synced ${result.crimesUpdated} crimes and ${result.slotsUpdated} slots`
}