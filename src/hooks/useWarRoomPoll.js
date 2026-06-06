/**
 * War Room v2 polling hook.
 *
 * Replaces the Realtime subscription + initial loadAllMembers flow from v1.
 * On every tick we ask the three delta RPCs for rows whose updated_at has
 * advanced since our last watermark, plus the server's current timestamp.
 * We carry server_now forward as the next p_since — never Date.now(), so
 * client clock skew can't open a gap or cause double-reads.
 *
 * Returns arrays/objects in the same shape v1 components expect so the
 * consumer view is a small diff from WarRoomView.jsx.
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import {
  pollStateDelta,
  pollDibsDelta,
  pollConfigDelta,
  pollChainDelta,
} from '../utils/warRoomApiV2'

const HIDDEN_INTERVAL_MS = 5_000   // when document.visibilityState !== 'visible'

// war_room_state_v2 stores all volatile fields inside a single `state` jsonb
// column. The WarRoomView JSX was written against the legacy flat columns, so
// we flatten once at ingest and expose the familiar shape (m.status_state,
// m.last_action_timestamp, etc.). Mirrors the v1 flattenMemberRow helper.
function flattenStateRow(row) {
  if (!row) return row
  const s = row.state ?? {}
  return {
    ...row,
    last_action_status:    s.last_action?.status    ?? null,
    last_action_timestamp: s.last_action?.timestamp ?? null,
    status_state:          s.status?.state          ?? null,
    status_description:    s.status?.description    ?? null,
    status_until:          s.status?.until          ?? null,
    is_revivable:          s.is_revivable          ?? false,
    has_early_discharge:   s.has_early_discharge   ?? false,
    is_in_oc:              s.is_in_oc              ?? false,
    is_on_wall:            s.is_on_wall            ?? false,
    revive_setting:        s.revive_setting        ?? null,
  }
}

export function useWarRoomPoll({ intervalMs = 1000, enabled = true, ourFactionId }) {
  // Internal canonical state — keyed Maps so applying a delta is O(rows).
  const stateMapRef  = useRef(new Map())  // member_id → row
  const dibsMapRef   = useRef(new Map())  // target_id → dib

  // Public state — derived from the Maps, refreshed via the setters below.
  const [members,    setMembers]    = useState([])
  const [ourMembers, setOurMembers] = useState([])
  const [dibs,       setDibs]       = useState({})
  const [config,     setConfig]     = useState(null)
  const [chain,      setChain]      = useState(null)
  const [isInitialLoading, setIsInitialLoading] = useState(true)
  const [lastTick,   setLastTick]   = useState(null)
  const [pollError,  setPollError]  = useState(null)

  // Watermarks — server-returned timestamps. null on first poll → server
  // treats as -infinity and returns the full snapshot.
  const watermarksRef = useRef({ state: null, dibs: null, config: null, chain: null })

  // Latest values, for the imperatively-called pollNow without stale closures.
  const intervalMsRef = useRef(intervalMs)
  intervalMsRef.current = intervalMs
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const ourFactionIdRef = useRef(ourFactionId)
  ourFactionIdRef.current = ourFactionId

  // Re-derive the public arrays from the Map. Cheap (refs in array form).
  const publishState = useCallback(() => {
    const all = Array.from(stateMapRef.current.values())
    const fid = ourFactionIdRef.current
    setMembers(all.filter(m => m.faction_id !== fid))
    setOurMembers(all.filter(m => m.faction_id === fid))
  }, [])

  const publishDibs = useCallback(() => {
    const obj = {}
    for (const [k, v] of dibsMapRef.current) obj[k] = v
    setDibs(obj)
  }, [])

  // Apply a v2 delta. Tombstoned rows (deleted_at != null) get removed
  // from the Map so the polling channel can carry deletes too.
  const applyStateDelta = useCallback((rows) => {
    if (!rows?.length) return
    let mutated = false
    for (const r of rows) {
      if (r.deleted_at) {
        if (stateMapRef.current.delete(r.member_id)) mutated = true
      } else {
        stateMapRef.current.set(r.member_id, flattenStateRow(r))
        mutated = true
      }
    }
    if (mutated) publishState()
  }, [publishState])

  const applyDibsDelta = useCallback((rows) => {
    if (!rows?.length) return
    let mutated = false
    for (const r of rows) {
      if (r.deleted_at) {
        if (dibsMapRef.current.delete(r.target_id)) mutated = true
      } else {
        dibsMapRef.current.set(r.target_id, r)
        mutated = true
      }
    }
    if (mutated) publishDibs()
  }, [publishDibs])

  const applyConfigDelta = useCallback((rows) => {
    if (!rows?.length) return
    // Singleton table — always just take the row.
    setConfig(rows[rows.length - 1])
  }, [])

  const applyChainDelta = useCallback((rows) => {
    if (!rows?.length) return
    // Singleton table.
    setChain(rows[rows.length - 1])
  }, [])

  // One tick: poll all four delta channels in parallel, advance watermarks
  // atomically per channel using the server-returned timestamp.
  const tick = useCallback(async () => {
    if (!enabledRef.current) return
    try {
      const [s, d, c, h] = await Promise.all([
        pollStateDelta(watermarksRef.current.state),
        pollDibsDelta(watermarksRef.current.dibs),
        pollConfigDelta(watermarksRef.current.config),
        pollChainDelta(watermarksRef.current.chain),
      ])
      applyStateDelta(s.rows)
      applyDibsDelta(d.rows)
      applyConfigDelta(c.rows)
      applyChainDelta(h.rows)
      if (s.serverNow) watermarksRef.current.state  = s.serverNow
      if (d.serverNow) watermarksRef.current.dibs   = d.serverNow
      if (c.serverNow) watermarksRef.current.config = c.serverNow
      if (h.serverNow) watermarksRef.current.chain  = h.serverNow
      setLastTick(Date.now())
      setPollError(null)
    } catch (e) {
      console.error('[useWarRoomPoll] tick error:', e)
      setPollError(e.message ?? String(e))
    } finally {
      setIsInitialLoading(false)
    }
  }, [applyStateDelta, applyDibsDelta, applyConfigDelta, applyChainDelta])

  // Schedule loop. Re-creates the interval when intervalMs / enabled / tab
  // visibility changes. Polls immediately on each (re)schedule for a fast
  // first paint and to consume any rows that landed during a slow period.
  useEffect(() => {
    if (!enabled) return
    let alive = true
    let timerId = null

    function schedule() {
      if (timerId) clearInterval(timerId)
      const hidden = typeof document !== 'undefined' && document.visibilityState !== 'visible'
      const interval = hidden ? HIDDEN_INTERVAL_MS : intervalMs
      // fire-and-forget; tick() owns its own error handling
      tick()
      timerId = setInterval(() => { if (alive) tick() }, interval)
    }

    schedule()

    const onVis = () => { if (alive) schedule() }
    document.addEventListener('visibilitychange', onVis)

    return () => {
      alive = false
      if (timerId) clearInterval(timerId)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [enabled, intervalMs, tick])

  // Imperative trigger — used by save/clear-state flows that want the UI
  // to reflect a write within ~50 ms instead of waiting for the next tick.
  const pollNow = useCallback(() => tick(), [tick])

  return {
    members,
    ourMembers,
    dibs,
    config,
    chain,
    isInitialLoading,
    lastTick,
    pollError,
    pollNow,
  }
}
