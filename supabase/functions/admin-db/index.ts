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

    // Create Supabase client with service role key (bypasses RLS)
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    })

    // Parse request body
    const body: RequestBody = await req.json()
    
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
      authCache.delete(apiKey)
      return { success: false, error: 'Invalid API key' }
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

      allSlots.push({
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
        updated_at: now
      })

      if (itemReq.id) {
        const wasConsumed = itemOutcome.outcome === 'used'
        allRequiredItems.push({
          crime_id: crimeId,
          position: slot.position,
          position_id: slot.position_id,
          position_number: slot.position_number,
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
      allRewardItems.push({
        crime_id: crimeId,
        item_id: itemId,
        item_name: rewardItem.name || null,
        quantity: rewardItem.quantity || 1,
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
  // Fetch crimes from Torn API
  const response = await fetch(
    `https://api.torn.com/faction/?selections=crimes&key=${apiKey}`
  )
  
  if (!response.ok) {
    throw new Error(`Torn API error: ${response.status}`)
  }
  
  const data = await response.json()
  
  if (data.error) {
    throw new Error(data.error.error || 'API error')
  }

  const crimes = data.crimes || {}
  const { allCrimes, allSlots, allRewardItems, allRequiredItems } = collectCrimeRecords(crimes)

  // Bulk upsert all records (4 queries instead of hundreds)
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
    requiredItemsUpdated
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
        items.push({
          id: item.ID?.toString() || item.id?.toString(),
          name: item.name,
          quantity: item.quantity || 1,
          available: item.available || item.quantity || 1,
          loaned: item.loaned || 0,
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