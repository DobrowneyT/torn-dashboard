/**
 * Admin Database API
 * Handles all write operations through the Supabase Edge Function
 * Read operations still use the regular Supabase client with anon key
 */

const EDGE_FUNCTION_URL = import.meta.env.VITE_SUPABASE_URL + '/functions/v1/admin-db'

/**
 * Call the admin-db Edge Function
 * @param {string} action - The action to perform
 * @param {object} payload - Additional payload for the action
 * @param {string} tornApiKey - User's Torn API key for authentication
 * @returns {Promise<object>} Response from the Edge Function
 */
async function callAdminApi(action, payload, tornApiKey) {
  if (!tornApiKey) {
    throw new Error('Torn API key required for database writes')
  }

  const response = await fetch(EDGE_FUNCTION_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-torn-api-key': tornApiKey,
    },
    body: JSON.stringify({
      action,
      ...payload
    })
  })

  const data = await response.json()

  if (!response.ok) {
    throw new Error(data.error || `Request failed: ${response.status}`)
  }

  return data
}

/**
 * Upsert records to a table
 */
export async function adminUpsert(table, data, onConflict, tornApiKey) {
  return callAdminApi('upsert', { table, data, onConflict }, tornApiKey)
}

/**
 * Insert records to a table
 */
export async function adminInsert(table, data, tornApiKey) {
  return callAdminApi('insert', { table, data }, tornApiKey)
}

/**
 * Update records in a table
 */
export async function adminUpdate(table, data, filters, tornApiKey) {
  return callAdminApi('update', { table, data, filters }, tornApiKey)
}

/**
 * Delete records from a table
 */
export async function adminDelete(table, filters, tornApiKey) {
  return callAdminApi('delete', { table, filters }, tornApiKey)
}

/**
 * Clear all data from a table
 */
export async function adminClearTable(table, tornApiKey) {
  return callAdminApi('clear_table', { table }, tornApiKey)
}

/**
 * Sync crimes from Torn API to database
 */
export async function syncCrimesFromAPI(tornApiKey) {
  return callAdminApi('sync_crimes', {}, tornApiKey)
}

/**
 * Import CPR data from JSON
 */
export async function importCprData(membersData, tornApiKey) {
  return callAdminApi('import_cpr', { data: membersData }, tornApiKey)
}

/**
 * Import crimes data from JSON
 */
export async function importCrimesData(crimesData, tornApiKey) {
  return callAdminApi('import_crimes', { data: crimesData }, tornApiKey)
}

/**
 * Import payout data
 */
export async function importPayoutData(weekData, memberRecords, tornApiKey) {
  return callAdminApi('import_payout', { data: { weekData, memberRecords } }, tornApiKey)
}

/**
 * Sync inventory from Torn API
 */
export async function syncInventory(tornApiKey) {
  return callAdminApi('sync_inventory', {}, tornApiKey)
}

/**
 * Get status message from sync result
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