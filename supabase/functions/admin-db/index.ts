// DEPLOYMENT NOTE: This function must be deployed with --no-verify-jwt flag
// Deploy command: npx supabase functions deploy admin-db --no-verify-jwt
// This function uses custom Torn API key authentication instead of Supabase JWT


// Command to get DB schema for all tables as well as RLS policies:
// SELECT
//     t.table_name,
//     c.column_name,
//     c.data_type,
//     c.character_maximum_length,
//     c.is_nullable,
//     c.column_default,
//     c.ordinal_position
// FROM information_schema.tables t
// JOIN information_schema.columns c
//     ON t.table_name = c.table_name
//     AND t.table_schema = c.table_schema
// WHERE t.table_schema = 'public'
//     AND t.table_type = 'BASE TABLE'
// ORDER BY t.table_name, c.ordinal_position;


// SELECT
//     schemaname,
//     tablename,
//     policyname,
//     permissive,
//     roles,
//     cmd,
//     qual,
//     with_check
// FROM pg_policies
// WHERE schemaname = 'public'
// ORDER BY tablename, policyname;


// SELECT
//     t.tablename,
//     t.rowsecurity AS rls_enabled,
//     COUNT(p.policyname) AS policy_count,
//     string_agg(p.policyname, ', ') AS policy_names
// FROM pg_tables t
// LEFT JOIN pg_policies p
//     ON t.tablename = p.tablename
//     AND t.schemaname = p.schemaname
// WHERE t.schemaname = 'public'
// GROUP BY t.tablename, t.rowsecurity
// ORDER BY t.tablename;

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-torn-api-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// Leadership user IDs who can perform admin operations
const LEADERSHIP_IDS = ['2250591', '2749598', '2264192', '2407528', '2932241', '2015160']
const FACTION_ID = '10739'

// Rate limit between Torn API calls for handlers that paginate or fan out.
// Matches scripts/utils/torn_api.py — ~100 req/min is the Torn budget.
// At 30 pages this caps the fetch_attacks worst-case at ~18s of waits.
const TORN_RATE_LIMIT_MS = 600

// Torn API error codes that mean "permanently unavailable" for a war report
// (war too old, invalid id, etc). Mirrors PERMANENT_API_ERROR_CODES in
// scripts/war_data_update.py. Reports for these wars can't be fetched no
// matter how many times we try; we still attempt once per fetch_wars call
// since the DB has no permanent-fail flag — extra failed calls are cheap.
const PERMANENT_WAR_REPORT_ERROR_CODES = new Set([2, 7, 13, 14])

// Torn error codes that are transient and worth retrying later, not failing
// the whole user-initiated fetch. Includes rate limit (5), IP block (8), API
// disabled (9), and Torn backend error (17). Per the Torn API docs.
const TRANSIENT_TORN_ERROR_CODES = new Set([5, 8, 9, 17])

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// Full-access DB key for this server-side function (bypasses RLS; never runs in
// a browser). Prefer the new-format secret key, which Supabase auto-populates as
// the SUPABASE_SECRET_KEYS JSON dict — { "default": "sb_secret_…" } — once secret
// keys exist on the API Keys page. Fall back to the legacy service_role key so
// nothing breaks while migrating. Once the new key is live everywhere, the
// leaked legacy service_role key can be disabled in the dashboard.
function resolveSecretKey(): string {
  const dict = Deno.env.get('SUPABASE_SECRET_KEYS')
  if (dict) {
    try {
      const key = JSON.parse(dict)?.default
      if (key) return key
    } catch { /* malformed dict — fall back to legacy */ }
  }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
}

// Fetch from Torn and classify the result so callers can decide whether to
// bail (fatal) or return a partial-success summary (transient). HTTP 5xx and
// the transient Torn error codes above are treated as transient — typically
// "your API key got rate-limited" or "Torn is briefly down". Everything else
// is fatal.
type TornFetchResult<T = any> =
  | { ok: true; data: T }
  | { ok: false; transient: true; message: string }
  | { ok: false; transient: false; message: string }

async function tornFetch<T = any>(url: string): Promise<TornFetchResult<T>> {
  try {
    const resp = await fetch(url)
    if (!resp.ok) {
      const transient = resp.status >= 500 && resp.status < 600
      return { ok: false, transient, message: `Torn API HTTP ${resp.status}` }
    }
    const data = await resp.json()
    if (data?.error) {
      const code = Number(data.error.code ?? 0)
      const msg = data.error.error || `Torn error ${code}`
      const transient = TRANSIENT_TORN_ERROR_CODES.has(code)
      return { ok: false, transient, message: `Torn error ${code}: ${msg}` }
    }
    return { ok: true, data: data as T }
  } catch (e) {
    // Network / fetch failure — usually transient
    return { ok: false, transient: true, message: `Torn fetch failed: ${e}` }
  }
}

// In-memory auth cache: keyed by API key, stores { userId, expiresAt }
// TTL = 10 minutes. Resets on Edge Function cold start, which is fine.
const AUTH_CACHE_TTL_MS = 10 * 60 * 1000
const authCache = new Map<string, { userId: string; expiresAt: number }>()

interface RequestBody {
  action: string
  table?: string
  data?: any
  filters?: Record<string, any>
  onConflict?: string
  crimeIds?: string[]
  weekId?: number
  war_id?: number
}

serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Get the Torn API key from header for authentication
    const tornApiKey = req.headers.get('x-torn-api-key')

    if (!tornApiKey) {
      console.error('No API key found in headers')
      return new Response(
        JSON.stringify({ error: 'Missing Torn API key' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Verify the user is authorized (with caching)
    const authResult = await verifyTornUser(tornApiKey)

    if (!authResult.success) {
      return new Response(
        JSON.stringify({ error: authResult.error }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Create Supabase client with a full-access key (bypasses RLS; server-side
    // only). Prefer the new-format secret key from the auto-populated
    // SUPABASE_SECRET_KEYS JSON dict — { "default": "sb_secret_…" } — and fall
    // back to the legacy service_role key so nothing breaks while migrating.
    // Once the new key is live, disable the leaked legacy key in the dashboard.
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = resolveSecretKey()

    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    })

    // Parse request body
    const body: RequestBody = await req.json()

    // SECURITY: the generic arbitrary-table CRUD actions run under the
    // service-role client and so bypass RLS entirely — they can read, mutate,
    // or wipe ANY table. verifyTornUser() only proves the caller is a faction
    // member, which is NOT enough authority for that. Gate these to leadership
    // server-side so a tampered client (e.g. someone who edited their
    // localStorage `isLeadership` flag or the client-side role array) can't
    // reach them. Every legitimate caller of these actions is already a
    // leadership-only tool (Data Management / Tier / Inventory), so this closes
    // the hole without affecting real flows. Feature-specific actions
    // (submit_api_key, sync_*, fetch_*, import_*, save_war_payout, manage_*)
    // keep their own per-handler checks and are intentionally not listed here.
    const LEADERSHIP_ONLY_ACTIONS = new Set([
      'upsert', 'insert', 'update', 'delete', 'clear_table',
    ])
    if (LEADERSHIP_ONLY_ACTIONS.has(body.action) &&
        !LEADERSHIP_IDS.includes(authResult.userId!)) {
      return new Response(
        JSON.stringify({ error: 'This action requires leadership access.' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Route to appropriate handler
    let result
    switch (body.action) {
      case 'upsert':
        result = await handleUpsert(supabase, body)
        break
      case 'insert':
        result = await handleInsert(supabase, body)
        break
      case 'update':
        result = await handleUpdate(supabase, body)
        break
      case 'delete':
        result = await handleDelete(supabase, body)
        break
      case 'sync_crimes':
        result = await handleSyncCrimes(supabase, tornApiKey)
        break
      case 'clear_table':
        result = await handleClearTable(supabase, body)
        break
      case 'import_cpr':
        result = await handleImportCpr(supabase, body)
        break
      case 'import_crimes':
        result = await handleImportCrimes(supabase, body)
        break
      case 'import_payout':
        result = await handleImportPayout(supabase, body, authResult.userId)
        break
      case 'batch_link_crimes':
        result = await handleBatchLinkCrimes(supabase, body)
        break
      case 'sync_inventory':
        result = await handleSyncInventory(supabase, tornApiKey, authResult.userId)
        break
      case 'sync_members':
        result = await handleSyncMembers(supabase, tornApiKey)
        break
      case 'save_war_payout':
        result = await handleSaveWarPayout(supabase, body, authResult.userId)
        break
      case 'update_war_is_termed':
        result = await handleUpdateWarIsTermed(supabase, body)
        break
      // 2.0: single consolidated key. submit_cpr_key kept as a back-compat alias.
      case 'submit_api_key':
      case 'submit_cpr_key':
        result = await handleSubmitApiKey(supabase, body, authResult.userId!)
        break
      case 'manage_overview_view':
        result = await handleManageOverviewView(supabase, body, authResult.userId!)
        break
      case 'manage_overview_threshold':
        result = await handleManageOverviewThreshold(supabase, body, authResult.userId!)
        break
      case 'fetch_attacks':
        result = await handleFetchAttacks(supabase, tornApiKey)
        break
      case 'fetch_wars':
        result = await handleFetchWars(supabase, tornApiKey)
        break
      case 'fetch_revives':
        result = await handleFetchRevives(supabase, tornApiKey, Number(body.war_id))
        break
      default:
        return new Response(
          JSON.stringify({ error: `Unknown action: ${body.action}` }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
    }

    return new Response(
      JSON.stringify(result),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('Edge function error:', error)
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

async function verifyTornUser(apiKey: string): Promise<{ success: boolean; error?: string; userId?: string }> {
  // Check in-memory cache first
  const cached = authCache.get(apiKey)
  if (cached && cached.expiresAt > Date.now()) {
    return { success: true, userId: cached.userId }
  }

  // Cache miss or expired - call Torn API
  try {
    const response = await fetch(`https://api.torn.com/v2/key/info?key=${apiKey}`)
    const data = await response.json()

    if (data.error) {
      const code = Number(data.error.code ?? 0)
      const msg = data.error.error || 'Unknown error'
      // Transient: rate limit, IP block, API disabled, backend error.
      // Don't evict the cache — the cached entry (if any) is still valid; we
      // just couldn't re-verify right now. If there's no cache yet, surface
      // a clear "rate limited" message instead of the misleading
      // "Invalid API key" we used to return for every error.
      if (TRANSIENT_TORN_ERROR_CODES.has(code)) {
        if (cached) {
          // Extend the cached entry slightly so subsequent requests reuse it
          // until Torn cools off, rather than re-hitting and re-failing.
          authCache.set(apiKey, { userId: cached.userId, expiresAt: Date.now() + AUTH_CACHE_TTL_MS })
          return { success: true, userId: cached.userId }
        }
        return { success: false, error: `Torn API temporarily unavailable (${msg}). Try again in a minute.` }
      }
      // Genuine bad key / permission error.
      authCache.delete(apiKey)
      return { success: false, error: `Invalid API key (${msg})` }
    }

    const userId = String(data.info?.user?.id)
    const factionId = String(data.info?.user?.faction_id)

    // Check if user is in leadership
    if (LEADERSHIP_IDS.includes(userId)) {
      authCache.set(apiKey, { userId, expiresAt: Date.now() + AUTH_CACHE_TTL_MS })
      return { success: true, userId }
    }

    // Check if user is in the faction
    if (factionId !== FACTION_ID) {
      authCache.delete(apiKey)
      return { success: false, error: 'Not a faction member' }
    }

    // Check API access level
    const accessLevel = data.info?.access?.level
    if (accessLevel < 2) {
      authCache.delete(apiKey)
      return { success: false, error: 'Insufficient API permissions' }
    }

    authCache.set(apiKey, { userId, expiresAt: Date.now() + AUTH_CACHE_TTL_MS })
    return { success: true, userId }
  } catch (error) {
    return { success: false, error: 'Failed to verify user' }
  }
}

async function handleUpsert(supabase: any, body: RequestBody) {
  const { table, data, onConflict } = body

  if (!table || !data) {
    throw new Error('Missing table or data')
  }

  const options: any = {}
  if (onConflict) {
    options.onConflict = onConflict
  }

  const { data: result, error } = await supabase
    .from(table)
    .upsert(data, options)
    .select()

  if (error) throw error
  return { success: true, data: result }
}

async function handleInsert(supabase: any, body: RequestBody) {
  const { table, data } = body

  if (!table || !data) {
    throw new Error('Missing table or data')
  }

  const { data: result, error } = await supabase
    .from(table)
    .insert(data)
    .select()

  if (error) throw error
  return { success: true, data: result }
}

async function handleUpdate(supabase: any, body: RequestBody) {
  const { table, data, filters } = body

  if (!table || !data || !filters) {
    throw new Error('Missing table, data, or filters')
  }

  let query = supabase.from(table).update(data)

  for (const [key, value] of Object.entries(filters)) {
    query = query.eq(key, value)
  }

  const { data: result, error } = await query.select()

  if (error) throw error
  return { success: true, data: result }
}

async function handleDelete(supabase: any, body: RequestBody) {
  const { table, filters } = body

  if (!table) {
    throw new Error('Missing table')
  }

  let query = supabase.from(table).delete()

  if (filters) {
    for (const [key, value] of Object.entries(filters)) {
      query = query.eq(key, value)
    }
  } else {
    // Delete all - use a condition that matches everything
    query = query.neq('id', -999999)
  }

  const { error } = await query

  if (error) throw error
  return { success: true }
}

async function handleClearTable(supabase: any, body: RequestBody) {
  const { table } = body

  if (!table) {
    throw new Error('Missing table')
  }

  // Different tables have different primary keys
  const primaryKeyMap: Record<string, string> = {
    'crimes': 'crime_id',
    'crime_slots': 'id',
    'crime_reward_items': 'id',
    'crime_required_items': 'id',
    'members': 'member_id',
    'member_cpr': 'id',
    'oc_payout_weeks': 'id',
    'oc_payout_members': 'id',
    'inventory_items': 'id',
    'pricing_batches': 'id',
    'sync_metadata': 'id'
  }

  const pk = primaryKeyMap[table] || 'id'

  // Try to delete with a broad condition
  const { error } = await supabase
    .from(table)
    .delete()
    .not(pk, 'is', null)

  if (error) {
    // Try alternative
    const { error: error2 } = await supabase
      .from(table)
      .delete()
      .gte(pk, 0)

    if (error2) throw error2
  }

  return { success: true, table, message: `Cleared table ${table}` }
}

// Helper: collect crime data into bulk arrays for batch upserting
function collectCrimeRecords(crimes: Record<string, any>) {
  const allCrimes: any[] = []
  const allSlots: any[] = []
  const allRewardItems: any[] = []
  const allRequiredItems: any[] = []
  const now = new Date().toISOString()

  for (const [crimeId, crimeData] of Object.entries(crimes) as [string, any][]) {
    allCrimes.push({
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
      last_updated: crimeData.last_updated || now,
      first_seen: crimeData.first_seen || now,
      updated_at: now
    })

    const slots = crimeData.slots || []
    for (const slot of slots) {
      const user = slot.user || {}
      const itemReq = slot.item_requirement || {}
      const itemOutcome = user.item_outcome || {}
      const pi = slot.position_info ?? {}

      allSlots.push({
        crime_id: crimeId,
        position: slot.position,
        position_id:     pi.id     ?? slot.position_id,
        position_number: pi.number ?? slot.position_number,
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
        updated_at: now
      })

      if (itemReq.id) {
        const wasConsumed = itemOutcome.outcome === 'used'
        allRequiredItems.push({
          crime_id: crimeId,
          position: slot.position,
          position_id:     pi.id     ?? slot.position_id,
          position_number: pi.number ?? slot.position_number,
          item_id: itemReq.id.toString(),
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
          created_at: now,
          updated_at: now
        })
      }
    }

    const rewardItems = crimeData.rewards?.items || []
    for (const rewardItem of rewardItems) {
      const itemId = rewardItem.id?.toString()
      if (!itemId) continue
      // Torn lists potential drops with quantity=0 for items the crime could
      // have produced but didn't actually award.  Skip those — only persist
      // items that were genuinely received.
      const qty = Number(rewardItem.quantity) || 0
      if (qty <= 0) continue
      allRewardItems.push({
        crime_id: crimeId,
        item_id: itemId,
        item_name: rewardItem.name || null,
        quantity: qty,
        unit_value: 0,
        total_value: 0,
        created_at: now,
        updated_at: now
      })
    }
  }

  return { allCrimes, allSlots, allRewardItems, allRequiredItems }
}

// Helper: bulk upsert an array in chunks (Supabase has payload size limits)
async function bulkUpsert(supabase: any, table: string, records: any[], onConflict: string, chunkSize = 500) {
  if (records.length === 0) return 0
  let count = 0
  for (let i = 0; i < records.length; i += chunkSize) {
    const chunk = records.slice(i, i + chunkSize)
    const { error } = await supabase.from(table).upsert(chunk, { onConflict })
    if (error) {
      console.error(`Bulk upsert error on ${table} (chunk ${i}):`, error)
    } else {
      count += chunk.length
    }
  }
  return count
}

async function handleSyncCrimes(supabase: any, apiKey: string) {
  // Step 1: Determine the start timestamp
  // Mirrors Python daily_crime_update.py _get_fetch_start_timestamp logic:
  // - Find all crimes that are incomplete (Planning or Recruiting status)
  // - Use the OLDEST incomplete crime's created_at as our start point
  // - This ensures we re-fetch and update all incomplete crimes from that point forward
  // - If no incomplete crimes exist, use the newest crime's created_at to catch new ones
  let fromTimestamp = 0
  let syncReason = 'empty_db'

  // Check if we have any crimes at all
  const { count } = await supabase
    .from('crimes')
    .select('*', { count: 'exact', head: true })

  if (count && count > 0) {
    // Find the oldest incomplete crime (Planning or Recruiting — no executed_at)
    const { data: oldestIncomplete } = await supabase
      .from('crimes')
      .select('crime_id, created_at, status')
      .in('status', ['Planning', 'Recruiting'])
      .order('created_at', { ascending: true })
      .limit(1)

    if (oldestIncomplete && oldestIncomplete.length > 0) {
      fromTimestamp = oldestIncomplete[0].created_at
      syncReason = `oldest_incomplete_${oldestIncomplete[0].crime_id}`
    } else {
      // All crimes are complete — use the newest crime's created_at
      // to check for any brand new crimes since last sync
      const { data: newestCrime } = await supabase
        .from('crimes')
        .select('crime_id, created_at')
        .order('created_at', { ascending: false })
        .limit(1)

      if (newestCrime && newestCrime.length > 0) {
        fromTimestamp = newestCrime[0].created_at
        syncReason = `newest_complete_${newestCrime[0].crime_id}`
      }
    }
  }

  // Step 2: Paginated fetch from Torn API
  // Mirrors Python _fetch_crimes_paginated: fetch with sort=ASC from start timestamp,
  // continue until we get < 100 crimes (the API's page size)
  const allApiCrimes: Record<string, any> = {}
  let currentFrom = fromTimestamp
  let page = 0
  const seenIds = new Set<string>()

  while (true) {
    const url = `https://api.torn.com/faction/?selections=crimes&key=${apiKey}&from=${currentFrom}&sort=ASC`
    const response = await fetch(url)

    if (!response.ok) {
      throw new Error(`Torn API error: ${response.status}`)
    }

    const data = await response.json()

    if (data.error) {
      throw new Error(data.error.error || 'API error')
    }

    const crimes = data.crimes || {}
    const crimeEntries = Object.entries(crimes)

    if (crimeEntries.length === 0) break

    // Deduplicate across pages (overlap can occur at page boundaries)
    let newCount = 0
    for (const [id, crime] of crimeEntries) {
      if (!seenIds.has(id)) {
        allApiCrimes[id] = crime
        seenIds.add(id)
        newCount++
      }
    }

    // If we got fewer than 100 crimes, we've reached the end
    if (crimeEntries.length < 100) break

    // Use the last crime's created_at as the next page's from timestamp
    const lastCrime = crimeEntries[crimeEntries.length - 1][1] as any
    currentFrom = lastCrime.created_at
    page++

    // Safety limit to prevent infinite loops
    if (page > 50) break
  }

  // Step 3: Process and upsert all fetched crimes
  // Upsert = update if exists (by crime_id), insert if new
  const { allCrimes, allSlots, allRewardItems, allRequiredItems } = collectCrimeRecords(allApiCrimes)

  const [crimesUpdated, slotsUpdated, rewardItemsUpdated, requiredItemsUpdated] = await Promise.all([
    bulkUpsert(supabase, 'crimes', allCrimes, 'crime_id'),
    bulkUpsert(supabase, 'crime_slots', allSlots, 'crime_id,position_id'),
    bulkUpsert(supabase, 'crime_reward_items', allRewardItems, 'crime_id,item_id'),
    bulkUpsert(supabase, 'crime_required_items', allRequiredItems, 'crime_id,position_id'),
  ])

  return {
    success: true,
    crimesUpdated,
    slotsUpdated,
    rewardItemsUpdated,
    requiredItemsUpdated,
    pagesFetched: page + 1,
    syncReason,
    fromTimestamp
  }
}

async function handleImportCpr(supabase: any, body: RequestBody) {
  const { data: membersData } = body

  if (!membersData) {
    throw new Error('Missing CPR data')
  }

  const now = new Date().toISOString()
  const allMembers: any[] = []
  const allCprRecords: any[] = []

  for (const [memberId, memberData] of Object.entries(membersData) as [string, any][]) {
    allMembers.push({
      member_id: memberId,
      member_name: memberData.name || `Member ${memberId}`,
      tier: memberData.tier || 6,
      last_scraped: memberData.last_scraped,
      updated_at: now
    })

    const cprData = memberData.cpr_data || memberData.cpr_by_role || {}
    for (const [level, roles] of Object.entries(cprData) as [string, any][]) {
      for (const [role, value] of Object.entries(roles)) {
        if (typeof value === 'number') {
          allCprRecords.push({
            member_id: memberId,
            difficulty_level: parseInt(level),
            role_name: role,
            cpr_value: value,
            updated_at: now
          })
        }
      }
    }
  }

  // Bulk upsert (2 queries instead of hundreds)
  const [membersCount, cprRecordsCount] = await Promise.all([
    bulkUpsert(supabase, 'members', allMembers, 'member_id'),
    bulkUpsert(supabase, 'member_cpr', allCprRecords, 'member_id,difficulty_level,role_name'),
  ])

  return { success: true, membersCount, cprRecordsCount }
}

async function handleImportCrimes(supabase: any, body: RequestBody) {
  const { data: crimesData } = body

  if (!crimesData) {
    throw new Error('Missing crimes data')
  }

  const { allCrimes, allSlots, allRewardItems, allRequiredItems } = collectCrimeRecords(crimesData)

  // Bulk upsert all records (4 queries instead of hundreds)
  const [crimesCount, slotsCount, rewardItemsCount, requiredItemsCount] = await Promise.all([
    bulkUpsert(supabase, 'crimes', allCrimes, 'crime_id'),
    bulkUpsert(supabase, 'crime_slots', allSlots, 'crime_id,position_id'),
    bulkUpsert(supabase, 'crime_reward_items', allRewardItems, 'crime_id,item_id'),
    bulkUpsert(supabase, 'crime_required_items', allRequiredItems, 'crime_id,position_id'),
  ])

  return { success: true, crimesCount, slotsCount, rewardItemsCount, requiredItemsCount }
}

async function handleImportPayout(supabase: any, body: RequestBody, userId: string) {
  const { data } = body
  const { weekData, memberRecords, crimeIds } = data

  if (!weekData || !memberRecords) {
    throw new Error('Missing week or member data')
  }

  // Check if week already exists
  const { data: existingWeek } = await supabase
    .from('oc_payout_weeks')
    .select('id')
    .eq('week_start', weekData.week_start)
    .eq('week_end', weekData.week_end)
    .single()

  let weekId

  if (existingWeek) {
    // Update existing week
    const { error: updateError } = await supabase
      .from('oc_payout_weeks')
      .update({
        ...weekData,
        saved_by: userId,
        saved_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', existingWeek.id)

    if (updateError) throw updateError
    weekId = existingWeek.id

    // Delete existing member records for this week
    await supabase
      .from('oc_payout_members')
      .delete()
      .eq('week_id', weekId)
  } else {
    // Insert new week
    const { data: newWeek, error: insertError } = await supabase
      .from('oc_payout_weeks')
      .insert({
        ...weekData,
        saved_by: userId,
        saved_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select('id')
      .single()

    if (insertError) throw insertError
    weekId = newWeek.id
  }

  // Add week_id and ensure week_start/week_end are present in member records
  const membersWithWeekId = memberRecords.map((m: any) => ({
    ...m,
    week_id: weekId,
    week_start: weekData.week_start,
    week_end: weekData.week_end
  }))

  const { error: membersError } = await supabase
    .from('oc_payout_members')
    .insert(membersWithWeekId)

  if (membersError) throw membersError

  // Batch link crimes to this payout week in the same call (avoids separate round-trip)
  if (crimeIds && crimeIds.length > 0) {
    const { error: linkError } = await supabase
      .from('crimes')
      .update({ payout_week_id: weekId })
      .in('crime_id', crimeIds)

    if (linkError) {
      console.error('Error linking crimes to payout week:', linkError)
    }
  }

  return { success: true, weekId, memberCount: memberRecords.length }
}

// Batch update crimes to link them to a payout week (single query instead of N calls)
async function handleBatchLinkCrimes(supabase: any, body: RequestBody) {
  const { crimeIds, weekId } = body

  if (!crimeIds || !weekId) {
    throw new Error('Missing crimeIds or weekId')
  }

  const { data: result, error } = await supabase
    .from('crimes')
    .update({ payout_week_id: weekId })
    .in('crime_id', crimeIds)
    .select('crime_id')

  if (error) throw error
  return { success: true, updated: result?.length || 0 }
}

async function handleSyncInventory(supabase: any, apiKey: string, userId: string) {
  // Fetch inventory from Torn API
  const response = await fetch(
    `https://api.torn.com/faction/?selections=armorynewsfull&key=${apiKey}`
  )

  if (!response.ok) {
    throw new Error(`Torn API error: ${response.status}`)
  }

  const data = await response.json()

  if (data.error) {
    throw new Error(data.error.error || 'API error')
  }

  // Process armory data
  const armory = data.armorynewsfull || data.armory || {}
  const items: any[] = []

  for (const [category, categoryItems] of Object.entries(armory)) {
    if (Array.isArray(categoryItems)) {
      for (const item of categoryItems) {
        const loanedTo = item.loaned_to
          ? (typeof item.loaned_to === 'string' ? item.loaned_to : JSON.stringify(item.loaned_to))
          : null
        items.push({
          id: item.ID?.toString() || item.id?.toString(),
          name: item.name,
          quantity: item.quantity || 1,
          available: item.available || item.quantity || 1,
          loaned: item.loaned || 0,
          loaned_to: loanedTo,
          api_type: item.type,
          category: category,
          last_synced: new Date().toISOString()
        })
      }
    }
  }

  if (items.length > 0) {
    const { error } = await supabase
      .from('inventory_items')
      .upsert(items, { onConflict: 'id' })

    if (error) throw error
  }

  // Record sync metadata
  await supabase
    .from('sync_metadata')
    .insert({
      data_type: 'inventory',
      last_sync: new Date().toISOString(),
      synced_by: userId
    })

  return { success: true, itemCount: items.length }
}

async function handleSyncMembers(supabase: any, apiKey: string) {
  // Fetch current faction members from Torn API
  const response = await fetch(
    `https://api.torn.com/faction/${FACTION_ID}?selections=basic&key=${apiKey}`
  )

  if (!response.ok) {
    throw new Error(`Torn API error: ${response.status}`)
  }

  const data = await response.json()

  if (data.error) {
    throw new Error(data.error.error || 'API error')
  }

  const apiMembers = data.members || {}
  const now = new Date().toISOString()

  // Step 1: Mark all current members as not current
  const { error: markError } = await supabase
    .from('members')
    .update({ is_current: false, last_seen: now })
    .eq('is_current', true)

  if (markError) {
    console.error('Error marking members as not current:', markError)
  }

  // Step 2: Upsert current faction members with is_current = true
  const memberRecords = Object.entries(apiMembers).map(([memberId, memberData]: [string, any]) => ({
    member_id: memberId,
    member_name: memberData.name || `Member ${memberId}`,
    is_current: true,
    last_seen: now,
    updated_at: now,
  }))

  const upsertedCount = await bulkUpsert(supabase, 'members', memberRecords, 'member_id')

  return {
    success: true,
    totalMembers: memberRecords.length,
    upserted: upsertedCount,
  }
}

async function handleSaveWarPayout(supabase: any, body: RequestBody, userId: string) {
  const { payoutData, memberRecords } = body.data

  if (!payoutData || !memberRecords) {
    throw new Error('Missing payoutData or memberRecords')
  }

  // Check if a payout already exists for this war
  const { data: existingPayout } = await supabase
    .from('war_payouts')
    .select('id')
    .eq('war_id', payoutData.war_id)
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  let payoutId

  if (existingPayout) {
    // Update existing payout record
    const { error: updateError } = await supabase
      .from('war_payouts')
      .update({
        ...payoutData,
        created_by: userId,
        updated_at: new Date().toISOString()
      })
      .eq('id', existingPayout.id)

    if (updateError) throw updateError
    payoutId = existingPayout.id

    // Delete existing member records for this payout
    await supabase
      .from('war_payout_members')
      .delete()
      .eq('payout_id', payoutId)
  } else {
    // Insert new payout record
    const { data: newPayout, error: insertError } = await supabase
      .from('war_payouts')
      .insert({
        ...payoutData,
        created_by: userId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select('id')
      .single()

    if (insertError) throw insertError
    payoutId = newPayout.id
  }

  // Insert member records with payout_id
  const membersWithPayoutId = memberRecords.map((m: any) => ({
    ...m,
    payout_id: payoutId
  }))

  const { error: membersError } = await supabase
    .from('war_payout_members')
    .insert(membersWithPayoutId)

  if (membersError) throw membersError

  return { success: true, payoutId, memberCount: memberRecords.length }
}

async function handleUpdateWarIsTermed(supabase: any, body: RequestBody) {
  const { war_id, is_termed } = body.data

  if (war_id === undefined || is_termed === undefined) {
    throw new Error('Missing war_id or is_termed')
  }

  const { error } = await supabase
    .from('ranked_wars')
    .update({ is_termed, updated_at: new Date().toISOString() })
    .eq('id', war_id)

  if (error) throw error
  return { success: true, war_id, is_termed }
}

// 2.0: the member's single consolidated Limited-access key (used for identity,
// CPR scraping, War Room rotation, and faction-wide scrapers). Replaces the
// old separate CPR-key submission. Accepts the new `api_key` field and the
// legacy `cpr_api_key` field for backward compatibility.
async function handleSubmitApiKey(supabase: any, body: RequestBody, userId: string) {
  const raw = body.data?.api_key ?? body.data?.cpr_api_key
  const consentVersion = body.data?.consent_version ?? null

  if (!userId) throw new Error('Could not identify user')
  if (raw === null || raw === undefined) {
    throw new Error('Missing api_key')
  }

  // Empty string => member is clearing their key.
  const keyToStore = String(raw).trim() === '' ? null : String(raw).trim()

  let keyLevel: number | null = null
  let hasFactionAccess: boolean | null = null
  const memberRank: string | null = body.data?.rank ?? null

  // Validate the key against Torn API before storing (if a key was provided).
  if (keyToStore) {
    const resp = await fetch(`https://api.torn.com/v2/key/info?key=${keyToStore}`)
    const data = await resp.json()

    if (data.error) {
      return { success: false, error: 'Invalid Torn API key — please check and try again.' }
    }

    // Confirm it belongs to the submitting user.
    const keyUserId = String(data.info?.user?.id)
    if (keyUserId !== String(userId)) {
      return { success: false, error: 'This API key does not belong to your Torn account.' }
    }

    // The consolidated key must be Limited Access (level 3) or higher — it
    // covers user + faction selections for every feature on the site.
    keyLevel = data.info?.access?.level ?? 0
    if ((keyLevel ?? 0) < 3) {
      return {
        success: false,
        error: 'This dashboard needs a Limited Access key. Use the "Generate Limited key" link, then paste the new key here.',
      }
    }

    // Recruits (3-day probation) have access.faction = false. We DO NOT reject
    // them — they keep full access to the site. We just record the flag so the
    // faction-scoped rotation pool skips their key; faction-only features wait
    // until they're off Recruit.
    hasFactionAccess = !!data.info?.access?.faction
  }

  // Both set and clear go through the SECURITY DEFINER RPC. Passing a null/empty
  // raw key deletes the secret row (see public.set_member_api_key).
  const secret = Deno.env.get('APP_KEY_SECRET') ?? Deno.env.get('CPR_KEY_SECRET')
  if (!secret) throw new Error('APP_KEY_SECRET not configured on this server')

  const { error } = await supabase.rpc('set_member_api_key', {
    p_member_id:          String(userId),
    p_raw_key:            keyToStore,  // null on clear, encrypted-and-stored otherwise
    p_secret:             secret,
    p_key_level:          keyLevel,
    p_has_faction_access: hasFactionAccess,
    p_member_rank:        memberRank,
    p_consent_version:    consentVersion,
  })
  if (error) throw error

  return { success: true, removed: keyToStore === null, has_faction_access: hasFactionAccess }
}

// ── Leadership Member-Overview view & threshold management ────────────────────
// Two parallel handlers (manage_overview_view / manage_overview_threshold)
// dispatch on body.data.op = 'create' | 'update' | 'delete'. Both are gated
// to leadership users — the Phase 3 strict RLS policies on these tables also
// require is_leadership(), but enforcing it here too gives a clean 403 error
// rather than a confusing empty-result success.

const OVERVIEW_VIEW_COLUMNS     = 'id, name, columns, created_by_id, created_by_name, updated_at'
const OVERVIEW_THRESHOLD_COLUMNS = 'id, name, thresholds, created_by_id, created_by_name, updated_at'

async function handleManageOverviewView(supabase: any, body: RequestBody, userId: string) {
  if (!LEADERSHIP_IDS.includes(userId)) {
    throw new Error('Leadership only')
  }

  const payload = body.data ?? {}
  const op: string = payload.op

  switch (op) {
    case 'create': {
      const { name, columns, user_name } = payload
      if (!name || !Array.isArray(columns)) throw new Error('name and columns are required')
      const { data, error } = await supabase
        .from('member_overview_views')
        .insert({
          name,
          columns,
          created_by_id: String(userId),
          created_by_name: user_name ?? null,
        })
        .select(OVERVIEW_VIEW_COLUMNS)
        .single()
      if (error) throw error
      return { success: true, data }
    }

    case 'update': {
      const { id, name, columns } = payload
      if (!id) throw new Error('id is required')
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
      if (name    !== undefined) patch.name    = name
      if (columns !== undefined) patch.columns = columns
      const { data, error } = await supabase
        .from('member_overview_views')
        .update(patch)
        .eq('id', id)
        .select(OVERVIEW_VIEW_COLUMNS)
        .single()
      if (error) throw error
      return { success: true, data }
    }

    case 'delete': {
      const { id } = payload
      if (!id) throw new Error('id is required')
      const { error } = await supabase
        .from('member_overview_views')
        .delete()
        .eq('id', id)
      if (error) throw error
      return { success: true }
    }

    default:
      throw new Error(`Unknown overview-view op: ${op}`)
  }
}

async function handleManageOverviewThreshold(supabase: any, body: RequestBody, userId: string) {
  if (!LEADERSHIP_IDS.includes(userId)) {
    throw new Error('Leadership only')
  }

  const payload = body.data ?? {}
  const op: string = payload.op

  switch (op) {
    case 'create': {
      const { name, thresholds, user_name } = payload
      if (!name || !thresholds || typeof thresholds !== 'object') {
        throw new Error('name and thresholds object are required')
      }
      const { data, error } = await supabase
        .from('member_overview_thresholds')
        .insert({
          name,
          thresholds,
          created_by_id: String(userId),
          created_by_name: user_name ?? null,
        })
        .select(OVERVIEW_THRESHOLD_COLUMNS)
        .single()
      if (error) throw error
      return { success: true, data }
    }

    case 'update': {
      const { id, name, thresholds } = payload
      if (!id) throw new Error('id is required')
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
      if (name       !== undefined) patch.name       = name
      if (thresholds !== undefined) patch.thresholds = thresholds
      const { data, error } = await supabase
        .from('member_overview_thresholds')
        .update(patch)
        .eq('id', id)
        .select(OVERVIEW_THRESHOLD_COLUMNS)
        .single()
      if (error) throw error
      return { success: true, data }
    }

    case 'delete': {
      const { id } = payload
      if (!id) throw new Error('id is required')
      const { error } = await supabase
        .from('member_overview_thresholds')
        .delete()
        .eq('id', id)
      if (error) throw error
      return { success: true }
    }

    default:
      throw new Error(`Unknown overview-threshold op: ${op}`)
  }
}

// ── Faction attacks fetcher ──────────────────────────────────────────────────
// Pure API-to-DB pipeline replacing the old `trigger_workflow` button that
// dispatched the Python scraper via GitHub Actions. Mirrors the structure of
// handleSyncCrimes: read DB cursor, paginate from Torn, bulk upsert,
// idempotent on attack_id PK.
//
// Pagination is capped at 30 pages (~3,000 attacks per click) to stay inside
// the Edge Function timeout — at the 600ms rate-limit delay that's ~18s of
// waits plus upsert time. If we hit the cap, returns `moreAvailable: true`
// so the UI can offer a "fetch again" follow-up. The cron workflow
// (.github/workflows/scrape-faction-attacks.yml) is still the right tool for
// first-time-from-zero backfills which would otherwise require ~440 pages.
async function handleFetchAttacks(supabase: any, apiKey: string) {
  // Step 1: cursor = newest stored attack's `started` timestamp (or 0).
  const { data: newest } = await supabase
    .from('faction_attacks')
    .select('started')
    .order('started', { ascending: false })
    .limit(1)
    .maybeSingle()
  const fromTimestamp: number = Number(newest?.started ?? 0)

  // Step 2: paginated fetch with cap. Overlap at page boundaries is handled
  // by the seen-id set. Transient Torn errors (rate limit, 5xx) break out of
  // the loop and return a partial result so the user keeps what we got.
  const PAGE_CAP = 30
  const collected: any[] = []
  const seenIds = new Set<string>()
  let currentFrom = fromTimestamp
  let pages = 0
  let moreAvailable = false
  let partial = false
  let partialReason: string | null = null

  for (pages = 0; pages < PAGE_CAP; pages++) {
    if (pages > 0) await sleep(TORN_RATE_LIMIT_MS)

    const url = `https://api.torn.com/v2/faction/attacks?limit=100&sort=ASC&from=${currentFrom}&key=${apiKey}`
    const result = await tornFetch<any>(url)

    if (!result.ok) {
      if (result.transient) {
        // Stop here, keep what we have. The user can click again to resume.
        partial = true
        partialReason = result.message
        break
      }
      throw new Error(result.message)
    }

    const rawAttacks: any[] = result.data.attacks || []
    if (rawAttacks.length === 0) break

    for (const raw of rawAttacks) {
      const aid = String(raw.id)
      if (seenIds.has(aid)) continue
      seenIds.add(aid)
      collected.push(normalizeAttack(raw))
    }

    if (rawAttacks.length < 100) break

    // Advance cursor to the last attack on the page (Torn returns ASC sort).
    const last = rawAttacks[rawAttacks.length - 1]
    currentFrom = Number(last.started ?? currentFrom)
  }
  if (pages >= PAGE_CAP) moreAvailable = true

  // Step 3: figure out which collected attacks are actually NEW vs. already in
  // the DB. Distinguishing "fetched" vs "new" gives the user a clearer summary.
  // We do this via a single SELECT against the collected attack_ids.
  let newCount = collected.length
  if (collected.length > 0) {
    const ids = collected.map(a => a.attack_id)
    const knownIds = new Set<number>()
    const CHUNK = 500
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK)
      const { data: knownRows } = await supabase
        .from('faction_attacks')
        .select('attack_id')
        .in('attack_id', slice)
      for (const r of (knownRows ?? [])) knownIds.add(Number(r.attack_id))
    }
    newCount = collected.filter(a => !knownIds.has(Number(a.attack_id))).length
  }

  // Step 4: backfill any new faction IDs we haven't seen in the factions table.
  const factionIds = new Set<number>()
  for (const a of collected) {
    if (a.attacker_faction_id) factionIds.add(Number(a.attacker_faction_id))
    if (a.defender_faction_id) factionIds.add(Number(a.defender_faction_id))
  }
  const factionsBackfilled = await backfillFactions(supabase, apiKey, factionIds)

  // Step 5: bulk upsert (idempotent — re-running over the same data is safe).
  const attacksUpserted = await bulkUpsert(supabase, 'faction_attacks', collected, 'attack_id')

  return {
    success: true,
    attacksFetched: collected.length,
    attacksNew: newCount,
    attacksUpserted,
    pagesFetched: pages,
    moreAvailable,
    factionsBackfilled,
    fromTimestamp,
    partial,
    partialReason,
  }
}

function normalizeAttack(raw: any) {
  const attacker = raw.attacker || {}
  const defender = raw.defender || {}
  const mods = raw.modifiers || {}
  const attackerFaction = attacker.faction || {}
  const defenderFaction = defender.faction || {}
  return {
    attack_id: raw.id,
    started: raw.started,
    ended: raw.ended,
    attacker_id: attacker.id,
    attacker_name: attacker.name,
    attacker_faction_id: attackerFaction.id ?? null,
    defender_id: defender.id,
    defender_name: defender.name,
    defender_faction_id: defenderFaction.id ?? null,
    result: raw.result,
    respect_gain: raw.respect_gain ?? 0,
    chain: raw.chain ?? 0,
    is_ranked_war: raw.is_ranked_war ?? false,
    fair_fight: mods.fair_fight ?? 1,
    war_modifier: mods.war ?? 1,
    chain_modifier: mods.chain ?? 1,
    warlord_modifier: mods.warlord ?? 1,
    is_incoming: Number(defenderFaction.id) === Number(FACTION_ID),
  }
}

async function backfillFactions(supabase: any, apiKey: string, factionIds: Set<number>): Promise<number> {
  if (factionIds.size === 0) return 0
  const ids = Array.from(factionIds)

  // Find which IDs are already known. PostgREST has a URL length limit on
  // `in.(...)` filters; 500 ids is safely below it.
  const knownIds = new Set<number>()
  const CHUNK = 500
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK)
    const { data, error } = await supabase.from('factions').select('id').in('id', slice)
    if (error) {
      console.warn('Faction backfill lookup error:', error)
      return 0
    }
    for (const r of (data ?? [])) knownIds.add(Number(r.id))
  }

  const missing = ids.filter(id => !knownIds.has(id))
  if (missing.length === 0) return 0

  // Fetch each missing faction's basic info, rate-limited. Skip any that
  // error or return no name (deleted factions etc).
  const newRows: any[] = []
  for (let i = 0; i < missing.length; i++) {
    if (i > 0) await sleep(TORN_RATE_LIMIT_MS)
    const fid = missing[i]
    try {
      const resp = await fetch(`https://api.torn.com/v2/faction/${fid}/basic?key=${apiKey}`)
      if (!resp.ok) continue
      const data = await resp.json()
      if (data.error) continue
      const basic = data.basic || data
      if (!basic?.name) continue
      newRows.push({
        id: Number(basic.id ?? fid),
        name: basic.name,
        tag: basic.tag ?? null,
        updated_at: new Date().toISOString(),
      })
    } catch (e) {
      console.warn(`Faction ${fid} backfill failed:`, e)
    }
  }
  return bulkUpsert(supabase, 'factions', newRows, 'id')
}

// ── Ranked wars fetcher ──────────────────────────────────────────────────────
// Fetches the most recent page (~100 wars) of the faction's ranked war list
// and diffs against the DB. Only upserts wars that are NEW or have changed
// (end_at became set, scores moved). Only fetches reports for wars that are
// completed in the API but have no rewards_items in the DB yet. This means
// repeated clicks on a fully-synced faction do almost nothing.
//
// `is_termed` is a manual UI flag (toggled via updateWarIsTermed elsewhere) —
// excluded from the upsert payload so the scraper data never clobbers it.
// `rewards_items` / `rank_before` / `rank_after` / `forfeit` are also omitted
// from normalizeWar so we don't accidentally null out a previously-fetched
// report when we only have the war-list view. Postgres ON CONFLICT DO UPDATE
// leaves columns absent from the payload untouched.
//
// Transient Torn errors mid-flight return a partial result rather than
// throwing — the user keeps whatever progress was made.
async function handleFetchWars(supabase: any, apiKey: string) {
  // Step 1: fetch most-recent page only. The API returns wars most-recent
  // first, and older wars are immutable, so ALL the action is in the latest
  // 100 entries. The GitHub cron workflow handles deep-history backfill if
  // ever needed.
  const url = `https://api.torn.com/v2/faction/${FACTION_ID}/rankedwars?offset=0&limit=100&key=${apiKey}`
  const result = await tornFetch<any>(url)
  if (!result.ok) {
    if (result.transient) {
      return {
        success: true, partial: true, partialReason: result.message,
        warsFetched: 0, warsNew: 0, warsUpdated: 0,
        warsUpserted: 0, reportsFetched: 0, reportsFailedPermanent: 0,
        contributionsUpserted: 0, moreReportsAvailable: false,
      }
    }
    throw new Error(result.message)
  }
  const apiWars: any[] = result.data.rankedwars || result.data.ranked_wars || []

  // Step 2: load existing rows for diffing. Only need a few columns.
  const apiIds = apiWars.map(w => Number(w.id)).filter(Boolean)
  const existingById = new Map<string, any>()
  if (apiIds.length > 0) {
    const { data: existingRows } = await supabase
      .from('ranked_wars')
      .select('id, end_at, our_score, opponent_score, rewards_items')
      .in('id', apiIds)
    for (const r of (existingRows ?? [])) existingById.set(String(r.id), r)
  }

  // Step 3: classify each war.
  //   - new           → upsert + fetch report if completed
  //   - changed       → upsert (scores or end_at differ)
  //   - report-needed → upsert (so the report data has a row to land on)
  //   - unchanged & report present → skip entirely
  const warRowsToUpsert: any[] = []
  const reportCandidates: number[] = []
  let warsNew = 0
  let warsUpdated = 0

  for (const raw of apiWars) {
    const normalized = normalizeWar(raw)
    const existing = existingById.get(String(raw.id))
    const completed = normalized.end_at != null

    let needsUpsert = false
    if (!existing) {
      warsNew++
      needsUpsert = true
    } else {
      const changed =
        Number(existing.end_at ?? 0)         !== Number(normalized.end_at ?? 0) ||
        Number(existing.our_score ?? 0)      !== Number(normalized.our_score) ||
        Number(existing.opponent_score ?? 0) !== Number(normalized.opponent_score)
      if (changed) {
        warsUpdated++
        needsUpsert = true
      }
    }

    const needsReport = completed && (!existing || existing.rewards_items == null)
    if (needsReport) reportCandidates.push(Number(raw.id))

    // Push to upsert if anything's different OR if a report is incoming
    // (applyWarReport will mutate this same object below before upsert).
    if (needsUpsert || needsReport) warRowsToUpsert.push(normalized)
  }

  // Step 4: fetch reports for completion candidates, capped to keep latency
  // sane. Apply report data back onto the matching warRow + collect
  // contributions for the war_member_contributions upsert. Stop on the first
  // transient error and return what we've got so far.
  const REPORT_CAP = 20
  const toFetch = reportCandidates.slice(0, REPORT_CAP)
  const moreReportsAvailable = reportCandidates.length > REPORT_CAP
  const warRowById = new Map<number, any>(warRowsToUpsert.map(w => [w.id, w]))

  const contributionRows: any[] = []
  let reportsFetched = 0
  let reportsFailedPermanent = 0
  let partial = false
  let partialReason: string | null = null

  for (let i = 0; i < toFetch.length; i++) {
    await sleep(TORN_RATE_LIMIT_MS)
    const warId = toFetch[i]
    const reportUrl = `https://api.torn.com/v2/faction/${warId}/rankedwarreport?key=${apiKey}`
    const reportResult = await tornFetch<any>(reportUrl)

    if (!reportResult.ok) {
      if (reportResult.transient) {
        // Stop here — preserve what we've fetched and surface the reason.
        partial = true
        partialReason = reportResult.message
        break
      }
      // Permanent error: skip this one war, keep going for the others.
      const isPermanent = PERMANENT_WAR_REPORT_ERROR_CODES.has(
        Number(reportResult.message.match(/Torn error (\d+)/)?.[1] ?? 0)
      )
      if (isPermanent) reportsFailedPermanent++
      else console.warn(`War ${warId} report error (non-permanent):`, reportResult.message)
      continue
    }

    const report = reportResult.data.rankedwarreport
    if (!report) continue

    applyWarReport(warRowById.get(warId), report)
    contributionRows.push(...extractContributions(report))
    reportsFetched++
  }

  // Step 5: bulk upsert. is_termed / rewards_items / rank_* / forfeit are not
  // in normalizeWar's output so they're never overwritten unless a report
  // mutated the row in step 4.
  const warsUpserted = await bulkUpsert(supabase, 'ranked_wars', warRowsToUpsert, 'id')
  const contributionsUpserted = await bulkUpsert(
    supabase, 'war_member_contributions', contributionRows, 'war_id,member_id'
  )

  return {
    success: true,
    warsFetched: apiWars.length,
    warsNew,
    warsUpdated,
    warsUpserted,
    reportsFetched,
    reportsFailedPermanent,
    contributionsUpserted,
    moreReportsAvailable,
    partial,
    partialReason,
  }
}

// ── Fetch revives for one ranked war ────────────────────────────────────────
//
// Mirrors the fetch_revives_for_war.py script, but server-side so leadership
// can trigger it from the RW History page. Looks up the war's start_at /
// end_at in ranked_wars, ASC-paginates /v2/faction/revives?filters=incoming
// over that window, and upserts into faction_revives with ignore_duplicates so
// re-running over the same war is a true no-op (revive ids are immutable).
//
// Behaviour by war state:
//   * end_at = null              → walk up to "now" (live war)
//   * start_at in the future     → 400 (war hasn't started)
//   * end_at set, fully past     → fixed window
async function handleFetchRevives(supabase: any, apiKey: string, warId: number) {
  if (!warId || !Number.isFinite(warId)) {
    throw new Error('war_id required')
  }

  const { data: war, error: warErr } = await supabase
    .from('ranked_wars')
    .select('id, start_at, end_at, opponent_name')
    .eq('id', warId)
    .maybeSingle()
  if (warErr) throw new Error(`ranked_wars lookup failed: ${warErr.message}`)
  if (!war) throw new Error(`War ${warId} not found in ranked_wars`)

  const nowSec = Math.floor(Date.now() / 1000)
  const startAt: number = Number(war.start_at)
  const endAtRaw: number | null = war.end_at == null ? null : Number(war.end_at)
  if (!startAt) throw new Error(`War ${warId} has no start_at`)
  if (startAt > nowSec) throw new Error(`War ${warId} hasn't started yet`)
  const endAt = endAtRaw ?? nowSec
  const isLive = endAtRaw === null

  // Step 1: ASC-paginate. Cursor advances by last_seen_timestamp + 1 to avoid
  // an infinite loop if multiple revives share the same epoch second.
  const PAGE_CAP = 60   // 60 * 100 = 6000 revives. War usually well under this.
  const seenIds = new Set<number>()
  const collected: any[] = []
  let cursor = startAt
  let pages = 0
  let partial = false
  let partialReason: string | null = null
  let moreAvailable = false

  for (pages = 0; pages < PAGE_CAP; pages++) {
    if (pages > 0) await sleep(TORN_RATE_LIMIT_MS)

    const url = `https://api.torn.com/v2/faction/revives`
      + `?filters=incoming&limit=100&sort=ASC&from=${cursor}&to=${endAt}`
      + `&striptags=true&key=${apiKey}`
    const result = await tornFetch<any>(url)

    if (!result.ok) {
      if (result.transient) {
        partial = true
        partialReason = result.message
        break
      }
      throw new Error(result.message)
    }

    const rawRevives: any[] = result.data.revives || []
    if (rawRevives.length === 0) break

    let lastTs = cursor
    for (const raw of rawRevives) {
      const rid = Number(raw.id)
      if (seenIds.has(rid)) continue
      seenIds.add(rid)
      collected.push(normalizeRevive(raw, warId))
      const ts = Number(raw.timestamp)
      if (Number.isFinite(ts) && ts > lastTs) lastTs = ts
    }

    // Partial page → we've reached the tail of the window.
    if (rawRevives.length < 100) break

    cursor = lastTs + 1
    if (cursor > endAt) break
  }
  if (pages >= PAGE_CAP) moreAvailable = true

  // Step 2: count NEW vs already-known so the toast can report correctly.
  let newCount = collected.length
  if (collected.length > 0) {
    const ids = collected.map(r => r.revive_id)
    const knownIds = new Set<number>()
    const CHUNK = 500
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK)
      const { data: knownRows } = await supabase
        .from('faction_revives')
        .select('revive_id')
        .in('revive_id', slice)
      for (const r of (knownRows ?? [])) knownIds.add(Number(r.revive_id))
    }
    newCount = collected.filter(r => !knownIds.has(Number(r.revive_id))).length
  }

  // Step 3: bulk upsert with ignore_duplicates. The PK on revive_id plus
  // ignoreDuplicates means re-runs over an already-fetched window are no-ops
  // — matches the user requirement of "skip if revive_id already exists".
  let upserted = 0
  if (collected.length > 0) {
    const CHUNK = 500
    for (let i = 0; i < collected.length; i += CHUNK) {
      const slice = collected.slice(i, i + CHUNK)
      const { error } = await supabase
        .from('faction_revives')
        .upsert(slice, { onConflict: 'revive_id', ignoreDuplicates: true })
      if (error) {
        console.error(`faction_revives upsert chunk failed: ${error.message}`)
      } else {
        upserted += slice.length
      }
    }
  }

  return {
    success: true,
    war_id: warId,
    opponent: war.opponent_name ?? null,
    window: { from: startAt, to: endAt, live: isLive },
    revivesFetched: collected.length,
    revivesNew: newCount,
    revivesUpserted: upserted,
    pagesFetched: pages,
    moreAvailable,
    partial,
    partialReason,
  }
}

function normalizeRevive(raw: any, warId: number) {
  const reviver = raw.reviver || {}
  const target = raw.target || {}
  const reviverFaction = reviver.faction || {}
  const targetFaction = target.faction || {}
  return {
    revive_id:            raw.id,
    rw_id:                warId,
    timestamp:            raw.timestamp,
    reviver_id:           reviver.id ?? null,
    reviver_name:         reviver.name ?? null,
    reviver_faction_id:   reviverFaction.id ?? null,
    reviver_faction_name: reviverFaction.name ?? null,
    reviver_skill:        reviver.skill ?? null,
    target_id:            target.id ?? null,
    target_name:          target.name ?? null,
    target_faction_id:    targetFaction.id ?? null,
    target_faction_name:  targetFaction.name ?? null,
    hospital_reason:      target.hospital_reason ?? null,
    early_discharge:      Boolean(target.early_discharge),
    target_last_action:   target.last_action ?? null,
    target_online_status: target.online_status ?? null,
    success_chance:       raw.success_chance ?? null,
    result:               raw.result ?? null,
  }
}

function normalizeWar(raw: any) {
  const factions: any[] = raw.factions || []
  const our = factions.find(f => String(f.id) === FACTION_ID)
  const opponent = factions.find(f => String(f.id) !== FACTION_ID)
  return {
    id: raw.id,
    start_at: raw.start ?? 0,
    end_at: raw.end || null,
    opponent_id: opponent?.id ?? null,
    opponent_name: opponent?.name ?? null,
    our_score: our?.score ?? 0,
    opponent_score: opponent?.score ?? 0,
    target: raw.target ?? null,
    winner_faction_id: raw.winner ?? null,
    // is_termed, forfeit, rewards_items, rank_before, rank_after are all
    // deliberately omitted — they're either manual UI flags or set only when
    // a report is fetched. Postgres ON CONFLICT DO UPDATE leaves omitted
    // columns alone, so we never clobber the manual flag or previously-
    // fetched report data on subsequent runs.
  }
}

function applyWarReport(warRow: any, report: any) {
  if (!warRow || !report) return
  const factions: any[] = report.factions || []
  const our = factions.find(f => String(f.id) === FACTION_ID)
  if (our) {
    const rewards = our.rewards || {}
    // rewards_items is a jsonb column; JSON.stringify gets handled by
    // postgrest's serializer when we send it as part of the payload.
    warRow.rewards_items = rewards.items ?? null
    const rank = our.rank || {}
    warRow.rank_before = rank.before ?? null
    warRow.rank_after = rank.after ?? null
    warRow.our_score = our.score ?? warRow.our_score
  }
  warRow.forfeit = report.forfeit ?? false
}

function extractContributions(report: any): any[] {
  const rows: any[] = []
  const warId = report.id
  for (const faction of (report.factions || [])) {
    const fid = faction.id
    for (const m of (faction.members || [])) {
      rows.push({
        war_id: warId,
        member_id: m.id,
        member_name: m.name ?? null,
        level: m.level ?? null,
        attacks: m.attacks ?? 0,
        score: m.score ?? 0,
        faction_id: fid,
      })
    }
  }
  return rows
}