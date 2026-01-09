/**
 * Sync crimes from Torn API to Supabase
 * Handles the API response correctly (array format) and populates item tables
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
    
    // API returns crimes as an array, not an object
    const crimesArray = data.crimes || []
    
    let crimesUpdated = 0
    let slotsUpdated = 0
    let rewardItemsUpdated = 0
    let requiredItemsUpdated = 0
    const errors = []
    
    for (const crimeData of crimesArray) {
      try {
        const crimeId = crimeData.id.toString()
        
        // Upsert crime record
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
            user_id: user.id?.toString() || null,
            user_name: user.name || null,
            joined_at: user.joined_at || null,
            user_outcome: user.outcome || null,
            user_progress: user.progress || null,
            item_requirement_id: itemReq.id?.toString() || null,
            item_requirement_name: itemReq.name || null,
            item_requirement_is_reusable: itemReq.is_reusable || false,
            item_requirement_is_available: itemReq.is_available || false,
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
        
        // Process REWARD items (from rewards.items array)
        const rewardItems = crimeData.rewards?.items || []
        for (const rewardItem of rewardItems) {
          const itemId = rewardItem.id?.toString()
          if (!itemId) continue
          
          // Check if record already exists
          const { data: existing } = await supabase
            .from('crime_reward_items')
            .select('id, unit_value')
            .eq('crime_id', crimeId)
            .eq('item_id', itemId)
            .single()
          
          if (!existing) {
            // Create new record with value = 0
            const { error: rewardError } = await supabase
              .from('crime_reward_items')
              .insert({
                crime_id: crimeId,
                item_id: itemId,
                item_name: rewardItem.name || null,
                quantity: rewardItem.quantity || 1,
                unit_value: 0,
                total_value: 0,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
              })
            
            if (rewardError) {
              errors.push(`Reward item ${itemId} for crime ${crimeId}: ${rewardError.message}`)
            } else {
              rewardItemsUpdated++
            }
          } else {
            // Record exists - only update quantity if changed, preserve value
            const { error: updateError } = await supabase
              .from('crime_reward_items')
              .update({
                quantity: rewardItem.quantity || 1,
                item_name: rewardItem.name || existing.item_name,
                updated_at: new Date().toISOString()
              })
              .eq('id', existing.id)
            
            if (!updateError) rewardItemsUpdated++
          }
        }
        
        // Process REQUIRED items (from slots with item_requirement)
        for (const slot of slots) {
          const itemReq = slot.item_requirement
          if (!itemReq || !itemReq.id) continue
          
          const itemId = itemReq.id.toString()
          const user = slot.user || {}
          const itemOutcome = user.item_outcome || {}
          const wasConsumed = itemOutcome.outcome === 'used'
          
          // Check if record already exists
          const { data: existing } = await supabase
            .from('crime_required_items')
            .select('id, unit_value')
            .eq('crime_id', crimeId)
            .eq('position_id', slot.position_id)
            .single()
          
          if (!existing) {
            // Create new record with value = 0
            const { error: reqError } = await supabase
              .from('crime_required_items')
              .insert({
                crime_id: crimeId,
                position: slot.position,
                position_id: slot.position_id,
                position_number: slot.position_number,
                item_id: itemId,
                item_name: itemReq.name || null,
                is_reusable: itemReq.is_reusable || false,
                is_available: itemReq.is_available || false,
                user_id: user.id?.toString() || null,
                outcome_owned_by: itemOutcome.owned_by || null,
                outcome_item_id: itemOutcome.item_id?.toString() || null,
                outcome_item_uid: itemOutcome.item_uid?.toString() || null,
                outcome: itemOutcome.outcome || null,
                was_consumed: wasConsumed,
                unit_value: 0,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
              })
            
            if (reqError) {
              errors.push(`Required item for crime ${crimeId} slot ${slot.position_id}: ${reqError.message}`)
            } else {
              requiredItemsUpdated++
            }
          } else {
            // Record exists - update outcome fields but preserve value
            const { error: updateError } = await supabase
              .from('crime_required_items')
              .update({
                user_id: user.id?.toString() || null,
                outcome_owned_by: itemOutcome.owned_by || null,
                outcome_item_id: itemOutcome.item_id?.toString() || null,
                outcome_item_uid: itemOutcome.item_uid?.toString() || null,
                outcome: itemOutcome.outcome || null,
                was_consumed: wasConsumed,
                updated_at: new Date().toISOString()
              })
              .eq('id', existing.id)
            
            if (!updateError) requiredItemsUpdated++
          }
        }
        
      } catch (err) {
        errors.push(`Crime ${crimeData.id}: ${err.message}`)
      }
    }
    
    return {
      success: true,
      crimesTotal: crimesArray.length,
      crimesUpdated,
      slotsUpdated,
      rewardItemsUpdated,
      requiredItemsUpdated,
      errors
    }
    
  } catch (error) {
    return {
      success: false,
      error: error.message,
      crimesUpdated: 0,
      slotsUpdated: 0,
      rewardItemsUpdated: 0,
      requiredItemsUpdated: 0,
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
  
  let msg = `Synced ${result.crimesUpdated} crimes, ${result.slotsUpdated} slots`
  
  if (result.rewardItemsUpdated > 0 || result.requiredItemsUpdated > 0) {
    msg += `, ${result.rewardItemsUpdated} reward items, ${result.requiredItemsUpdated} required items`
  }
  
  if (result.errors && result.errors.length > 0) {
    msg += ` (${result.errors.length} errors)`
  }
  
  return msg
}