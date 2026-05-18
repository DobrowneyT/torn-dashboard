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

// Key selection uses the current Unix second so it's deterministic across all
// Deno Deploy worker instances (no shared mutable state). The selected key
// advances every second, cycling through all N keys every N seconds.
// At 3s polling with 13 keys: each key is used roughly once per 13-second cycle.
// At 0.5s polling with 13 keys: the key changes twice per second — you need
// ≥2 keys to stay under the 100 req/min per-key rate limit.
//
// To revert to a single fixed key, comment out this block and uncomment:
//   function nextTornKey() { return Deno.env.get('TORN_API_KEY') ?? '' }
function nextTornKey(): string {
  if (_tornKeys.length === 0) return ''
  return _tornKeys[Math.floor(Date.now() / 1000) % _tornKeys.length]
}

// ── Auth cache (two-layer) ────────────────────────────────────────────────────
// L1: in-memory Map — zero-latency within a warm instance
// L2: Supabase war_room_auth_cache table — survives cold starts and is shared
//     across all Deno Deploy worker instances (fixes the per-request re-auth)
// TTL: 24 hours. Raw API keys are never stored — only a SHA-256 hex digest.

const AUTH_TTL_MS = 24 * 60 * 60 * 1000
const authMemCache = new Map<string, { userId: string; expiresAt: number }>()

// Module-level admin client used only for auth cache reads/writes
const supabaseAuth = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

async function sha256hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

interface AuthResult {
  success: boolean
  userId?: string
  error?: string
}

async function verifyTornUser(apiKey: string): Promise<AuthResult> {
  // L1: in-memory
  const mem = authMemCache.get(apiKey)
  if (mem && mem.expiresAt > Date.now()) return { success: true, userId: mem.userId }

  // L2: DB cache — one fast DB read instead of a Torn API call on cold starts
  const keyHash = await sha256hex(apiKey)
  const { data: dbCached } = await supabaseAuth
    .from('war_room_auth_cache')
    .select('user_id, expires_at')
    .eq('key_hash', keyHash)
    .maybeSingle()

  if (dbCached && new Date(dbCached.expires_at) > new Date()) {
    authMemCache.set(apiKey, { userId: dbCached.user_id, expiresAt: new Date(dbCached.expires_at).getTime() })
    return { success: true, userId: dbCached.user_id }
  }

  // Cache miss — verify with Torn API (happens at most once per 24h per key)
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

    const expiresAt = new Date(Date.now() + AUTH_TTL_MS).toISOString()
    authMemCache.set(apiKey, { userId, expiresAt: Date.now() + AUTH_TTL_MS })
    // Fire-and-forget — don't block the response on the DB write
    supabaseAuth.from('war_room_auth_cache').upsert({ key_hash: keyHash, user_id: userId, expires_at: expiresAt })

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

  const url = `https://api.torn.com/v2/faction/${factionId}/members?striptags=true&comment=WarRoom&timestamp=${Math.floor(Date.now() / 1000)}&key=${tornKey}`
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
  if (!userId || userId === 'anon') return json({ error: 'user_id required' }, 400)

  // Single-call atomic claim via the war_room_claim_dibs() RPC.
  // The function releases this user's other claims and inserts the new one
  // inside one transaction. The unique partial index on target_id serialises
  // concurrent claims on the same target — only one wins.
  const { data, error } = await supabase.rpc('war_room_claim_dibs', {
    p_target_id: targetId,
    p_user_id:   Number(userId),
    p_user_name: userName,
    p_war_id:    body.war_id ?? null,
  })

  if (error) return json({ error: error.message }, 500)
  if (!data?.ok) {
    return json({
      error: `Already claimed by ${data?.claimed_name ?? 'someone else'}`,
      owner: { id: data?.claimed_by, name: data?.claimed_name },
    }, 409)
  }
  return json({ ok: true })
}

async function handleReleaseDibs(
  supabase: ReturnType<typeof createClient>,
  body: any,
  userId: string
) {
  const targetId = body.target_id
  if (!targetId) return json({ error: 'target_id required' }, 400)
  if (!userId || userId === 'anon') return json({ error: 'user_id required' }, 400)

  const query = supabase
    .from('war_room_dibs')
    .update({ released_at: new Date().toISOString() })
    .eq('target_id', targetId)
    .is('released_at', null)

  // Non-leadership can only release their own
  if (!LEADERSHIP_IDS.includes(String(userId))) {
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
    .select('target_id, claimed_by, claimed_name, claimed_at, war_id')
    .is('released_at', null)

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

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    const body = await req.json()
    const action: string = body.action

    // Polling actions are high-frequency and use server-side TORN_API_KEYS — the
    // user's key is irrelevant to what data gets fetched, so skip the Torn auth
    // verification on these hot paths entirely.
    // Dibs are also unverified — they're already serialised by the DB unique
    // constraint, and the user_id is sent in the body. Trade-off documented.
    const POLL_ACTIONS = new Set(['fetch_members', 'fetch_our_members', 'get_config', 'get_dibs', 'claim_dibs', 'release_dibs'])

    let userId = 'anon'
    if (!POLL_ACTIONS.has(action)) {
      const auth = await verifyTornUser(tornApiKey)
      if (!auth.success) return json({ error: auth.error }, 403)
      userId = auth.userId!
    }

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
        return await handleSetConfig(supabase, body, userId)
      case 'clear_state':
        return await handleClearState(supabase, userId)
      case 'claim_dibs':
        // user_id comes from the body since claim_dibs skips auth (POLL_ACTIONS)
        return await handleClaimDibs(supabase, body, String(body.user_id ?? ''), userName)
      case 'release_dibs':
        return await handleReleaseDibs(supabase, body, String(body.user_id ?? ''))
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
