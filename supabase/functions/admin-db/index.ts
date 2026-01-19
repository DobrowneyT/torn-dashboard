// DEPLOYMENT NOTE: This function must be deployed with --no-verify-jwt flag
// Deploy command: npx supabase functions deploy admin-db --no-verify-jwt
// This function uses custom Torn API key authentication instead of Supabase JWT

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-torn-api-key',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// Leadership user IDs who can perform admin operations
const LEADERSHIP_IDS = ['2250591']
const FACTION_ID = '10739'

interface RequestBody {
    action: string
    table?: string
    data?: any
    filters?: Record<string, any>
    onConflict?: string
}

serve(async (req: Request) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders })
    }

    try {
        // Get the Torn API key from header for authentication
        const tornApiKey = req.headers.get('x-torn-api-key')
        
        console.log('Request received:', {
            method: req.method,
            hasTornKey: !!tornApiKey,
            tornKeyPreview: tornApiKey?.substring(0, 4) + '...',
            headers: Array.from(req.headers.keys())
        })

        if (!tornApiKey) {
            console.error('Missing Torn API key in headers')
            return new Response(
                JSON.stringify({ error: 'Missing Torn API key' }),
                { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            )
        }

        // Verify the user is authorized via Torn API
        const authResult = await verifyTornUser(tornApiKey)

        if (!authResult.success) {
            return new Response(
                JSON.stringify({ error: authResult.error }),
                { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            )
        }

        // Create Supabase client with service role key (bypasses RLS)
        const supabaseUrl = Deno.env.get('SUPABASE_URL')!
        const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!
        const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

        const supabase = createClient(supabaseUrl, supabaseServiceKey)

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
            case 'sync_inventory':
                result = await handleSyncInventory(supabase, tornApiKey, authResult.userId)
                break
            case 'sync_items':
                result = await handleSyncItems(supabase, tornApiKey)
                break
            case 'sync_members':
                result = await handleSyncMembers(supabase, tornApiKey)
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
        // IMPORTANT: Always return CORS headers even on error
        return new Response(
            JSON.stringify({
                success: false,
                error: error.message || 'Unknown error occurred'
            }),
            {
                status: 500,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            }
        )
    }
})

async function verifyTornUser(apiKey: string): Promise<{ success: boolean; error?: string; userId?: string }> {
    try {
        console.log('Verifying Torn user with API key:', apiKey?.substring(0, 4) + '...')
        
        const response = await fetch(`https://api.torn.com/v2/key/info?key=${apiKey}`)
        const data = await response.json()

        console.log('Torn API response:', { hasError: !!data.error, hasInfo: !!data.info })

        if (data.error) {
            console.error('Torn API error:', data.error)
            return { success: false, error: 'Invalid API key' }
        }

        const userId = String(data.info?.user?.id)
        const factionId = String(data.info?.user?.faction_id)

        console.log('User info:', { userId, factionId, isLeader: LEADERSHIP_IDS.includes(userId) })

        // Check if user is in leadership
        if (LEADERSHIP_IDS.includes(userId)) {
            console.log('Leadership user detected:', userId)
            return { success: true, userId }
        }

        // Check if user is in the faction
        if (factionId !== FACTION_ID) {
            console.error('Faction mismatch:', { expected: FACTION_ID, actual: factionId })
            return { success: false, error: 'Not a faction member' }
        }

        // Check API access level
        const accessLevel = data.info?.access?.level
        console.log('API access level:', accessLevel)
        if (accessLevel < 2) {
            return { success: false, error: 'Insufficient API permissions' }
        }

        return { success: true, userId }
    } catch (error) {
        console.error('Error in verifyTornUser:', error)
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

    return { success: true, table }
}

async function handleSyncCrimes(supabase: any, apiKey: string) {
    // Fetch crimes from Torn API
    const response = await fetch(
        `https://api.torn.com/v2/faction/${FACTION_ID}/crimes?key=${apiKey}`
    )

    if (!response.ok) {
        throw new Error(`Torn API error: ${response.status}`)
    }

    const data = await response.json()

    if (data.error) {
        throw new Error(data.error.error || 'API error')
    }

    const crimesArray = data.crimes || []

    let crimesUpdated = 0
    let slotsUpdated = 0
    let rewardItemsUpdated = 0
    let requiredItemsUpdated = 0
    const errors: string[] = []

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
                }, { onConflict: 'crime_id' })

            if (crimeError) {
                errors.push(`Crime ${crimeId}: ${crimeError.message}`)
                continue
            }

            crimesUpdated++

            // Process slots
            const slots = crimeData.slots || []
            const slotRecords = slots.map((slot: any) => {
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
                    .upsert(slotRecords, { onConflict: 'crime_id,position_id' })

                if (slotError) {
                    errors.push(`Slots for crime ${crimeId}: ${slotError.message}`)
                } else {
                    slotsUpdated += slotRecords.length
                }
            }

            // Process REWARD items
            const rewardItems = crimeData.rewards?.items || []
            for (const rewardItem of rewardItems) {
                const itemId = rewardItem.id?.toString()
                if (!itemId) continue

                const { data: existing } = await supabase
                    .from('crime_reward_items')
                    .select('id, unit_value')
                    .eq('crime_id', crimeId)
                    .eq('item_id', itemId)
                    .single()

                if (!existing) {
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
                    const { error: updateError } = await supabase
                        .from('crime_reward_items')
                        .update({
                            quantity: rewardItem.quantity || 1,
                            item_name: rewardItem.name || null,
                            updated_at: new Date().toISOString()
                        })
                        .eq('id', existing.id)

                    if (!updateError) rewardItemsUpdated++
                }
            }

            // Process REQUIRED items
            for (const slot of slots) {
                const itemReq = slot.item_requirement
                if (!itemReq || !itemReq.id) continue

                const itemId = itemReq.id.toString()
                const user = slot.user || {}
                const itemOutcome = user.item_outcome || {}
                const wasConsumed = itemOutcome.outcome === 'used'

                const { data: existing } = await supabase
                    .from('crime_required_items')
                    .select('id, unit_value')
                    .eq('crime_id', crimeId)
                    .eq('position_id', slot.position_id)
                    .single()

                if (!existing) {
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

        } catch (err: any) {
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
}

async function handleImportCpr(supabase: any, body: RequestBody) {
    const { data: membersData } = body

    if (!membersData) {
        throw new Error('Missing CPR data')
    }

    let membersCount = 0
    let cprRecordsCount = 0

    for (const [memberId, memberData] of Object.entries(membersData) as [string, any][]) {
        const { error: memberError } = await supabase.from('members').upsert({
            member_id: memberId,
            member_name: memberData.name || `Member ${memberId}`,
            tier: memberData.tier || 6,
            last_scraped: memberData.last_scraped,
            updated_at: new Date().toISOString()
        }, { onConflict: 'member_id' })

        if (memberError) {
            console.error(`Error inserting member ${memberId}:`, memberError)
            continue
        }

        membersCount++

        const cprData = memberData.cpr_data || memberData.cpr_by_role || {}
        for (const [level, roles] of Object.entries(cprData) as [string, any][]) {
            for (const [role, value] of Object.entries(roles)) {
                if (typeof value === 'number') {
                    const { error: cprError } = await supabase.from('member_cpr').upsert({
                        member_id: memberId,
                        difficulty_level: parseInt(level),
                        role_name: role,
                        cpr_value: value,
                        updated_at: new Date().toISOString()
                    }, { onConflict: 'member_id,difficulty_level,role_name' })

                    if (!cprError) cprRecordsCount++
                }
            }
        }
    }

    return { success: true, membersCount, cprRecordsCount }
}

async function handleImportCrimes(supabase: any, body: RequestBody) {
    const { data: crimesData } = body

    if (!crimesData) {
        throw new Error('Missing crimes data')
    }

    let crimesCount = 0
    let slotsCount = 0
    let rewardItemsCount = 0
    let requiredItemsCount = 0

    for (const [crimeId, crimeData] of Object.entries(crimesData) as [string, any][]) {
        const { error: crimeError } = await supabase.from('crimes').upsert({
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
            last_updated: crimeData.last_updated || new Date().toISOString(),
            first_seen: crimeData.first_seen || new Date().toISOString(),
            updated_at: new Date().toISOString()
        }, { onConflict: 'crime_id' })

        if (crimeError) {
            console.error(`Error inserting crime ${crimeId}:`, crimeError)
            continue
        }

        crimesCount++

        // Process slots
        const slots = crimeData.slots || []
        for (const slot of slots) {
            const user = slot.user || {}
            const itemReq = slot.item_requirement || {}
            const itemOutcome = user.item_outcome || {}

            const { error: slotError } = await supabase.from('crime_slots').upsert({
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
            }, { onConflict: 'crime_id,position_id' })

            if (!slotError) slotsCount++

            // Insert required item if exists
            if (itemReq.id) {
                const wasConsumed = itemOutcome.outcome === 'used'

                const { error: reqItemError } = await supabase.from('crime_required_items').upsert({
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
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                }, { onConflict: 'crime_id,position_id' })

                if (!reqItemError) requiredItemsCount++
            }
        }

        // Process reward items
        const rewardItems = crimeData.rewards?.items || []
        for (const rewardItem of rewardItems) {
            const itemId = rewardItem.id?.toString()
            if (!itemId) continue

            const { error: rewardError } = await supabase.from('crime_reward_items').upsert({
                crime_id: crimeId,
                item_id: itemId,
                item_name: rewardItem.name || null,
                quantity: rewardItem.quantity || 1,
                unit_value: 0,
                total_value: 0,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            }, { onConflict: 'crime_id,item_id' })

            if (!rewardError) rewardItemsCount++
        }
    }

    return { success: true, crimesCount, slotsCount, rewardItemsCount, requiredItemsCount }
}

async function handleImportPayout(supabase: any, body: RequestBody, userId: string) {
    const { data } = body
    const { weekData, memberRecords } = data

    if (!weekData || !memberRecords) {
        throw new Error('Missing week or member data')
    }

    // Upsert payout week
    const { data: weekResult, error: weekError } = await supabase
        .from('oc_payout_weeks')
        .upsert({
            ...weekData,
            saved_by: userId,
            saved_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        }, { onConflict: 'week_start' })
        .select()
        .single()

    if (weekError) throw weekError

    const weekId = weekResult.id

    // Delete existing member records for this week
    await supabase
        .from('oc_payout_members')
        .delete()
        .eq('week_id', weekId)

    // Insert member records with week_id
    const membersWithWeekId = memberRecords.map((m: any) => ({
        ...m,
        week_id: weekId
    }))

    const { error: membersError } = await supabase
        .from('oc_payout_members')
        .insert(membersWithWeekId)

    if (membersError) throw membersError

    return { success: true, weekId, memberCount: memberRecords.length }
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

async function handleSyncItems(supabase: any, apiKey: string) {
    // Fetch all items from Torn API
    const response = await fetch(
        `https://api.torn.com/v2/torn/items?cat=All&sort=ASC&key=${apiKey}`
    )

    if (!response.ok) {
        throw new Error(`Torn API error: ${response.status}`)
    }

    const data = await response.json()

    if (data.error) {
        throw new Error(data.error.error || 'API error')
    }

    const items = data.items || []

    if (items.length === 0) {
        return { success: true, itemsCount: 0 }
    }

    const itemsToUpsert = items.map((item: any) => ({
        id: item.id,
        name: item.name,
        description: item.description,
        effect: item.effect,
        type: item.type,
        sub_type: item.sub_type,
        market_price: item.value?.market_price || 0,
        sell_price: item.value?.sell_price || 0,
        buy_price: item.value?.buy_price || 0,
        circulation: item.circulation,
        is_tradable: item.is_tradable,
        image_url: item.image,
        last_updated: new Date().toISOString()
    }))

    // Upsert in batches of 500
    const batchSize = 500
    let totalUpserted = 0

    for (let i = 0; i < itemsToUpsert.length; i += batchSize) {
        const batch = itemsToUpsert.slice(i, i + batchSize)

        const { error } = await supabase
            .from('items')
            .upsert(batch, { onConflict: 'id' })

        if (error) {
            throw new Error(`Batch ${i / batchSize + 1} failed: ${error.message}`)
        }

        totalUpserted += batch.length
    }

    return { success: true, itemsCount: totalUpserted }
}

async function handleSyncMembers(supabase: any, apiKey: string) {
    // Fetch current faction members from Torn API
    const response = await fetch(
        `https://api.torn.com/v2/faction/${FACTION_ID}/members?striptags=true&key=${apiKey}`
    )

    if (!response.ok) {
        throw new Error(`Torn API error: ${response.status}`)
    }

    const data = await response.json()

    if (data.error) {
        throw new Error(data.error.error || 'API error')
    }

    const currentMembers = data.members || []
    const currentMemberIds = currentMembers.map((m: any) => m.id.toString())

    // First, set all members to is_current = false
    await supabase
        .from('members')
        .update({ is_current: false })
        .neq('member_id', '0') // Update all

    let membersUpdated = 0
    let membersCreated = 0

    // Now process current members
    for (const member of currentMembers) {
        const memberId = member.id.toString()

        // Check if member exists
        const { data: existing } = await supabase
            .from('members')
            .select('member_id, tier, tier_override')
            .eq('member_id', memberId)
            .single()

        const memberData = {
            member_id: memberId,
            member_name: member.name,
            is_current: true,
            last_seen: new Date().toISOString(),
            updated_at: new Date().toISOString()
        }

        if (existing) {
            // Update existing member
            await supabase
                .from('members')
                .update(memberData)
                .eq('member_id', memberId)

            membersUpdated++
        } else {
            // Create new member with defaults
            await supabase
                .from('members')
                .insert({
                    ...memberData,
                    tier: 6, // Default to lowest tier
                    tier_override: null,
                    first_seen: new Date().toISOString(),
                    last_scraped: null
                })

            membersCreated++
        }
    }

    return {
        success: true,
        totalMembers: currentMembers.length,
        membersUpdated,
        membersCreated,
        membersSetInactive: 0 // Could calculate this if needed
    }
}