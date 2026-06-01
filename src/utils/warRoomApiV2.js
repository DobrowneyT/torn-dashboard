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

async function callWarRoom(action, payload, tornApiKey, signal) {
  const response = await fetch(WAR_ROOM_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
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

// Revive request still uses the v1 action (Edge-Function-side proxy is shared).
export async function requestRevive({ url, userID, userName, factionName, source, sourceKey, preset }, tornApiKey) {
  return callWarRoom(
    'revive_request',
    { url, userID, userName, factionName, source, sourceKey, preset },
    tornApiKey,
  )
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
