/**
 * Sync crimes from Torn API to Supabase via Edge Function
 * All write operations go through the admin-db Edge Function for RLS compliance
 */

const EDGE_FUNCTION_URL = import.meta.env.VITE_SUPABASE_URL + '/functions/v1/admin-db'

/**
 * Sync crimes from Torn API to Supabase
 * @param {string} apiKey - Torn API key (used for both Torn API auth and Edge Function auth)
 * @param {string} factionId - Faction ID (not used - faction is configured in Edge Function)
 * @returns {Promise<Object>} Sync results
 */
export async function syncCrimesFromAPI(apiKey, factionId) {
  try {
    const response = await fetch(EDGE_FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-torn-api-key': apiKey,
      },
      body: JSON.stringify({
        action: 'sync_crimes'
      })
    })

    const data = await response.json()

    if (!response.ok) {
      return {
        success: false,
        error: data.error || `Request failed: ${response.status}`,
        crimesUpdated: 0,
        slotsUpdated: 0,
        rewardItemsUpdated: 0,
        requiredItemsUpdated: 0,
        errors: [data.error || 'Unknown error']
      }
    }

    return data
    
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