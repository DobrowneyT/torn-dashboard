import { supabase } from './supabase'

export async function syncCrimesFromAPI(apiKey, factionId) {
  try {
    const { data, error } = await supabase.functions.invoke('admin-db', {
      body: {
        action: 'sync_crimes'
      },
      headers: {
        'x-torn-api-key': apiKey,
      }
    })

    if (error) {
      return {
        success: false,
        error: error.message || 'Unknown error',
        crimesUpdated: 0,
        slotsUpdated: 0,
        rewardItemsUpdated: 0,
        requiredItemsUpdated: 0,
        errors: [error.message || 'Unknown error']
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

export function getSyncStatusMessage(result) {
  if (!result.success) {
    return `Sync failed: ${result.error}`
  }
  
  let msg = `Synced ${result.crimesUpdated} crimes, ${result.slotsUpdated} slots`

  if (result.rewardItemsUpdated > 0 || result.requiredItemsUpdated > 0) {
    msg += `, ${result.rewardItemsUpdated} reward items, ${result.requiredItemsUpdated} required items`
  }

  const pages = result.pagesFetched || 1
  msg += ` (${pages} API page${pages > 1 ? 's' : ''} fetched`
  if (result.fromTimestamp) {
    msg += `, from timestamp ${result.fromTimestamp}`
  }
  msg += ')'

  if (result.errors && result.errors.length > 0) {
    msg += ` (${result.errors.length} errors)`
  }
  
  return msg
}