/**
 * War Room API
 * Calls the war-room-fetch Edge Function for all war room operations.
 * The Edge Function holds the Torn API key server-side and writes to Supabase.
 */

const WAR_ROOM_URL = import.meta.env.VITE_SUPABASE_URL + '/functions/v1/war-room-fetch'
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

async function callWarRoom(action, payload, tornApiKey, signal) {
  const response = await fetch(WAR_ROOM_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // The Supabase Edge Function gateway requires Authorization on every
      // call (regardless of verify_jwt setting on the function). The anon
      // key satisfies the gateway; the function does its own Torn-key auth
      // via verifyTornUser() using the x-torn-api-key header below.
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

/** Fetch enemy faction members from Torn API and upsert into war_room_state. */
export async function fetchWarRoomMembers(factionId, tornApiKey) {
  return callWarRoom('fetch_members', { faction_id: factionId }, tornApiKey)
}

/** Fetch our own faction members and upsert into war_room_state. */
export async function fetchOurMembers(tornApiKey) {
  return callWarRoom('fetch_our_members', {}, tornApiKey)
}

/** Get the current war_room_config row. */
export async function getWarRoomConfig(tornApiKey) {
  const data = await callWarRoom('get_config', {}, tornApiKey)
  return data.config
}

/** Update war_room_config. Leadership only. */
export async function setWarRoomConfig(updates, tornApiKey) {
  return callWarRoom('set_config', updates, tornApiKey)
}

/** Delete all rows from war_room_state (call before a new war). Leadership only. */
export async function clearWarRoomState(tornApiKey) {
  return callWarRoom('clear_state', {}, tornApiKey)
}

/** Claim dibs on a target member. `opts.userId` is required (auth is skipped server-side for dibs). */
export async function claimDibs(targetId, userName, warId, tornApiKey, opts = {}) {
  return callWarRoom(
    'claim_dibs',
    { target_id: targetId, user_name: userName, war_id: warId ?? null, user_id: opts.userId },
    tornApiKey,
    opts.signal,
  )
}

/** Release dibs on a target member. `opts.userId` is required. */
export async function releaseDibs(targetId, tornApiKey, opts = {}) {
  return callWarRoom(
    'release_dibs',
    { target_id: targetId, user_id: opts.userId },
    tornApiKey,
    opts.signal,
  )
}

/** Get all active dibs (optionally filtered by war_id). */
export async function getDibs(warId, tornApiKey) {
  return callWarRoom('get_dibs', { war_id: warId ?? null }, tornApiKey)
}

/**
 * Fetch BSP battle stats for a list of member IDs and persist them into war_room_state.
 * This is slow (~300ms per member) — call once on war room enable, not on every poll.
 */
export async function fetchBspStats(memberIds, tornApiKey) {
  return callWarRoom('fetch_bsp', { member_ids: memberIds }, tornApiKey)
}

/**
 * Send a revive request to the configured revive service via the Edge Function
 * (server-side proxy to bypass CORS). Returns { ok, status, body } where body
 * is the parsed JSON response from the service.
 */
export async function requestRevive({ url, userID, userName, factionName, source, sourceKey }, tornApiKey) {
  return callWarRoom('revive_request', { url, userID, userName, factionName, source, sourceKey }, tornApiKey)
}

/**
 * Mint a short-lived Supabase JWT (HS256, 24h) for receiving private war_room
 * realtime broadcasts. The token carries role/torn_user_id/faction_id/
 * is_leadership/is_admin claims. Pass the returned `token` to
 * `supabase.realtime.setAuth(token)` before subscribing to channels.
 *
 * Returns { token, expires_at } where expires_at is a unix-second timestamp.
 */
export async function mintRealtimeToken(tornApiKey) {
  return callWarRoom('mint_realtime_token', {}, tornApiKey)
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
