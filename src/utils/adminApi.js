/**
 * Admin Database API
 * Handles all write operations through the Supabase Edge Function
 * Read operations still use the regular Supabase client with anon key
 */

const EDGE_FUNCTION_URL = import.meta.env.VITE_SUPABASE_URL + '/functions/v1/admin-db'
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

/**
 * Call the admin-db Edge Function
 * @param {string} action - The action to perform
 * @param {object} payload - Additional payload for the action
 * @param {string} tornApiKey - User's Torn API key for authentication
 * @returns {Promise<object>} Response from the Edge Function
 */
async function callAdminApi(action, payload, tornApiKey) {
  if (!tornApiKey) {
    console.error('callAdminApi called without API key')
    throw new Error('Torn API key required for database writes')
  }

  const response = await fetch(EDGE_FUNCTION_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Anon key satisfies the Supabase gateway; real auth happens inside
      // the function via verifyTornUser(x-torn-api-key).
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'apikey': SUPABASE_ANON_KEY,
      'x-torn-api-key': tornApiKey,
    },
    body: JSON.stringify({
      action,
      ...payload
    })
  })

  const data = await response.json()

  if (!response.ok) {
    console.error('Admin API error:', response.status, data)
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
 * Import payout data (week + members + optional crime linking in one call)
 */
export async function importPayoutData(weekData, memberRecords, tornApiKey, crimeIds = null) {
  return callAdminApi('import_payout', { 
    data: { 
      weekData, 
      memberRecords,
      crimeIds
    } 
  }, tornApiKey)
}

/**
 * Batch link crimes to a payout week (single call instead of N calls)
 */
export async function batchLinkCrimes(crimeIds, weekId, tornApiKey) {
  return callAdminApi('batch_link_crimes', { crimeIds, weekId }, tornApiKey)
}

/**
 * Sync inventory from Torn API
 */
export async function syncInventory(tornApiKey) {
  return callAdminApi('sync_inventory', {}, tornApiKey)
}

/**
 * Sync members from Torn API
 */
export async function syncMembers(tornApiKey) {
  return callAdminApi('sync_members', {}, tornApiKey)
}

/**
 * Save war payout (configuration + per-member results) to database.
 * If a payout already exists for this war_id, it is overwritten.
 *
 * @param {object} payoutData - Fields for the war_payouts table
 * @param {Array} memberRecords - Array of member payout records
 * @param {string} tornApiKey
 * @returns {Promise<{success: boolean, payoutId: number, memberCount: number}>}
 */
export async function saveWarPayout(payoutData, memberRecords, tornApiKey) {
  return callAdminApi('save_war_payout', { data: { payoutData, memberRecords } }, tornApiKey)
}

/**
 * Submit a CPR scraper API key for the logged-in member.
 * Pass an empty string to remove the key.
 *
 * @param {string} cprApiKey - The member's Torn API key for CPR scraping
 * @param {string} tornApiKey - User's login Torn API key for auth
 */
export async function submitCprKey(cprApiKey, tornApiKey) {
  return callAdminApi('submit_cpr_key', { data: { cpr_api_key: cprApiKey } }, tornApiKey)
}

/**
 * Toggle the is_termed flag on a war record.
 * Only the is_termed field is updated — all other war fields are left unchanged.
 *
 * @param {number} warId - Torn war ID
 * @param {boolean} isTermed
 * @param {string} tornApiKey
 */
export async function updateWarIsTermed(warId, isTermed, tornApiKey) {
  return callAdminApi('update_war_is_termed', { data: { war_id: warId, is_termed: isTermed } }, tornApiKey)
}

/**
 * Fetch new faction attacks from the Torn API and upsert into Supabase.
 * Incremental — reads the newest stored attack's `started` timestamp and
 * pages forward from there. Capped at 30 pages per call (~3,000 attacks).
 * If `moreAvailable` is true in the result, run again to continue.
 *
 * Returns { success, attacksUpserted, pagesFetched, moreAvailable,
 *           factionsBackfilled, fromTimestamp }.
 */
export async function fetchAttacks(tornApiKey) {
  return callAdminApi('fetch_attacks', {}, tornApiKey)
}

/**
 * Fetch ranked wars + per-war reports from the Torn API and upsert into
 * Supabase. Diffs against the DB to fetch reports only for newly-completed
 * wars. Preserves the manual `is_termed` UI flag on each war.
 *
 * Returns { success, warsUpserted, reportsFetched, reportsFailedPermanent,
 *           contributionsUpserted, moreReportsAvailable }.
 */
export async function fetchWars(tornApiKey) {
  return callAdminApi('fetch_wars', {}, tornApiKey)
}

/**
 * Fetch all incoming revives for one ranked war and upsert into
 * faction_revives. Re-running over the same war is a no-op because the
 * server-side handler uses ignoreDuplicates on revive_id.
 *
 * Returns { success, war_id, opponent, window: {from, to, live},
 *           revivesFetched, revivesNew, revivesUpserted,
 *           pagesFetched, moreAvailable, partial, partialReason }.
 */
export async function fetchRevives(warId, tornApiKey) {
  return callAdminApi('fetch_revives', { war_id: warId }, tornApiKey)
}

// ── Member Overview view + threshold CRUD (leadership only) ────────────────
// Read paths still use the supabase client directly (gated by RLS). Writes
// go through admin-db so the leadership check is server-side and the
// per-table write policies can stay tightly scoped.

export async function createOverviewView({ name, columns, user }, tornApiKey) {
  return callAdminApi('manage_overview_view', {
    data: { op: 'create', name, columns, user_name: user?.name ?? null },
  }, tornApiKey)
}

export async function updateOverviewView(id, { name, columns }, tornApiKey) {
  return callAdminApi('manage_overview_view', {
    data: { op: 'update', id, name, columns },
  }, tornApiKey)
}

export async function deleteOverviewView(id, tornApiKey) {
  return callAdminApi('manage_overview_view', {
    data: { op: 'delete', id },
  }, tornApiKey)
}

export async function createOverviewThreshold({ name, thresholds, user }, tornApiKey) {
  return callAdminApi('manage_overview_threshold', {
    data: { op: 'create', name, thresholds, user_name: user?.name ?? null },
  }, tornApiKey)
}

export async function updateOverviewThreshold(id, { name, thresholds }, tornApiKey) {
  return callAdminApi('manage_overview_threshold', {
    data: { op: 'update', id, name, thresholds },
  }, tornApiKey)
}

export async function deleteOverviewThreshold(id, tornApiKey) {
  return callAdminApi('manage_overview_threshold', {
    data: { op: 'delete', id },
  }, tornApiKey)
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