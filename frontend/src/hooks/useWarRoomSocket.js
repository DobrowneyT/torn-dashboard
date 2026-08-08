/**
 * War Room live-data hook for API mode (slice #71).
 *
 * Transport: an authenticated WebSocket to /api/war-room/ws. The server
 * sends a full snapshot on connect (so a reconnect IS a resync) and pushes
 * per-channel deltas as the in-process ticker writes them. If the socket
 * drops, a REST poll of /api/war-room/delta keeps the board alive while a
 * reconnect (with backoff) is attempted — the merge logic is identical for
 * both transports.
 *
 * Returns:
 *   { members, ourMembers, dibs, memberStats, config, chain,
 *     isInitialLoading, lastTick, pollError, pollNow }
 *
 * `memberStats` (#336) is LEAD-ONLY and arrives empty for everyone else — the
 * server withholds the channel rather than the client filtering it.
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import { getApiSession, apiGet, apiRefresh } from '../utils/apiClient'
import { mergeVersionedRows, liveRows } from '../utils/warRoomMerge'

const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 15_000
const FALLBACK_POLL_MS = 2000

// Same flatten as useWarRoomPoll: the view was written against flat columns.
function flattenStateRow(row) {
  if (!row) return row
  const s = row.state ?? {}
  return {
    ...row,
    last_action_status:    s.last_action?.status    ?? null,
    last_action_timestamp: s.last_action?.timestamp ?? null,
    status_state:          s.status?.state          ?? null,
    status_description:    s.status?.description    ?? null,
    status_details:        s.status?.details        ?? null,
    status_until:          s.status?.until          ?? null,
    // #330: the aircraft, which gives the travel method and so the flight
    // time. Already in the faction-members payload we poll, so it costs
    // nothing extra. `travel_departed_at` is a real column and arrives on the
    // row itself.
    plane_image_type:      s.status?.plane_image_type ?? null,
    is_revivable:          s.is_revivable          ?? false,
    has_early_discharge:   s.has_early_discharge   ?? false,
    is_in_oc:              s.is_in_oc              ?? false,
    is_on_wall:            s.is_on_wall            ?? false,
    revive_setting:        s.revive_setting        ?? null,
  }
}

export function useWarRoomSocket({ enabled = true, ourFactionId, onAlert }) {
  const stateMapRef = useRef(new Map())
  const dibsMapRef = useRef(new Map())
  const memberStatsMapRef = useRef(new Map())
  const watermarkRef = useRef(null)
  // Keep the alert callback in a ref so it can change without reconnecting.
  const onAlertRef = useRef(onAlert)
  onAlertRef.current = onAlert

  const [members, setMembers] = useState([])
  const [ourMembers, setOurMembers] = useState([])
  const [dibs, setDibs] = useState({})
  /** Our own members' live energy/cooldowns, keyed by member id (#336). */
  const [memberStats, setMemberStats] = useState({})
  const [config, setConfig] = useState(null)
  const [chain, setChain] = useState(null)
  const [isInitialLoading, setIsInitialLoading] = useState(true)
  const [lastTick, setLastTick] = useState(null)
  const [pollError, setPollError] = useState(null)

  const ourFactionIdRef = useRef(ourFactionId)
  ourFactionIdRef.current = ourFactionId

  // Tombstones live in the maps and are filtered out here (#371) — see
  // mergeVersionedRows for why deleting them loses the ability to reject a
  // stale row for that member.
  const publishState = useCallback(() => {
    const all = liveRows(stateMapRef.current).map(flattenStateRow)
    const fid = ourFactionIdRef.current
    setMembers(all.filter(m => Number(m.faction_id) !== Number(fid)))
    setOurMembers(all.filter(m => Number(m.faction_id) === Number(fid)))
  }, [])

  const publishDibs = useCallback(() => {
    const obj = {}
    for (const v of liveRows(dibsMapRef.current)) obj[v.target_id] = v
    setDibs(obj)
  }, [])

  const publishMemberStats = useCallback(() => {
    const obj = {}
    for (const v of liveRows(memberStatsMapRef.current)) obj[String(v.member_id)] = v
    setMemberStats(obj)
  }, [])

  const applyChannel = useCallback((channel, rows) => {
    if (!rows?.length) return
    // Every row-channel merges NEWEST-WINS rather than last-arrival-wins (#371).
    // The socket and the REST delta from pollNow() both write these maps, so a
    // response that was in flight across a write would otherwise land on top of
    // fresher data and hold until the next change — which is what made enemies
    // flicker between Okay and Hospital as they came out.
    if (channel === 'state') {
      mergeVersionedRows(stateMapRef.current, rows, 'member_id')
      publishState()
    } else if (channel === 'dibs') {
      mergeVersionedRows(dibsMapRef.current, rows, 'target_id')
      publishDibs()
    } else if (channel === 'config') {
      setConfig(rows[rows.length - 1])
    } else if (channel === 'chain') {
      setChain(rows[rows.length - 1])
    } else if (channel === 'memberstats') {
      // Live energy/cooldowns for our own members (#336). Lead-only: the
      // server withholds this channel from non-lead sockets entirely, so an
      // ordinary member simply never populates this map.
      mergeVersionedRows(memberStatsMapRef.current, rows, 'member_id')
      publishMemberStats()
    }
  }, [publishState, publishDibs, publishMemberStats])

  const applyFullDelta = useCallback((body, isSnapshot) => {
    if (isSnapshot) {
      stateMapRef.current.clear()
      dibsMapRef.current.clear()
      memberStatsMapRef.current.clear()
    }
    applyChannel('state', body.state?.rows)
    applyChannel('dibs', body.dibs?.rows)
    applyChannel('config', body.config?.rows)
    applyChannel('chain', body.chain?.rows)
    applyChannel('memberstats', body.memberstats?.rows)
    if (isSnapshot) {
      // A snapshot replaces everything, so republish even if a channel was empty.
      publishState()
      publishDibs()
      // Republishing matters most here: a viewer who LOST the lead role gets a
      // snapshot with the channel empty, and must end up with an empty map
      // rather than keeping the stats their previous session cached.
      publishMemberStats()
    }
    if (body.server_now) watermarkRef.current = body.server_now
    setLastTick(Date.now())
    setIsInitialLoading(false)
    setPollError(null)
  }, [applyChannel, publishState, publishDibs, publishMemberStats])

  // REST fallback tick — full snapshot when we have no watermark, delta after.
  const restTick = useCallback(async () => {
    try {
      const since = watermarkRef.current
      const body = await apiGet(`/api/war-room/delta${since ? `?since=${encodeURIComponent(since)}` : ''}`)
      applyFullDelta(body, !since)
    } catch (e) {
      setPollError(e.message ?? String(e))
      setIsInitialLoading(false)
    }
  }, [applyFullDelta])

  useEffect(() => {
    if (!enabled) return
    let alive = true
    let ws = null
    let reconnectDelay = RECONNECT_BASE_MS
    let reconnectTimer = null
    let fallbackTimer = null

    function stopFallback() {
      if (fallbackTimer) clearInterval(fallbackTimer)
      fallbackTimer = null
    }
    function startFallback() {
      if (fallbackTimer) return
      restTick()
      fallbackTimer = setInterval(() => { if (alive) restTick() }, FALLBACK_POLL_MS)
    }

    function connect() {
      const session = getApiSession()
      if (!session?.token) {
        startFallback()
        return
      }
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
      ws = new WebSocket(`${proto}://${window.location.host}/api/war-room/ws?token=${session.token}`)

      ws.onmessage = (event) => {
        if (!alive) return
        try {
          const msg = JSON.parse(event.data)
          if (msg.type === 'snapshot') {
            applyFullDelta(msg, true)
          } else if (msg.type === 'delta') {
            applyChannel(msg.channel, msg.rows)
            if (msg.server_now) watermarkRef.current = msg.server_now
            setLastTick(Date.now())
          } else if (msg.type === 'alert') {
            // Out-of-band event (e.g. a PUSH surge, #208) — fire the sound/flash.
            onAlertRef.current?.(msg)
          }
        } catch (e) {
          console.warn('[useWarRoomSocket] bad frame:', e)
        }
      }
      ws.onopen = () => {
        if (!alive) return
        reconnectDelay = RECONNECT_BASE_MS
        stopFallback()
      }
      ws.onclose = (event) => {
        if (!alive) return
        // Keep the board alive over REST while we reconnect with backoff.
        startFallback()
        // 4401 = auth rejected. With remember-me sessions (#119) that usually
        // means the token aged past its 24h freshness window mid-session —
        // silently refresh it so the next attempt connects, instead of
        // hammering the handshake with the same stale token.
        const next = () => {
          reconnectTimer = setTimeout(connect, reconnectDelay)
          reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS)
        }
        if (event?.code === 4401) apiRefresh().finally(next)
        else next()
      }
      ws.onerror = () => { try { ws.close() } catch { /* noop */ } }
    }

    connect()

    return () => {
      alive = false
      stopFallback()
      if (reconnectTimer) clearTimeout(reconnectTimer)
      try { ws?.close() } catch { /* noop */ }
    }
  }, [enabled, applyChannel, applyFullDelta, restTick])

  // Imperative refresh after a write — one REST delta from the watermark.
  const pollNow = useCallback(() => restTick(), [restTick])

  return { members, ourMembers, dibs, memberStats, config, chain, isInitialLoading, lastTick, pollError, pollNow }
}
