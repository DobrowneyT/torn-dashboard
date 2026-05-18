// DEPLOYMENT NOTE: Deploy with --no-verify-jwt flag
// Deploy command: npx supabase functions deploy war-room-fetch --no-verify-jwt
// Uses custom Torn API key authentication instead of Supabase JWT

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-torn-api-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const LEADERSHIP_IDS = ['2250591', '2749598', '2264192', '2407528', '2932241', '2015160']
const OUR_FACTION_ID = '10739'

// ── Torn API key rotation ─────────────────────────────────────────────────────
// Set TORN_API_KEYS as a Supabase secret: a comma-separated list of one or more keys.
// With N keys, each successive call uses the next key in the list (round-robin),
// bypassing Torn's per-key 30s response cache and allowing sub-second fresh data.
// Single-key fallback: if only one key is provided it always uses that key — same
// behaviour as the old TORN_API_KEY secret (kept below for easy rollback).
//
// To revert to a single key, comment out the TORN_API_KEYS block and uncomment:
//   function nextTornKey() { return Deno.env.get('TORN_API_KEY') ?? '' }

const _tornKeys: string[] = (Deno.env.get('TORN_API_KEYS') ?? '').split(',').map((k: string) => k.trim()).filter(Boolean)
let _tornKeyIndex = 0
function nextTornKey(): string {
  if (_tornKeys.length === 0) return ''
  const key = _tornKeys[_tornKeyIndex % _tornKeys.length]
  _tornKeyIndex++
  return key
}

// Auth cache: keyed by user API key, stores { userId, expiresAt }
const AUTH_CACHE_TTL_MS = 10 * 60 * 1000
const authCache = new Map<string, { userId: string; expiresAt: number }>()

interface AuthResult {
  success: boolean
  userId?: string
  error?: string
}

async function verifyTornUser(apiKey: string): Promise<AuthResult> {
  const cached = authCache.get(apiKey)
  if (cached && cached.expiresAt > Date.now()) {
    return { success: true, userId: cached.userId }
  }

  try {
    const resp = await fetch(`https://api.torn.com/v2/key/info?key=${apiKey}`)
    if (!resp.ok) return { success: false, error: 'Failed to verify API key' }
    const data = await resp.json()
    if (data.error) return { success: false, error: `Torn API error: ${data.error.error}` }

    const userId = String(data.info.user.id)
    const factionId = String(data.info.user.faction?.faction_id ?? '')

    if (factionId !== OUR_FACTION_ID && !LEADERSHIP_IDS.includes(userId)) {
      return { success: false, error: 'Not a faction member' }
    }

    authCache.set(apiKey, { userId, expiresAt: Date.now() + AUTH_CACHE_TTL_MS })
    return { success: true, userId }
  } catch (e) {
    return { success: false, error: `Auth error: ${e}` }
  }
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// ── Action handlers ───────────────────────────────────────────────────────────

async function handleFetchMembers(supabase: ReturnType<typeof createClient>, factionId: number) {
  const tornKey = nextTornKey()
  if (!tornKey) return json({ error: 'TORN_API_KEYS secret not set' }, 500)

  const url = `https://api.torn.com/v2/faction/${factionId}/members?striptags=true&comment=WarRoom&key=${tornKey}`
  const resp = await fetch(url)
  if (!resp.ok) return json({ error: `Torn API HTTP ${resp.status}` }, 502)

  const data = await resp.json()
  if (data.error) return json({ error: `Torn API error ${data.error.code}: ${data.error.error}` }, 502)

  const members = data.members as Record<string, unknown>[]
  const now = Math.floor(Date.now() / 1000)

  const rows = members.map((m: any) => ({
    member_id: m.id,
    member_name: m.name,
    faction_id: factionId,
    level: m.level,
    last_action_status: m.last_action?.status ?? null,
    last_action_timestamp: m.last_action?.timestamp ?? null,
    status_description: m.status?.description ?? null,
    status_state: m.status?.state ?? null,
    status_until: m.status?.until ?? null,
    is_revivable: m.is_revivable ?? false,
    has_early_discharge: m.has_early_discharge ?? false,
    is_in_oc: m.is_in_oc ?? false,
    is_on_wall: m.is_on_wall ?? false,
    revive_setting: m.revive_setting ?? null,
    updated_at: new Date().toISOString(),
  }))

  const { error } = await supabase
    .from('war_room_state')
    .upsert(rows, { onConflict: 'member_id' })

  if (error) return json({ error: `DB upsert error: ${error.message}` }, 500)

  return json({ ok: true, count: rows.length, fetched_at: now })
}

async function handleFetchOurMembers(supabase: ReturnType<typeof createClient>) {
  const tornKey = nextTornKey()
  if (!tornKey) return json({ error: 'TORN_API_KEYS secret not set' }, 500)

  const url = `https://api.torn.com/v2/faction/members?striptags=true&comment=WarRoom&key=${tornKey}`
  const resp = await fetch(url)
  if (!resp.ok) return json({ error: `Torn API HTTP ${resp.status}` }, 502)

  const data = await resp.json()
  if (data.error) return json({ error: `Torn API error ${data.error.code}: ${data.error.error}` }, 502)

  const members = data.members as Record<string, unknown>[]
  const ourFactionId = Number(OUR_FACTION_ID)

  const rows = members.map((m: any) => ({
    member_id: m.id,
    member_name: m.name,
    faction_id: ourFactionId,
    level: m.level,
    last_action_status: m.last_action?.status ?? null,
    last_action_timestamp: m.last_action?.timestamp ?? null,
    status_description: m.status?.description ?? null,
    status_state: m.status?.state ?? null,
    status_until: m.status?.until ?? null,
    is_revivable: m.is_revivable ?? false,
    has_early_discharge: m.has_early_discharge ?? false,
    is_in_oc: m.is_in_oc ?? false,
    is_on_wall: m.is_on_wall ?? false,
    revive_setting: m.revive_setting ?? null,
    updated_at: new Date().toISOString(),
  }))

  const { error } = await supabase
    .from('war_room_state')
    .upsert(rows, { onConflict: 'member_id' })

  if (error) return json({ error: `DB upsert error: ${error.message}` }, 500)

  return json({ ok: true, count: rows.length })
}

async function handleGetConfig(supabase: ReturnType<typeof createClient>) {
  const { data, error } = await supabase
    .from('war_room_config')
    .select('*')
    .eq('id', 1)
    .single()

  if (error) return json({ error: error.message }, 500)
  return json({ config: data })
}

async function handleSetConfig(
  supabase: ReturnType<typeof createClient>,
  body: any,
  userId: string
) {
  if (!LEADERSHIP_IDS.includes(userId)) {
    return json({ error: 'Leadership only' }, 403)
  }

  const update: Record<string, unknown> = {}
  if ('enabled' in body) update.enabled = body.enabled
  if ('faction_id' in body) update.faction_id = body.faction_id
  if ('faction_name' in body) update.faction_name = body.faction_name

  if (body.enabled === true) {
    update.started_by = Number(userId)
    update.started_at = new Date().toISOString()
  }

  const { error } = await supabase
    .from('war_room_config')
    .update(update)
    .eq('id', 1)

  if (error) return json({ error: error.message }, 500)
  return json({ ok: true })
}

async function handleFetchBsp(supabase: ReturnType<typeof createClient>, memberIds: number[]) {
  const bspKey = Deno.env.get('BSP_API_KEY')
  if (!bspKey) return json({ error: 'BSP_API_KEY secret not set' }, 500)
  if (!memberIds?.length) return json({ error: 'member_ids required' }, 400)

  const BSP_DELAY_MS = 30
  const results: Record<number, { total: number | null; str: number | null; spd: number | null; def: number | null; dex: number | null }> = {}

  for (let i = 0; i < memberIds.length; i++) {
    const id = memberIds[i]
    try {
      const resp = await fetch(`http://www.lol-manager.com/api/battlestats/${bspKey}/${id}/TornForge`)
      const data = await resp.json()
      if (data && (data.Result === 1 || data.Result === 6) && data.TBS) {
        results[id] = {
          total: data.TBS ?? null,
          str:   data.Strength ?? null,
          spd:   data.Speed ?? null,
          def:   data.Defense ?? null,
          dex:   data.Dexterity ?? null,
        }
      } else {
        results[id] = { total: null, str: null, spd: null, def: null, dex: null }
      }
    } catch {
      results[id] = { total: null, str: null, spd: null, def: null, dex: null }
    }

    if (i < memberIds.length - 1) {
      await new Promise(r => setTimeout(r, BSP_DELAY_MS))
    }
  }

  // Upsert BSP stats into war_room_state
  const now = new Date().toISOString()
  for (const [idStr, stats] of Object.entries(results)) {
    const id = Number(idStr)
    if (stats.total === null) continue
    await supabase.from('war_room_state').update({
      bsp_total:     stats.total,
      bsp_str:       stats.str,
      bsp_spd:       stats.spd,
      bsp_def:       stats.def,
      bsp_dex:       stats.dex,
      bsp_fetched_at: now,
    }).eq('member_id', id)
  }

  return json({ ok: true, fetched: Object.keys(results).length })
}

async function handleClearState(
  supabase: ReturnType<typeof createClient>,
  userId: string
) {
  if (!LEADERSHIP_IDS.includes(userId)) {
    return json({ error: 'Leadership only' }, 403)
  }

  // Clear dibs too — they're tied to the current war's targets and are
  // meaningless once members are wiped.
  await supabase.from('war_room_dibs').delete().neq('id', 0)

  const { error } = await supabase.from('war_room_state').delete().neq('member_id', 0)
  if (error) return json({ error: error.message }, 500)
  return json({ ok: true })
}

async function handleClaimDibs(
  supabase: ReturnType<typeof createClient>,
  body: any,
  userId: string,
  userName: string
) {
  const targetId = body.target_id
  if (!targetId) return json({ error: 'target_id required' }, 400)

  // Is the target already claimed by someone else?
  const { data: existing } = await supabase
    .from('war_room_dibs')
    .select('id, claimed_by, claimed_name')
    .eq('target_id', targetId)
    .maybeSingle()

  if (existing && String(existing.claimed_by) !== userId) {
    return json({ error: `Already claimed by ${existing.claimed_name}` }, 409)
  }

  // Single-dibs enforcement: hard-delete any other claims I hold, plus my
  // existing claim on this target if I'm re-claiming. The table is reusable
  // (no historical accumulation) — released dibs leave no row.
  await supabase.from('war_room_dibs')
    .delete()
    .eq('claimed_by', Number(userId))

  const { error } = await supabase.from('war_room_dibs').insert({
    target_id: targetId,
    claimed_by: Number(userId),
    claimed_name: userName,
    war_id: body.war_id ?? null,
  })

  if (error) return json({ error: error.message }, 500)
  return json({ ok: true })
}

async function handleReleaseDibs(
  supabase: ReturnType<typeof createClient>,
  body: any,
  userId: string
) {
  const targetId = body.target_id
  if (!targetId) return json({ error: 'target_id required' }, 400)

  const query = supabase
    .from('war_room_dibs')
    .delete()
    .eq('target_id', targetId)

  // Non-leadership can only release their own
  if (!LEADERSHIP_IDS.includes(userId)) {
    query.eq('claimed_by', Number(userId))
  }

  const { error } = await query
  if (error) return json({ error: error.message }, 500)
  return json({ ok: true })
}

async function handleGetDibs(
  supabase: ReturnType<typeof createClient>,
  body: any
) {
  let query = supabase
    .from('war_room_dibs')
    .select('id, target_id, claimed_by, claimed_name, claimed_at, war_id')

  if (body.war_id) query = query.eq('war_id', body.war_id)

  const { data, error } = await query
  if (error) return json({ error: error.message }, 500)
  return json({ dibs: data })
}

// ── Main handler ──────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const tornApiKey = req.headers.get('x-torn-api-key')
    if (!tornApiKey) return json({ error: 'Missing x-torn-api-key header' }, 401)

    const auth = await verifyTornUser(tornApiKey)
    if (!auth.success) return json({ error: auth.error }, 403)

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    const body = await req.json()
    const action: string = body.action

    // Resolve display name for dibs (passed by client to avoid extra API call)
    const userName: string = body.user_name ?? 'Unknown'

    switch (action) {
      case 'fetch_members':
        return await handleFetchMembers(supabase, body.faction_id)
      case 'fetch_our_members':
        return await handleFetchOurMembers(supabase)
      case 'fetch_bsp':
        return await handleFetchBsp(supabase, body.member_ids)
      case 'get_config':
        return await handleGetConfig(supabase)
      case 'set_config':
        return await handleSetConfig(supabase, body, auth.userId!)
      case 'clear_state':
        return await handleClearState(supabase, auth.userId!)
      case 'claim_dibs':
        return await handleClaimDibs(supabase, body, auth.userId!, userName)
      case 'release_dibs':
        return await handleReleaseDibs(supabase, body, auth.userId!)
      case 'get_dibs':
        return await handleGetDibs(supabase, body)
      default:
        return json({ error: `Unknown action: ${action}` }, 400)
    }
  } catch (e) {
    console.error('war-room-fetch error:', e)
    return json({ error: 'Internal server error' }, 500)
  }
})
