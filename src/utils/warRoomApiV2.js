/**
 * War Room API v2
 *
 * Two transport layers:
 *  - Edge Function (writes + Torn API proxying) — same envelope as v1.
 *  - PostgREST RPC (delta polling reads) — direct from the browser to
 *    war_room_*_v2_delta(p_since) Postgres functions.
 *
 * The split mirrors the architectural change: writes still go through the
 * Edge Function so the Torn API key pool and leadership checks stay
 * server-side, but reads bypass the function entirely (and bypass Realtime
 * entirely) and stream as cheap HTTP+gzip from PostgREST.
 */
import { supabase } from './supabase'

const WAR_ROOM_URL = import.meta.env.VITE_SUPABASE_URL + '/functions/v1/war-room-fetch'
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

async function callWarRoom(action, payload, tornApiKey, signal) {
  const response = await fetch(WAR_ROOM_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // The Supabase Edge Function gateway requires Authorization on every
      // call when JWT verification is enabled (i.e., deployed without
      // --no-verify-jwt). The anon key satisfies the gateway. The function
      // still does its own Torn-key auth via verifyTornUser() against the
      // x-torn-api-key header below — no change to the in-function auth.
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'apikey': SUPABASE_ANON_KEY,
      'x-torn-api-key': tornApiKey,
    },
    body: JSON.stringify({ action, ...payload }),
    signal,
  })

  const data = await response.json()
  if (!response.ok) {
    const err = new Error(data.error || `War Room API error: ${response.status}`)
    err.status = response.status
    err.payload = data
    throw err
  }
  return data
}

// ── Edge Function actions (writes) ───────────────────────────────────────────

export async function fetchWarRoomMembersV2(factionId, tornApiKey) {
  return callWarRoom('fetch_members_v2', { faction_id: factionId }, tornApiKey)
}

export async function fetchOurMembersV2(tornApiKey) {
  return callWarRoom('fetch_our_members_v2', {}, tornApiKey)
}

export async function fetchBspStatsV2(memberIds, tornApiKey) {
  return callWarRoom('fetch_bsp_v2', { member_ids: memberIds }, tornApiKey)
}

export async function setWarRoomConfigV2(updates, tornApiKey) {
  return callWarRoom('set_config_v2', updates, tornApiKey)
}

export async function clearWarRoomStateV2(tornApiKey) {
  return callWarRoom('clear_state_v2', {}, tornApiKey)
}

export async function claimDibsV2(targetId, userName, warId, tornApiKey, opts = {}) {
  return callWarRoom(
    'claim_dibs_v2',
    { target_id: targetId, user_name: userName, war_id: warId ?? null, user_id: opts.userId },
    tornApiKey,
    opts.signal,
  )
}

export async function releaseDibsV2(targetId, tornApiKey, opts = {}) {
  return callWarRoom(
    'release_dibs_v2',
    { target_id: targetId, user_id: opts.userId },
    tornApiKey,
    opts.signal,
  )
}

// Revive request still uses the v1 action name (Edge-Function-side proxy is
// shared between v1 and v2 — the action handler itself reads from whichever
// war_room_state* table is canonical at the time).
//
// Nuke is the exception: it is gated on source IP fingerprint — the
// userscript posts from the user's residential IP (via GM_xmlhttpRequest)
// and Nuke's revivers pick those up, but identical payloads sent from our
// Edge Function (Deno datacenter IP) appear to be silently shadow-filtered
// (Nuke returns 200 but the request never reaches the reviver pool). To
// match the userscript's fingerprint we POST directly from the browser.
// Nuke's response carries `access-control-allow-origin: *` and the
// form-urlencoded content-type is a "simple" CORS request (no preflight),
// so this works without any server-side cooperation from them.
export async function requestRevive({ url, userID, userName, factionName, source, sourceKey, preset, country }, tornApiKey) {
  if (preset === 'nuke') {
    return requestReviveNukeDirect({ url, userID, userName, country, source })
  }
  return callWarRoom(
    'revive_request',
    { url, userID, userName, factionName, source, sourceKey, preset },
    tornApiKey,
  )
}

async function requestReviveNukeDirect({ url, userID, userName, country, source }) {
  const formFields = {
    torn_player_id:      String(userID),
    torn_player_name:    userName ? `${userName} [${userID}]` : String(userID),
    torn_player_country: country || 'Torn',
    app_info:            source || 'TNL War Room',
  }
  const body = new URLSearchParams(formFields).toString()
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    const text = await resp.text()
    let parsedBody
    try { parsedBody = JSON.parse(text) } catch { parsedBody = { raw: text } }
    return { ok: resp.ok, status: resp.status, body: parsedBody, sentPayload: formFields, url }
  } catch (e) {
    // Network / CORS failure — surface to caller in the same shape as a
    // server-side error response so the UI can show the reason.
    return { ok: false, status: 0, body: { reason: e.message }, sentPayload: formFields, url }
  }
}

/**
 * Mint a short-lived Supabase JWT (HS256, 4h) for the supabase-js client's
 * `accessToken` async hook. Same claim shape as the realtime token but a
 * tighter TTL since it gates REST queries (not a long-lived websocket).
 *
 * Returns { token, expires_at } where expires_at is a unix-second timestamp.
 */
export async function mintSessionToken(tornApiKey) {
  return callWarRoom('mint_session_token', {}, tornApiKey)
}

// Map Torn hospital-description adjectives to Nuke's title-cased country
// names. Mirrors the server-side logic in war-room-fetch's resolveUserCountry
// so the direct-browser path produces the same country string the Edge
// Function would have. Anything that doesn't match is treated as Torn (which
// covers the standard hospital and "no description available" cases).
const HOSPITAL_COUNTRY_ADJECTIVES = [
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

export function resolveCountryFromDescription(description) {
  if (!description) return 'Torn'
  for (const [pattern, country] of HOSPITAL_COUNTRY_ADJECTIVES) {
    if (pattern.test(description)) return country
  }
  return 'Torn'
}

// ── PostgREST RPC (delta polling reads) ──────────────────────────────────────
//
// The RPCs return TABLE(rows jsonb, server_now timestamptz). supabase-js wraps
// the result in an array, so `data?.[0]` is the row. Pass server_now back as
// the next poll's p_since — never use Date.now() client-side, to avoid clock
// skew opening polling gaps.

function unwrapDelta(data) {
  const row = Array.isArray(data) ? data[0] : data
  return {
    rows: row?.rows ?? [],
    serverNow: row?.server_now ?? null,
  }
}

export async function pollStateDelta(since) {
  const { data, error } = await supabase.rpc('war_room_state_v2_delta', { p_since: since })
  if (error) throw error
  return unwrapDelta(data)
}

export async function pollDibsDelta(since) {
  const { data, error } = await supabase.rpc('war_room_dibs_v2_delta', { p_since: since })
  if (error) throw error
  return unwrapDelta(data)
}

export async function pollConfigDelta(since) {
  const { data, error } = await supabase.rpc('war_room_config_v2_delta', { p_since: since })
  if (error) throw error
  return unwrapDelta(data)
}

export async function pollChainDelta(since) {
  const { data, error } = await supabase.rpc('war_room_chain_v2_delta', { p_since: since })
  if (error) throw error
  return unwrapDelta(data)
}

// ── Chain-save claim Edge Function actions ───────────────────────────────────

export async function claimChainSaveV2(tornApiKey, opts = {}) {
  return callWarRoom('claim_chain_save_v2', { user_id: opts.userId, user_name: opts.userName }, tornApiKey, opts.signal)
}

export async function releaseChainSaveV2(tornApiKey, opts = {}) {
  return callWarRoom('release_chain_save_v2', { user_id: opts.userId }, tornApiKey, opts.signal)
}

/**
 * One-shot fetch of both chains. Used by the Save flow to seed
 * war_room_chain_v2 with current state for our + the new enemy faction
 * before war room is enabled. Bypasses the cron throttle/cooldown gating.
 */
export async function fetchChainsV2(enemyFactionId, tornApiKey) {
  return callWarRoom('fetch_chains_v2', { enemy_faction_id: enemyFactionId }, tornApiKey)
}
