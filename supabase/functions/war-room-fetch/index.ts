// DEPLOYMENT NOTE: Deploy without --no-verify-jwt
// Deploy command: npx supabase functions deploy war-room-fetch
//
// Auth layering:
//   - Gateway: Supabase verifies an `Authorization: Bearer <jwt>` header on
//     every request. Both warRoomApi.js and warRoomApiV2.js send the project
//     anon key, which is itself a JWT signed with the project secret and
//     satisfies the gateway. (Session tokens minted by mint_session_token
//     also work — they carry `role=authenticated` + custom claims, used by
//     PostgREST/RPC calls via the supabase-js accessToken hook.)
//   - Function: actions not in POLL_ACTIONS still call verifyTornUser()
//     against the `x-torn-api-key` header for user-identity auth.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { create, getNumericDate } from "https://deno.land/x/djwt@v3.0.2/mod.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-torn-api-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const LEADERSHIP_IDS = ['2250591', '2749598', '2264192', '2407528', '2932241', '2015160']
// Subset of leadership with the power to release someone else's dibs.
// Mirrors `adminsUserIds` in src/config.js — keep them in sync.
const ADMIN_IDS = ['2250591']
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
    // Torn /v2/key/info returns faction_id as a flat property on user — not
    // nested under `user.faction`. The old nested lookup always yielded ''
    // which broke for any non-leadership member (leadership were rescued by
    // the LEADERSHIP_IDS bypass below).
    const factionId = String(data.info.user.faction_id ?? '')

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

// Build the volatile `state` jsonb for a member from a Torn API member payload.
function buildMemberState(m: any) {
  return {
    status: {
      state:       m.status?.state       ?? null,
      description: m.status?.description ?? null,
      until:       m.status?.until       ?? null,
    },
    last_action: {
      status:    m.last_action?.status    ?? null,
      timestamp: m.last_action?.timestamp ?? null,
    },
    is_revivable:        m.is_revivable        ?? false,
    has_early_discharge: m.has_early_discharge ?? false,
    is_in_oc:            m.is_in_oc            ?? false,
    is_on_wall:          m.is_on_wall          ?? false,
    revive_setting:      m.revive_setting      ?? null,
    updated_at:          new Date().toISOString(),
  }
}

// Deep-equal two member state objects ignoring updated_at (which always differs).
// JSON.stringify isn't safe here: Postgres jsonb does NOT preserve key order, so
// a value round-tripped through the DB stringifies differently than the freshly
// built one even when semantically identical. Compare leaf fields explicitly.
function stateEqual(a: any, b: any): boolean {
  if (!a || !b) return false
  return a.status?.state         === b.status?.state
      && a.status?.description   === b.status?.description
      && a.status?.until         === b.status?.until
      && a.last_action?.status   === b.last_action?.status
      && a.last_action?.timestamp === b.last_action?.timestamp
      && a.is_revivable          === b.is_revivable
      && a.has_early_discharge   === b.has_early_discharge
      && a.is_in_oc              === b.is_in_oc
      && a.is_on_wall            === b.is_on_wall
      && a.revive_setting        === b.revive_setting
}

// Fetch the full faction-spy payload from TornStats.
// API shape (from the userscript reference):
//   GET https://www.tornstats.com/api/v2/{key}/spy/faction/{factionId}
//   → { status, message?, faction: { members: { [id]: { id, spy: {
//        timestamp, strength, speed, defense, dexterity, total } } } } }
// `status: false` plus a `message` field is how TornStats signals errors
// (invalid key, faction not found, rate-limited).
async function fetchTornStatsFactionSpies(apiKey: string, factionId: number) {
  try {
    const resp = await fetch(`https://www.tornstats.com/api/v2/${apiKey}/spy/faction/${factionId}`)
    if (!resp.ok) {
      console.warn('[tornstats] HTTP', resp.status)
      return null
    }
    const data = await resp.json()
    if (data?.status === false) {
      console.warn('[tornstats] error:', data?.message)
      return null
    }
    return data
  } catch (e) {
    console.warn('[tornstats] fetch failed:', e)
    return null
  }
}

// Hospital status descriptions Torn emits use nationality adjectives. Map
// each adjective to the title-cased country name Nuke's API expects. Anything
// not in this table (including the bare "In hospital" form) is treated as
// Torn — the standard hospital has no nationality prefix.
const HOSPITAL_COUNTRY_ADJECTIVES: Array<[RegExp, string]> = [
  [/\bMexican\b/i,       'Mexico'],
  [/\bCaymanian\b/i,     'Cayman Islands'],
  [/\bCanadian\b/i,      'Canada'],
  [/\bHawaiian\b/i,      'Hawaii'],
  [/\bBritish\b/i,       'United Kingdom'],
  [/\bArgentinian\b/i,   'Argentina'],
  [/\bSwiss\b/i,         'Switzerland'],
  [/\bJapanese\b/i,      'Japan'],
  [/\bChinese\b/i,       'China'],
  [/\bEmirati\b/i,       'UAE'],
  [/\bSouth African\b/i, 'South Africa'],
]

/**
 * Resolve the requester's current country from their war_room_state_v2 row.
 * Returns a Nuke-API-compatible title-cased country name, defaulting to
 * "Torn" when the description doesn't match any nationality (which covers
 * both the standard hospital and the "user not in our war_room_state_v2"
 * case). Filters tombstones because a soft-deleted row is "not in state."
 */
async function resolveUserCountry(
  supabase: ReturnType<typeof createClient>,
  userID: number | string,
): Promise<string> {
  const { data } = await supabase
    .from('war_room_state_v2')
    .select('state')
    .eq('member_id', Number(userID))
    .is('deleted_at', null)
    .maybeSingle()
  const description: string = data?.state?.status?.description ?? ''
  for (const [pattern, country] of HOSPITAL_COUNTRY_ADJECTIVES) {
    if (pattern.test(description)) return country
  }
  return 'Torn'
}

// Server-side proxy for revive-service POST requests. Browser cross-origin
// POSTs to services like tornuhc.eu would be blocked by CORS, so we forward
// the call from the Edge Function (server-to-server, no CORS) and return the
// response. The Tampermonkey script equivalent uses GM.xmlHttpRequest for the
// same reason.
//
// Three payload shapes are supported via the `preset` field:
//   - 'json' (default): UHC/WTF style — JSON body with a custom source key
//   - 'nuke': form-encoded body with Nuke's torn_player_id / _name / _country
//     / app_info fields, country resolved server-side from war_room_state
async function handleReviveRequest(
  supabase: ReturnType<typeof createClient>,
  body: any,
) {
  const url: string = body.url
  if (!url || typeof url !== 'string') return json({ error: 'url required' }, 400)
  if (!body.userID) return json({ error: 'userID required' }, 400)

  const preset: string = (body.preset ?? 'json').toString().toLowerCase()

  if (preset === 'nuke') {
    return await sendNukeRequest(supabase, url, body)
  }
  return await sendJsonRequest(url, body)
}

async function sendJsonRequest(url: string, body: any) {
  // Different revive services use different JSON keys for the same value:
  //   UHC → "source"
  //   WTF → "requestChannel"
  // The user picks the right key per-service in the Manage Services modal.
  const sourceKey   = (typeof body.sourceKey === 'string' && body.sourceKey.trim()) || 'source'
  const sourceValue = body.source ?? ''

  const payload: Record<string, unknown> = {
    userID:      body.userID,
    userName:    body.userName    ?? '',
    factionName: body.factionName ?? '',
    [sourceKey]: sourceValue,
  }

  console.log('[revive_request:json] →', { url, payload })

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const text = await resp.text()
    let parsedBody: unknown
    try { parsedBody = JSON.parse(text) } catch { parsedBody = { raw: text } }
    console.log('[revive_request:json] ←', { status: resp.status, body: parsedBody })
    return json({ ok: resp.ok, status: resp.status, body: parsedBody, sentPayload: payload, url })
  } catch (e) {
    console.error('[revive_request:json] error', e)
    return json({ error: `Revive request failed: ${e}` }, 502)
  }
}

async function sendNukeRequest(
  supabase: ReturnType<typeof createClient>,
  url: string,
  body: any,
) {
  const country = await resolveUserCountry(supabase, body.userID)

  // Mirror the userscript exactly: `torn_player_name` is "Name [id]", and the
  // app_info string carries the version of our app for their logs.
  const playerName = body.userName ? `${body.userName} [${body.userID}]` : String(body.userID)
  const formFields: Record<string, string> = {
    torn_player_id:      String(body.userID),
    torn_player_name:    playerName,
    torn_player_country: country,
    app_info:            body.source || 'TNL War Room',
  }
  const formBody = Object.entries(formFields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')

  console.log('[revive_request:nuke] →', { url, formFields })

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody,
    })
    const text = await resp.text()
    let parsedBody: unknown
    try { parsedBody = JSON.parse(text) } catch { parsedBody = { raw: text } }
    console.log('[revive_request:nuke] ←', { status: resp.status, body: parsedBody })
    return json({ ok: resp.ok, status: resp.status, body: parsedBody, sentPayload: formFields, url })
  } catch (e) {
    console.error('[revive_request:nuke] error', e)
    return json({ error: `Revive request failed: ${e}` }, 502)
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// War Room action handlers — HTTP delta-polling architecture
// ═════════════════════════════════════════════════════════════════════════════
//
// Writes go to war_room_state_v2 / war_room_dibs_v2 / war_room_config_v2.
// Reads are done by the client directly via PostgREST RPCs
// (war_room_*_v2_delta) — no "get" actions exist here.
//
// Soft delete: every row has updated_at + deleted_at. To "remove" a row we
// UPDATE deleted_at = now() (the table trigger bumps updated_at). The next
// delta poll sweeps the tombstone to all clients. A scheduled cleanup job
// hard-deletes tombstones older than 24 h.

async function handleFetchMembersV2(
  supabase: ReturnType<typeof createClient>,
  factionId: number,
) {
  const tornKey = nextTornKey()
  if (!tornKey) return json({ error: 'TORN_API_KEYS secret not set' }, 500)

  const url = `https://api.torn.com/v2/faction/${factionId}/members?striptags=true&comment=WarRoom&timestamp=${Math.floor(Date.now() / 1000)}&key=${tornKey}`
  const resp = await fetch(url)
  if (!resp.ok) return json({ error: `Torn API HTTP ${resp.status}` }, 502)

  const data = await resp.json()
  if (data.error) return json({ error: `Torn API error ${data.error.code}: ${data.error.error}` }, 502)

  const members = data.members as Record<string, unknown>[]
  const now = Math.floor(Date.now() / 1000)

  // Lazy backfill of faction display name into the shared `factions` table.
  let factionName: string | null = null
  const { data: cached } = await supabase
    .from('factions').select('name').eq('id', factionId).maybeSingle()
  if (cached?.name) {
    factionName = cached.name as string
  } else {
    try {
      const basicResp = await fetch(`https://api.torn.com/v2/faction/${factionId}/basic?key=${tornKey}`)
      if (basicResp.ok) {
        const basicData = await basicResp.json()
        const basic = basicData?.basic ?? {}
        if (basic.name) {
          factionName = basic.name as string
          await supabase.from('factions').upsert({
            id: factionId,
            name: basic.name,
            tag: basic.tag ?? null,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'id' })
        }
      }
    } catch (e) {
      console.error('[v2] faction basic lookup failed:', e)
    }
  }

  // Diff filter: only push rows whose volatile state actually changed.
  // Include deleted_at so we can reanimate previously tombstoned rows.
  const { data: current } = await supabase
    .from('war_room_state_v2')
    .select('member_id, state, deleted_at')
    .eq('faction_id', factionId)
  const currentMap = new Map<number, { state: any; deleted_at: string | null }>(
    (current ?? []).map((r: any) => [r.member_id, { state: r.state, deleted_at: r.deleted_at }])
  )

  const candidates = members.map((m: any) => ({
    member_id:   m.id,
    member_name: m.name,
    faction_id:  factionId,
    level:       m.level,
    position:    m.position ?? null,
    state:       buildMemberState(m),
    deleted_at:  null,
  }))

  // A row needs writing if: (a) state changed, OR (b) it exists with
  // deleted_at set (reanimating after a clear/leave/rejoin).
  const changed = candidates.filter(row => {
    const prev = currentMap.get(row.member_id)
    if (!prev) return true
    if (prev.deleted_at !== null) return true
    return !stateEqual(prev.state, row.state)
  })

  if (changed.length > 0) {
    const { error } = await supabase
      .from('war_room_state_v2')
      .upsert(changed, { onConflict: 'member_id' })
    if (error) return json({ error: `DB upsert error: ${error.message}` }, 500)
  }

  // Tombstone members who left the faction (present in DB, missing from API).
  // Only counts rows that aren't already tombstoned.
  const currentIds = new Set(candidates.map(c => c.member_id))
  const stale = (current ?? [])
    .filter((r: any) => r.deleted_at === null && !currentIds.has(r.member_id))
    .map((r: any) => r.member_id)
  let tombstoned = 0
  if (stale.length > 0) {
    const { error: tombError, count } = await supabase
      .from('war_room_state_v2')
      .update({ deleted_at: new Date().toISOString() }, { count: 'exact' })
      .eq('faction_id', factionId)
      .in('member_id', stale)
    if (tombError) return json({ error: `DB tombstone error: ${tombError.message}` }, 500)
    tombstoned = count ?? stale.length
  }

  return json({
    ok: true,
    count: changed.length,
    tombstoned,
    total: members.length,
    fetched_at: now,
    faction_name: factionName,
  })
}

async function handleFetchOurMembersV2(supabase: ReturnType<typeof createClient>) {
  const tornKey = nextTornKey()
  if (!tornKey) return json({ error: 'TORN_API_KEYS secret not set' }, 500)

  // Same explicit faction-id URL fix as v1: never use /v2/faction/members
  // (which depends on the API key owner's faction).
  const url = `https://api.torn.com/v2/faction/${OUR_FACTION_ID}/members?striptags=true&comment=WarRoom&key=${tornKey}`
  const resp = await fetch(url)
  if (!resp.ok) return json({ error: `Torn API HTTP ${resp.status}` }, 502)

  const data = await resp.json()
  if (data.error) return json({ error: `Torn API error ${data.error.code}: ${data.error.error}` }, 502)

  const members = data.members as Record<string, unknown>[]
  const ourFactionId = Number(OUR_FACTION_ID)

  const { data: current } = await supabase
    .from('war_room_state_v2')
    .select('member_id, state, deleted_at')
    .eq('faction_id', ourFactionId)
  const currentMap = new Map<number, { state: any; deleted_at: string | null }>(
    (current ?? []).map((r: any) => [r.member_id, { state: r.state, deleted_at: r.deleted_at }])
  )

  const candidates = members.map((m: any) => ({
    member_id:   m.id,
    member_name: m.name,
    faction_id:  ourFactionId,
    level:       m.level,
    position:    m.position ?? null,
    state:       buildMemberState(m),
    deleted_at:  null,
  }))

  const changed = candidates.filter(row => {
    const prev = currentMap.get(row.member_id)
    if (!prev) return true
    if (prev.deleted_at !== null) return true
    return !stateEqual(prev.state, row.state)
  })

  if (changed.length > 0) {
    const { error } = await supabase
      .from('war_room_state_v2')
      .upsert(changed, { onConflict: 'member_id' })
    if (error) return json({ error: `DB upsert error: ${error.message}` }, 500)
  }

  // Tombstone ex-members (present in DB, missing from current API roster).
  const currentIds = new Set(candidates.map(c => c.member_id))
  const stale = (current ?? [])
    .filter((r: any) => r.deleted_at === null && !currentIds.has(r.member_id))
    .map((r: any) => r.member_id)
  let tombstoned = 0
  if (stale.length > 0) {
    const { error: tombError, count } = await supabase
      .from('war_room_state_v2')
      .update({ deleted_at: new Date().toISOString() }, { count: 'exact' })
      .eq('faction_id', ourFactionId)
      .in('member_id', stale)
    if (tombError) return json({ error: `DB tombstone error: ${tombError.message}` }, 500)
    tombstoned = count ?? stale.length
  }

  return json({ ok: true, count: changed.length, tombstoned, total: members.length })
}

async function handleFetchBspV2(
  supabase: ReturnType<typeof createClient>,
  memberIds: number[],
) {
  const bspKey = Deno.env.get('BSP_API_KEY')
  const tsKey = Deno.env.get('TORNSTATS_API_KEY')
  if (!bspKey) return json({ error: 'BSP_API_KEY secret not set' }, 500)
  if (!tsKey)  return json({ error: 'TORNSTATS_API_KEY secret not set' }, 500)
  if (!memberIds?.length) return json({ error: 'member_ids required' }, 400)

  const now = new Date().toISOString()
  let tornstatsFilled = 0
  let needBsp: number[] = memberIds.slice()

  // ── Pass 1: TornStats faction spies (same logic as v1) ────────────────
  const { data: enemySample } = await supabase
    .from('war_room_state_v2')
    .select('faction_id')
    .in('member_id', memberIds)
    .neq('faction_id', Number(OUR_FACTION_ID))
    .is('deleted_at', null)
    .limit(1)
    .maybeSingle()
  const enemyFactionId: number | null = enemySample?.faction_id ?? null

  if (tsKey && enemyFactionId) {
    const { data: cfg } = await supabase
      .from('war_room_config_v2')
      .select('tornstats_max_age_days')
      .eq('id', 1)
      .maybeSingle()
    const maxAgeDays: number = cfg?.tornstats_max_age_days ?? 0

    const spies = await fetchTornStatsFactionSpies(tsKey, enemyFactionId)
    const memberIdSet = new Set(memberIds.map(Number))
    const minTimestamp = maxAgeDays > 0
      ? Math.floor((Date.now() - maxAgeDays * 86_400_000) / 1000)
      : 0

    if (spies?.faction?.members && typeof spies.faction.members === 'object') {
      const filledIds: number[] = []
      for (const key of Object.keys(spies.faction.members)) {
        const entry = spies.faction.members[key]
        const id = Number(entry?.id ?? key)
        if (!memberIdSet.has(id)) continue
        const spy = entry?.spy
        if (!spy || typeof spy.total !== 'number' || spy.total <= 0) continue
        if (typeof spy.timestamp !== 'number' || spy.timestamp < minTimestamp) continue

        const { error: upErr } = await supabase.from('war_room_state_v2').update({
          bsp_total:      spy.total,
          bsp_str:        spy.strength ?? null,
          bsp_spd:        spy.speed ?? null,
          bsp_def:        spy.defense ?? null,
          bsp_dex:        spy.dexterity ?? null,
          bsp_fetched_at: now,
        }).eq('member_id', id)
        if (!upErr) filledIds.push(id)
      }
      tornstatsFilled = filledIds.length
      const filledSet = new Set(filledIds)
      needBsp = memberIds.filter(id => !filledSet.has(id))
    }
  }

  // ── Pass 2: BSP for anyone TornStats didn't fill ──────────────────────
  const BSP_DELAY_MS = 30
  const results: Record<number, { total: number | null; str: number | null; spd: number | null; def: number | null; dex: number | null }> = {}

  for (let i = 0; i < needBsp.length; i++) {
    const id = needBsp[i]
    try {
      const bspResp = await fetch(`http://www.lol-manager.com/api/battlestats/${bspKey}/${id}/TornForge`)
      const bspData = await bspResp.json()
      if (bspData && (bspData.Result === 1 || bspData.Result === 6) && bspData.TBS) {
        results[id] = {
          total: bspData.TBS ?? null,
          str:   bspData.Strength ?? null,
          spd:   bspData.Speed ?? null,
          def:   bspData.Defense ?? null,
          dex:   bspData.Dexterity ?? null,
        }
      } else {
        results[id] = { total: null, str: null, spd: null, def: null, dex: null }
      }
    } catch {
      results[id] = { total: null, str: null, spd: null, def: null, dex: null }
    }
    if (i < needBsp.length - 1) {
      await new Promise(r => setTimeout(r, BSP_DELAY_MS))
    }
  }

  let bspFilled = 0
  for (const [idStr, stats] of Object.entries(results)) {
    const id = Number(idStr)
    if (stats.total === null) continue
    await supabase.from('war_room_state_v2').update({
      bsp_total:      stats.total,
      bsp_str:        stats.str,
      bsp_spd:        stats.spd,
      bsp_def:        stats.def,
      bsp_dex:        stats.dex,
      bsp_fetched_at: now,
    }).eq('member_id', id)
    bspFilled++
  }

  return json({
    ok: true,
    fetched: tornstatsFilled + bspFilled,
    tornstats: tornstatsFilled,
    bsp: bspFilled,
    requested: memberIds.length,
  })
}

async function handleSetConfigV2(
  supabase: ReturnType<typeof createClient>,
  body: any,
  userId: string,
) {
  if (!LEADERSHIP_IDS.includes(userId)) {
    return json({ error: 'Leadership only' }, 403)
  }

  const update: Record<string, unknown> = {}
  if ('enabled' in body) update.enabled = body.enabled
  if ('faction_id' in body) update.faction_id = body.faction_id
  if ('faction_name' in body) update.faction_name = body.faction_name
  if ('revive_service_name' in body) update.revive_service_name = body.revive_service_name
  if ('revive_service_url'  in body) update.revive_service_url  = body.revive_service_url
  if ('revive_services'     in body) update.revive_services     = body.revive_services
  if ('tornstats_max_age_days' in body) update.tornstats_max_age_days = body.tornstats_max_age_days
  if ('chain_poll_interval_ours_sec'  in body) update.chain_poll_interval_ours_sec  = body.chain_poll_interval_ours_sec
  if ('chain_poll_interval_enemy_sec' in body) update.chain_poll_interval_enemy_sec = body.chain_poll_interval_enemy_sec

  if (body.enabled === true) {
    update.started_by = Number(userId)
    update.started_at = new Date().toISOString()
  }

  const { error } = await supabase
    .from('war_room_config_v2')
    .update(update)
    .eq('id', 1)
  if (error) return json({ error: error.message }, 500)
  return json({ ok: true })
}

async function handleClearStateV2(
  supabase: ReturnType<typeof createClient>,
  userId: string,
) {
  if (!LEADERSHIP_IDS.includes(userId)) {
    return json({ error: 'Leadership only' }, 403)
  }

  const tombstoneTime = new Date().toISOString()

  // Soft-delete every live row in state + dibs. The trigger bumps updated_at,
  // so clients sweep them up on the next delta poll. Subsequent fetches will
  // upsert with deleted_at = null, reanimating any rows that come back.
  const { error: stateErr } = await supabase
    .from('war_room_state_v2')
    .update({ deleted_at: tombstoneTime })
    .is('deleted_at', null)
  if (stateErr) return json({ error: `state clear error: ${stateErr.message}` }, 500)

  const { error: dibsErr } = await supabase
    .from('war_room_dibs_v2')
    .update({ deleted_at: tombstoneTime })
    .is('deleted_at', null)
  if (dibsErr) return json({ error: `dibs clear error: ${dibsErr.message}` }, 500)

  return json({ ok: true })
}

async function handleClaimDibsV2(
  supabase: ReturnType<typeof createClient>,
  body: any,
  userId: string,
  userName: string,
) {
  const targetId = body.target_id
  if (!targetId) return json({ error: 'target_id required' }, 400)
  if (!userId || userId === 'anon') return json({ error: 'user_id required' }, 400)

  // Already live-claimed by someone else?
  const { data: existing } = await supabase
    .from('war_room_dibs_v2')
    .select('id, claimed_by, claimed_name')
    .eq('target_id', targetId)
    .is('deleted_at', null)
    .maybeSingle()
  if (existing && String(existing.claimed_by) !== userId) {
    return json({
      error: `Already claimed by ${existing.claimed_name}`,
      owner: { id: existing.claimed_by, name: existing.claimed_name },
    }, 409)
  }

  // Single-dibs enforcement: tombstone any other live claims by this user
  // (including the same target if re-claiming). Clients poll the tombstones
  // and prune. The unique partial index on (target_id) WHERE deleted_at IS NULL
  // ensures only the new live row blocks future claimers.
  const tombstoneTime = new Date().toISOString()
  await supabase.from('war_room_dibs_v2')
    .update({ deleted_at: tombstoneTime })
    .eq('claimed_by', Number(userId))
    .is('deleted_at', null)

  const { error } = await supabase.from('war_room_dibs_v2').insert({
    target_id: targetId,
    claimed_by: Number(userId),
    claimed_name: userName,
    war_id: body.war_id ?? null,
  })
  if (error) return json({ error: error.message }, 500)
  return json({ ok: true })
}

async function handleReleaseDibsV2(
  supabase: ReturnType<typeof createClient>,
  body: any,
  userId: string,
) {
  const targetId = body.target_id
  if (!targetId) return json({ error: 'target_id required' }, 400)
  if (!userId || userId === 'anon') return json({ error: 'user_id required' }, 400)

  const query = supabase
    .from('war_room_dibs_v2')
    .update({ deleted_at: new Date().toISOString() })
    .eq('target_id', targetId)
    .is('deleted_at', null)

  // Non-admins can only release their own dibs.
  if (!ADMIN_IDS.includes(String(userId))) {
    query.eq('claimed_by', Number(userId))
  }

  const { error } = await query
  if (error) return json({ error: error.message }, 500)
  return json({ ok: true })
}

// ── Chain telemetry ─────────────────────────────────────────────────────────
// State lives in the singleton war_room_chain_v2 (id=1). The cron tick reads
// the row, decides per-side whether to poll, fires Torn API calls in parallel,
// and updates the row. Throttle/force/pause logic per the plan doc:
//
//   * Active chain (cooldown <= now): poll on the cadence below, but FORCE
//     a poll when timeout - now <= 6s so we catch the hit-vs-drop transition.
//   * Cooldown chain (cooldown > now): skip entirely until cooldown ends.
//     The first tick after cooldown ends triggers a confirming poll.
//   * Idle (no chain): poll on normal cadence to detect a new chain start.
//
// Cadences: ours = 5s, enemy = 30s. Tunable here only.

// Defaults if config columns are unset. Leadership can override per-side via
// the chain_poll_interval_*_sec columns on war_room_config_v2.
const CHAIN_POLL_INTERVAL_OURS_MS_DEFAULT  = 5_000
const CHAIN_POLL_INTERVAL_ENEMY_MS_DEFAULT = 30_000
const CHAIN_FORCE_BEFORE_EXPIRY_S          = 6

type ChainRow = {
  current:               number | null
  max:                   number | null
  modifier:              number | null
  timeout:               number | null
  start_ts:              number | null
  cooldown:              number | null
  end_ts:                number | null
  save_claimed_by:       number | null
  save_claimed_name:     string | null
  save_claimed_at:       string | null
  enemy:                 any
  our_last_fetched_at:   string | null
  enemy_last_fetched_at: string | null
}

function chainSidePollDecision(
  side: 'ours' | 'enemy',
  row: ChainRow | null,
  nowMs: number,
  oursIntervalMs: number,
  enemyIntervalMs: number,
): boolean {
  const intervalMs = side === 'ours' ? oursIntervalMs : enemyIntervalMs
  const nowSec = Math.floor(nowMs / 1000)

  // For enemy chain we look at row.enemy.{...}; for ours at the top-level fields.
  const cooldown = side === 'ours' ? row?.cooldown : row?.enemy?.cooldown
  const timeout  = side === 'ours' ? row?.timeout  : row?.enemy?.timeout
  const lastIso  = side === 'ours' ? row?.our_last_fetched_at : row?.enemy_last_fetched_at

  // Cooldown in the future → pause polling.
  if (cooldown && cooldown > nowSec) return false

  // Force when timeout is within the safety window.
  if (timeout && timeout > nowSec && timeout - nowSec <= CHAIN_FORCE_BEFORE_EXPIRY_S) return true

  // Force one confirming poll right after cooldown ends, even if cadence hasn't elapsed.
  if (cooldown && cooldown > 0 && cooldown <= nowSec) {
    const lastMs = lastIso ? new Date(lastIso).getTime() : 0
    if (lastMs < cooldown * 1000) return true
  }

  // Normal cadence.
  const lastMs = lastIso ? new Date(lastIso).getTime() : 0
  return nowMs - lastMs >= intervalMs
}

// Fetch /v2/faction/{id}/chain. Returns null on any failure so the caller can
// short-circuit without aborting the cron tick.
async function fetchChainFromTorn(factionId: number): Promise<any | null> {
  const tornKey = nextTornKey()
  if (!tornKey) return null
  try {
    const resp = await fetch(
      `https://api.torn.com/v2/faction/${factionId}/chain?key=${tornKey}&comment=WarRoom`,
    )
    if (!resp.ok) return null
    const data = await resp.json()
    if (data.error) {
      console.warn(`[chain] faction ${factionId} torn error:`, data.error)
      return null
    }
    return data.chain ?? null
  } catch (e) {
    console.warn(`[chain] faction ${factionId} fetch failed:`, e)
    return null
  }
}

async function pollOurChain(
  supabase: ReturnType<typeof createClient>,
  prev: ChainRow | null,
): Promise<{ polled: boolean; reason?: string }> {
  const chain = await fetchChainFromTorn(Number(OUR_FACTION_ID))
  if (!chain) return { polled: false, reason: 'torn fetch failed' }

  // Torn's v2 /faction/{id}/chain returns timeout and cooldown as
  // SECONDS REMAINING, not unix timestamps (only `start` and `end` are
  // timestamps). Convert to absolute unix timestamps at write time so the
  // client and throttle logic can do simple `value > now` comparisons.
  const nowSec        = Math.floor(Date.now() / 1000)
  const timeoutSecs   = Number(chain.timeout  ?? 0)
  const cooldownSecs  = Number(chain.cooldown ?? 0)
  const timeoutAbs    = timeoutSecs  > 0 ? nowSec + timeoutSecs  : 0
  const cooldownAbs   = cooldownSecs > 0 ? nowSec + cooldownSecs : 0

  const newCurrent   = chain.current ?? 0
  const prevCurrent  = prev?.current  ?? 0
  const prevCooldown = prev?.cooldown ?? 0
  // Clear the save claim when the chain advances (claimer made the hit) OR
  // when the chain enters cooldown (drop — no one needs to save anymore).
  const hitDetected       = newCurrent > prevCurrent
  const droppedToCooldown = cooldownAbs > 0 && prevCooldown === 0

  const update: Record<string, unknown> = {
    current:             newCurrent,
    max:                 chain.max ?? null,
    modifier:            chain.modifier ?? null,
    timeout:             timeoutAbs,
    start_ts:            chain.start ?? null,
    cooldown:            cooldownAbs,
    end_ts:              chain.end ?? null,
    our_last_fetched_at: new Date().toISOString(),
  }
  if (hitDetected || droppedToCooldown) {
    update.save_claimed_by   = null
    update.save_claimed_name = null
    update.save_claimed_at   = null
  }

  const { error } = await supabase.from('war_room_chain_v2').update(update).eq('id', 1)
  if (error) return { polled: false, reason: error.message }
  return { polled: true }
}

async function pollEnemyChain(
  supabase: ReturnType<typeof createClient>,
  enemyFactionId: number,
): Promise<{ polled: boolean; reason?: string }> {
  const chain = await fetchChainFromTorn(enemyFactionId)
  if (!chain) return { polled: false, reason: 'torn fetch failed' }

  // Same seconds-remaining → unix-timestamp normalisation as pollOurChain.
  const nowSec       = Math.floor(Date.now() / 1000)
  const timeoutSecs  = Number(chain.timeout  ?? 0)
  const cooldownSecs = Number(chain.cooldown ?? 0)

  // Enemy chain is value+cooldown only. Store as JSONB so future fields land
  // for free. Top-level columns stay reserved for OUR chain.
  const enemyPayload = {
    current:  chain.current  ?? 0,
    max:      chain.max      ?? null,
    modifier: chain.modifier ?? null,
    timeout:  timeoutSecs  > 0 ? nowSec + timeoutSecs  : 0,
    cooldown: cooldownSecs > 0 ? nowSec + cooldownSecs : 0,
    end:      chain.end      ?? 0,
    start:    chain.start    ?? 0,
  }

  const { error } = await supabase.from('war_room_chain_v2').update({
    enemy:                 enemyPayload,
    enemy_last_fetched_at: new Date().toISOString(),
  }).eq('id', 1)
  if (error) return { polled: false, reason: error.message }
  return { polled: true }
}

// ── Chain save claim actions ────────────────────────────────────────────────

async function handleClaimChainSaveV2(
  supabase: ReturnType<typeof createClient>,
  _body: any,
  userId: string,
  userName: string,
) {
  if (!userId || userId === 'anon') return json({ error: 'user_id required' }, 400)

  const { data: existing } = await supabase
    .from('war_room_chain_v2')
    .select('save_claimed_by, save_claimed_name')
    .eq('id', 1)
    .maybeSingle()

  if (existing?.save_claimed_by && String(existing.save_claimed_by) !== userId) {
    return json({
      error: `Already claimed by ${existing.save_claimed_name}`,
      owner: { id: existing.save_claimed_by, name: existing.save_claimed_name },
    }, 409)
  }

  const { error } = await supabase.from('war_room_chain_v2').update({
    save_claimed_by:   Number(userId),
    save_claimed_name: userName,
    save_claimed_at:   new Date().toISOString(),
  }).eq('id', 1)
  if (error) return json({ error: error.message }, 500)
  return json({ ok: true })
}

async function handleReleaseChainSaveV2(
  supabase: ReturnType<typeof createClient>,
  _body: any,
  userId: string,
) {
  if (!userId || userId === 'anon') return json({ error: 'user_id required' }, 400)

  let query = supabase.from('war_room_chain_v2').update({
    save_claimed_by:   null,
    save_claimed_name: null,
    save_claimed_at:   null,
  }).eq('id', 1)

  // Non-admins can only release their own claim.
  if (!ADMIN_IDS.includes(String(userId))) {
    query = query.eq('save_claimed_by', Number(userId))
  }

  const { error } = await query
  if (error) return json({ error: error.message }, 500)
  return json({ ok: true })
}

// ── Centralised cron-driven polling ──────────────────────────────────────────
// Replaces N×viewer × (1 / pollIntervalSec) Torn API calls with a single
// global tick driven by pg_cron. The client no longer runs the Torn fetch
// loop in useEffect — only the Save flow and Update Spies trigger one-shot
// fetches. The hook still polls the DB delta RPCs for UI updates.
//
// Auth: this action skips the x-torn-api-key requirement at the top of the
// handler (see CRON_ACTIONS in the dispatcher). It authenticates via the
// x-cron-secret header against the CRON_SECRET Edge Function env var, set
// once via `npx supabase secrets set CRON_SECRET=<value>`.
//
// The same secret must be stored in Vault as `war_room_cron_secret` for
// the Postgres-side cron to read. See the war_room_cron migration.

// Sub-second polling: pg_cron's minimum interval is 1s, but each cron tick
// invocation runs TWO fetch cycles 500ms apart. Effective polling rate ≈
// 500ms when the Edge Function runtime is fast enough to keep up.
// Tune INNER_TICKS / SLEEP_MS together to change the effective rate.
const CRON_INNER_TICKS = 2
const CRON_INNER_SLEEP_MS = 500

async function handleCronPoll(
  supabase: ReturnType<typeof createClient>,
  req: Request,
) {
  const cronSecret = Deno.env.get('CRON_SECRET')
  if (!cronSecret) return json({ error: 'CRON_SECRET not configured' }, 500)
  if (req.headers.get('x-cron-secret') !== cronSecret) {
    return json({ error: 'Invalid cron secret' }, 401)
  }

  const { data: cfg, error: cfgErr } = await supabase
    .from('war_room_config_v2')
    .select('enabled, faction_id, chain_poll_interval_ours_sec, chain_poll_interval_enemy_sec')
    .eq('id', 1)
    .maybeSingle()
  if (cfgErr) return json({ error: `config read failed: ${cfgErr.message}` }, 500)

  if (!cfg?.enabled || !cfg.faction_id) {
    return json({ ok: true, skipped: true, reason: cfg?.enabled ? 'no faction' : 'paused' })
  }

  // Resolve per-side chain cadences from config with sane fallbacks.
  // Clamp to [1, 600] seconds so a typo in the UI can't accidentally stop
  // polling entirely or pin Torn 1000×/s.
  const oursIntervalMs = Math.min(600, Math.max(1, Number(cfg.chain_poll_interval_ours_sec ?? 5)))  * 1000
  const enemyIntervalMs = Math.min(600, Math.max(1, Number(cfg.chain_poll_interval_enemy_sec ?? 30))) * 1000

  // Chain polling fires AT MOST ONCE per cron invocation (not per inner tick).
  // chainSidePollDecision() decides whether each side is actually due — most
  // ticks no-op. Member polling stays on the inner-tick loop for 500ms effect.
  const { data: chainRow } = await supabase
    .from('war_room_chain_v2').select('*').eq('id', 1).maybeSingle()
  const nowMs = Date.now()
  const chainTasks: Array<Promise<{ side: string; polled: boolean; reason?: string }>> = []
  if (chainSidePollDecision('ours', chainRow as ChainRow | null, nowMs, oursIntervalMs, enemyIntervalMs)) {
    chainTasks.push(
      pollOurChain(supabase, chainRow as ChainRow | null)
        .then(r => ({ side: 'ours', ...r })),
    )
  }
  if (chainSidePollDecision('enemy', chainRow as ChainRow | null, nowMs, oursIntervalMs, enemyIntervalMs)) {
    chainTasks.push(
      pollEnemyChain(supabase, Number(cfg.faction_id))
        .then(r => ({ side: 'enemy', ...r })),
    )
  }

  const ticks: Array<{ enemy: any; our: any }> = []

  for (let i = 0; i < CRON_INNER_TICKS; i++) {
    // Fire both polls in parallel within a tick — they're independent. We
    // re-use the existing action handlers (which return Response objects)
    // so this stays a thin orchestrator.
    const [enemyResp, ourResp] = await Promise.all([
      handleFetchMembersV2(supabase, cfg.faction_id),
      handleFetchOurMembersV2(supabase),
    ])
    const enemy = await enemyResp.json().catch(() => ({ error: 'json parse failed' }))
    const our   = await ourResp.json().catch(() => ({ error: 'json parse failed' }))
    ticks.push({ enemy, our })

    // Sleep between inner ticks; skip after the last one.
    if (i < CRON_INNER_TICKS - 1) {
      await new Promise(r => setTimeout(r, CRON_INNER_SLEEP_MS))
    }
  }

  const chains = await Promise.all(chainTasks)
  return json({ ok: true, ticks, chains })
}

// ── JWT minting (realtime + session auth) ────────────────────────────────────
// Mints JWTs signed with the project's SUPABASE_JWT_SECRET so the frontend
// can prove identity to PostgREST (REST queries) AND Supabase Realtime
// (private broadcasts). Both consumers verify the signature against the
// same secret, so a single token shape works for either path.
//
// Caller must already be verified via verifyTornUser() (these actions are NOT
// in POLL_ACTIONS, so the standard auth flow runs before we get here).
//
// Claims:
//   role          = 'authenticated' (so RLS policies `TO authenticated` apply)
//   sub           = `torn-{userId}` (stable per Torn account)
//   torn_user_id  = Torn account id
//   faction_id    = our faction id
//   is_leadership = mirrors LEADERSHIP_IDS list
//   is_admin      = mirrors ADMIN_IDS list
//
// Two endpoints exist because they have different lifetimes:
//   - mint_realtime_token: 24h. Long-lived to match websocket persistence.
//     Used by WarRoomView's existing realtime.setAuth() loop today.
//   - mint_session_token: 4h. Shorter so a stolen/stale token loses value
//     faster, and faction membership re-checks happen ~every 4h. Used by
//     the supabase-js client's accessToken async hook for REST queries.
// They can be unified later once the frontend fully consumes the shared
// sessionToken module for realtime auth too.

const JWT_TTL_SESSION_SECONDS = 4 * 60 * 60   // 4h

async function mintAuthToken(userId: string, ttlSeconds: number) {
  // Set this once via `npx supabase secrets set JWT_SECRET=<value>`.
  // The value comes from Supabase Dashboard → Project Settings → API → JWT Secret.
  // Can't be named SUPABASE_JWT_SECRET — Supabase reserves the SUPABASE_ prefix.
  const jwtSecret = Deno.env.get('jwt_secret')
  if (!jwtSecret) return { error: 'JWT_SECRET secret not set', status: 500 }
  if (!userId || userId === 'anon') return { error: 'user_id required', status: 400 }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(jwtSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )

  const expiresAt = getNumericDate(ttlSeconds)
  const token = await create(
    { alg: 'HS256', typ: 'JWT' },
    {
      aud:           'authenticated',
      role:          'authenticated',
      sub:           `torn-${userId}`,
      torn_user_id:  userId,
      faction_id:    OUR_FACTION_ID,
      is_leadership: LEADERSHIP_IDS.includes(userId),
      is_admin:      ADMIN_IDS.includes(userId),
      iat: getNumericDate(0),
      exp: expiresAt,
    },
    key,
  )

  return { token, expiresAt }
}

async function handleMintSessionToken(userId: string) {
  const result = await mintAuthToken(userId, JWT_TTL_SESSION_SECONDS)
  if ('error' in result) return json({ error: result.error }, result.status)
  return json({ token: result.token, expires_at: result.expiresAt })
}

// ── Main handler ──────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    const body = await req.json()
    const action: string = body.action

    // Cron-driven actions authenticate via x-cron-secret instead of a Torn
    // API key. Skip the x-torn-api-key requirement and the verifyTornUser
    // call entirely; the action handler does its own auth check.
    const CRON_ACTIONS = new Set(['cron_poll_war_room'])

    // Polling actions are high-frequency and use server-side TORN_API_KEYS — the
    // user's key is irrelevant to what data gets fetched, so skip the Torn auth
    // verification on these hot paths entirely.
    // Dibs are also unverified — they're already serialised by the DB unique
    // constraint, and the user_id is sent in the body. Trade-off documented.
    const POLL_ACTIONS = new Set([
      'revive_request',
      // v2 polling/dibs actions are high-frequency. Server-side TORN_API_KEYS,
      // claim_dibs serialised by the war_room_dibs_v2 unique partial index.
      'fetch_members_v2', 'fetch_our_members_v2', 'claim_dibs_v2', 'release_dibs_v2',
      // Chain-save claim uses the same trust model — body carries user_id,
      // single-row table serialises naturally on conflict.
      'claim_chain_save_v2', 'release_chain_save_v2',
    ])

    let userId = 'anon'
    if (!CRON_ACTIONS.has(action)) {
      const tornApiKey = req.headers.get('x-torn-api-key')
      if (!tornApiKey) return json({ error: 'Missing x-torn-api-key header' }, 401)
      if (!POLL_ACTIONS.has(action)) {
        const auth = await verifyTornUser(tornApiKey)
        if (!auth.success) return json({ error: auth.error }, 403)
        userId = auth.userId!
      }
    }

    // Resolve display name for dibs (passed by client to avoid extra API call)
    const userName: string = body.user_name ?? 'Unknown'

    switch (action) {
      case 'revive_request':
        return await handleReviveRequest(supabase, body)
      case 'mint_session_token':
        // Mints a 4h JWT (role=authenticated + custom claims) consumed by the
        // frontend's supabase-js accessToken hook so PostgREST/RPC calls
        // carry the JWT. Auth runs via verifyTornUser() in the gate above.
        return await handleMintSessionToken(userId)

      // ── War Room v2 actions ──────────────────────────────────────────
      case 'fetch_members_v2':
        return await handleFetchMembersV2(supabase, body.faction_id)
      case 'fetch_our_members_v2':
        return await handleFetchOurMembersV2(supabase)
      case 'fetch_bsp_v2':
        return await handleFetchBspV2(supabase, body.member_ids)
      case 'set_config_v2':
        return await handleSetConfigV2(supabase, body, userId)
      case 'clear_state_v2':
        return await handleClearStateV2(supabase, userId)
      case 'claim_dibs_v2':
        return await handleClaimDibsV2(supabase, body, String(body.user_id ?? ''), userName)
      case 'release_dibs_v2':
        return await handleReleaseDibsV2(supabase, body, String(body.user_id ?? ''))

      // ── Chain-save claim ─────────────────────────────────────────────
      case 'claim_chain_save_v2':
        return await handleClaimChainSaveV2(supabase, body, String(body.user_id ?? ''), userName)
      case 'release_chain_save_v2':
        return await handleReleaseChainSaveV2(supabase, body, String(body.user_id ?? ''))

      // ── Centralised cron-driven polling ──────────────────────────────
      case 'cron_poll_war_room':
        return await handleCronPoll(supabase, req)

      default:
        return json({ error: `Unknown action: ${action}` }, 400)
    }
  } catch (e) {
    console.error('war-room-fetch error:', e)
    return json({ error: 'Internal server error' }, 500)
  }
})
