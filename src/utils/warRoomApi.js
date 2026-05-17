/**
 * War Room API
 * Calls the war-room-fetch Edge Function for all war room operations.
 * The Edge Function holds the Torn API key server-side and writes to Supabase.
 */

const WAR_ROOM_URL = import.meta.env.VITE_SUPABASE_URL + '/functions/v1/war-room-fetch'

async function callWarRoom(action, payload, tornApiKey) {
  const response = await fetch(WAR_ROOM_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-torn-api-key': tornApiKey,
    },
    body: JSON.stringify({ action, ...payload }),
  })

  const data = await response.json()

  if (!response.ok) {
    throw new Error(data.error || `War Room API error: ${response.status}`)
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

/** Claim dibs on a target member. */
export async function claimDibs(targetId, userName, warId, tornApiKey) {
  return callWarRoom('claim_dibs', { target_id: targetId, user_name: userName, war_id: warId ?? null }, tornApiKey)
}

/** Release dibs on a target member. */
export async function releaseDibs(targetId, tornApiKey) {
  return callWarRoom('release_dibs', { target_id: targetId }, tornApiKey)
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
