/**
 * War Room API v2 (self-hosted stack).
 *
 * All writes and Torn-proxying reads go through the faction API on this origin
 * (/api/war-room/*), authorized by the caller's session token. The Torn key
 * pool and leadership checks stay server-side. The one exception is the Nuke
 * revive preset, which POSTs directly from the browser to keep the user's
 * residential IP — see requestRevive for why that matters.
 */
import { getApiSession } from './apiClient'

// Same throw shape as the old edge-function client (err.status / err.payload)
// so call sites' 409-owner handling keeps working unchanged.
async function warRoomApi(method, path, payload) {
  const session = getApiSession()
  const res = await fetch(path, {
    method,
    headers: {
      ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(session ? { authorization: `Bearer ${session.token}` } : {}),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error || `War Room API error: ${res.status}`)
    err.status = res.status
    err.payload = data
    throw err
  }
  return data
}

// ── Writes ───────────────────────────────────────────────────────────────────

export async function fetchWarRoomMembersV2(factionId) {
  // Baselines BOTH factions in one server call (pooled key).
  return warRoomApi('POST', '/api/war-room/fetch-members', { faction_id: factionId })
}

export async function fetchOurMembersV2() {
  // Covered by fetch-members server-side — keep the call site's Promise.all shape.
  return { ok: true }
}

export async function fetchBspStatsV2(memberIds) {
  return warRoomApi('POST', '/api/war-room/fetch-spies', { member_ids: memberIds })
}

export async function setWarRoomConfigV2(updates) {
  return warRoomApi('PUT', '/api/war-room/config', updates)
}

export async function clearWarRoomStateV2() {
  return warRoomApi('POST', '/api/war-room/clear-state', {})
}

// Leader headline banner (#158) — broadcasts on 'config'.
export async function setWarHeadline(text, tone) {
  return warRoomApi('POST', '/api/war-room/headline', { text, tone })
}

export async function clearWarHeadline() {
  return warRoomApi('DELETE', '/api/war-room/headline')
}

// Roll call — member submits/edits their availability for a war. member_id is
// derived server-side from the session.
export async function submitRollCall(warId, answers) {
  return warRoomApi('POST', '/api/war-room/roll-call', { war_id: warId, ...answers })
}

// War notes / type / agreed scores — War Leaders only (enforced server-side).
// `notes` carries war_type, termed_score_us/them, race_target_score,
// notes_public, notes_private, and expected_updated_at (optimistic lock).
export async function saveWarNotes(warId, notes) {
  return warRoomApi('PUT', '/api/war-room/notes', { war_id: warId, ...notes })
}

// Leads-only private note — fetched through the server (never client-readable).
export async function getWarNotesPrivate(warId) {
  return warRoomApi('GET', `/api/war-room/notes/${warId}/private`)
}

/**
 * Previous matchups against one faction (#398), with their roster from the most
 * recent of them. Leads-only server side; visitors may read.
 */
export async function getOpponentHistory(factionId) {
  return warRoomApi('GET', `/api/war-room/history/${factionId}`)
}

export async function claimDibsV2(targetId, warId) {
  return warRoomApi('POST', '/api/war-room/dibs', { target_id: targetId, war_id: warId ?? null })
}

export async function releaseDibsV2(targetId) {
  return warRoomApi('DELETE', `/api/war-room/dibs/${targetId}`)
}

// Assist requests (#523) — live "raise a hand" markers from the attack page.
// The dashboard reads these (see assistBadgeState); it does not currently
// offer a way to RAISE one itself, only to see it and follow the link — the
// requester clears their own from the attack page overlay, or it ages out.
export async function clearAssistV2(targetId) {
  return warRoomApi('DELETE', `/api/war-room/assist/${targetId}`)
}

// Revive request. Transport is chosen by preset, deliberately (#308):
//
//   'json' (UHC/WTF) → POST /api/war-room/revive, proxied server-to-server.
//     The browser cannot POST cross-origin to these services (CORS), so the
//     server forwards it. Identity (userID/userName) is derived from the
//     session server-side and is NOT sent from here.
//
//   'nuke' → direct from the browser. Nuke is gated on source-IP fingerprint:
//     the userscript posts from the user's residential IP, and identical
//     payloads from a datacenter IP are silently shadow-filtered (200, but
//     no reviver ever sees it). The VPS is a datacenter IP, so routing Nuke
//     through the server would look successful while doing nothing. Nuke's
//     response carries `access-control-allow-origin: *` and form-urlencoded
//     is a "simple" CORS request (no preflight), so this needs no server help.
//
// The server implements the Nuke payload shape too — switching Nuke over is a
// one-line change here, once a real Nuke request routed through the VPS is
// confirmed to reach a reviver (the manual gate on #308).
export async function requestRevive({ url, factionName, source, sourceKey, preset, country, userID, userName }) {
  if (preset === 'nuke') {
    return requestReviveNukeDirect({ url, userID, userName, country, source })
  }
  try {
    return await warRoomApi('POST', '/api/war-room/revive', {
      url, factionName, source, sourceKey, preset: preset || 'json',
    })
  } catch (e) {
    // warRoomApi throws on a non-2xx from OUR server (bad url, unreachable
    // service). Flatten to the same result shape the UI already renders, so a
    // proxy failure and a service refusal look alike to the call site.
    return { ok: false, status: e.status ?? 0, body: { reason: e.payload?.error ?? e.message }, url }
  }
}

async function requestReviveNukeDirect({ url, userID, userName, country, source }) {
  const formFields = {
    torn_player_id:      String(userID),
    torn_player_name:    userName ? `${userName} [${userID}]` : String(userID),
    torn_player_country: country || 'Torn',
    app_info:            source || 'War Room',
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

// Map Torn hospital-description adjectives to Nuke's title-cased country names,
// so the direct-browser path produces the same country string the server would.
// Anything that doesn't match is treated as Torn.
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

// ── Chain-save claim ─────────────────────────────────────────────────────────

export async function claimChainSaveV2() {
  return warRoomApi('POST', '/api/war-room/chain-save', {})
}

export async function releaseChainSaveV2() {
  return warRoomApi('DELETE', '/api/war-room/chain-save')
}

// ── Reads: roll-call rows + public notes ─────────────────────────────────────

export async function fetchRollCall(warId) {
  const { responses } = await warRoomApi('GET', `/api/war-room/roll-call?war_id=${warId}`)
  return responses
}

export async function fetchWarNotes(warId) {
  const { notes } = await warRoomApi('GET', `/api/war-room/notes/${warId}`)
  return notes
}

/**
 * One-shot fetch of both chains. Used by the Save flow to seed the chain state
 * for our + the new enemy faction before war room is enabled. Bypasses the cron
 * throttle/cooldown gating.
 */
export async function fetchChainsV2(enemyFactionId) {
  return warRoomApi('POST', '/api/war-room/fetch-chains', { enemy_faction_id: enemyFactionId })
}
