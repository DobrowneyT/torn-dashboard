import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../utils/supabase'
import {
  fetchWarRoomMembers,
  fetchOurMembers,
  fetchBspStats,
  getWarRoomConfig,
  setWarRoomConfig,
  clearWarRoomState,
  claimDibs,
  releaseDibs,
} from '../utils/warRoomApi'

const OUR_FACTION_ID = 10739
const STATUS_FILTERS   = ['Okay', 'Hospital', 'Flying', 'Jail']
const ACTIVITY_FILTERS = ['Online', 'Idle', 'Offline']

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatStats(n) {
  if (n === null || n === undefined) return '???'
  if (n >= 1_000_000_000_000) return (n / 1_000_000_000_000).toFixed(2) + 'T'
  if (n >= 1_000_000_000)     return (n / 1_000_000_000).toFixed(2) + 'B'
  if (n >= 1_000_000)         return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1_000)             return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

function formatCountdown(secondsRemaining) {
  if (secondsRemaining <= 0) return '—'
  const d = Math.floor(secondsRemaining / 86_400)
  const h = Math.floor((secondsRemaining % 86_400) / 3_600)
  const m = Math.floor((secondsRemaining % 3_600) / 60)
  const s = secondsRemaining % 60
  if (d > 0) return `${d}d ${h}h ${String(m).padStart(2, '0')}m`
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function formatRelative(ts) {
  if (!ts) return '—'
  const diff = Math.floor(Date.now() / 1000) - ts
  if (diff < 60)     return 'just now'
  if (diff < 3_600)  return `${Math.floor(diff / 60)}m ago`
  if (diff < 86_400) return `${Math.floor(diff / 3_600)}h ago`
  return `${Math.floor(diff / 86_400)}d ago`
}

function stateToFilterKey(state) {
  if (state === 'Traveling' || state === 'Abroad') return 'Flying'
  return state
}

function parseTravelInfo(state, description) {
  if (state === 'Traveling') {
    if (description?.startsWith('Returning from ')) {
      return { direction: '← ', dest: description.replace('Returning from ', '') }
    }
    const dest = description?.replace('Traveling to ', '') ?? ''
    return { direction: '→ ', dest }
  }
  if (state === 'Abroad') {
    const dest = description?.replace(/^In /, '') ?? ''
    return { direction: null, dest }
  }
  return null
}

// ── Badges ────────────────────────────────────────────────────────────────────

function ActivityBadge({ status }) {
  const styles = {
    Online:  'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
    Idle:    'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300',
    Offline: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400',
  }
  const dotColor = {
    Online: 'bg-green-500 animate-pulse',
    Idle:   'bg-yellow-500',
    Offline:'bg-gray-400',
  }
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${styles[status] ?? styles.Offline}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dotColor[status] ?? dotColor.Offline}`} />
      {status}
    </span>
  )
}

function StatusCell({ state, description }) {
  const badgeStyles = {
    Okay:      'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
    Hospital:  'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
    Traveling: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
    Abroad:    'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300',
    Fallen:    'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300',
    Jail:      'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-300',
  }
  // Returning = landing; outbound or already abroad = takeoff
  const travelIcon = (state === 'Traveling' && description?.startsWith('Returning from ')) ? '🛬' : '🛫'
  const icons = { Okay: '✓', Hospital: '🏥', Traveling: travelIcon, Abroad: '🛫', Fallen: '💀', Jail: '⛓' }

  const travel = (state === 'Traveling' || state === 'Abroad') ? parseTravelInfo(state, description) : null

  return (
    <div className="flex flex-col gap-0.5">
      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${badgeStyles[state] ?? badgeStyles.Okay}`}>
        <span>{icons[state] ?? '?'}</span>
        {state}
      </span>
      {travel?.dest && (
        <span className="text-xs text-gray-500 dark:text-gray-400 pl-1 whitespace-nowrap">
          {travel.direction}{travel.dest}
        </span>
      )}
    </div>
  )
}

// ── Countdown (ticks every 1s client-side) ────────────────────────────────────

function CountdownCell({ until }) {
  const [now, setNow] = useState(Math.floor(Date.now() / 1000))
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(id)
  }, [])
  if (!until) return <span className="text-gray-300 dark:text-gray-700 text-xs">—</span>
  const rem = until - now
  const urgent = rem > 0 && rem < 300
  if (rem <= 0) return <span className="text-orange-500 dark:text-orange-400 text-xs font-mono animate-pulse">Releasing…</span>
  return (
    <span className={`font-mono text-xs ${urgent ? 'text-orange-600 dark:text-orange-400 font-semibold' : 'text-gray-700 dark:text-gray-300'}`}>
      {formatCountdown(rem)}
    </span>
  )
}

// ── Combined faction status bar ───────────────────────────────────────────────

function ActivityCounts({ members }) {
  const online  = members.filter(m => m.last_action_status === 'Online').length
  const idle    = members.filter(m => m.last_action_status === 'Idle').length
  const offline = members.filter(m => m.last_action_status === 'Offline').length
  return (
    <div className="flex items-center gap-3 text-xs">
      <span className="flex items-center gap-1 text-green-700 dark:text-green-400">
        <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" /> {online}
      </span>
      <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
        <span className="w-2 h-2 rounded-full bg-amber-400" /> {idle}
      </span>
      <span className="flex items-center gap-1 text-gray-500 dark:text-gray-400">
        <span className="w-2 h-2 rounded-full bg-gray-400 dark:bg-gray-600" /> {offline}
      </span>
    </div>
  )
}

function FactionStatusBar({ enemyMembers, ourMembers, factionLabel }) {
  return (
    <div className="card py-2.5 px-4 flex items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide shrink-0">
          {factionLabel ?? 'Enemy'}
        </span>
        <ActivityCounts members={enemyMembers} />
      </div>
      {ourMembers.length > 0 && (
        <div className="flex items-center gap-3">
          <ActivityCounts members={ourMembers} />
          <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide shrink-0">
            Us
          </span>
        </div>
      )}
    </div>
  )
}

// ── Config panel (leadership only) ────────────────────────────────────────────

function ConfigPanel({ config, onSetConfig, onClearState }) {
  const [factionId, setFactionId] = useState(String(config?.faction_id ?? ''))
  const [saving, setSaving]       = useState(false)
  const [clearing, setClearing]   = useState(false)
  const [msg, setMsg]             = useState(null)

  async function handleSave() {
    if (!factionId.trim()) return
    setSaving(true); setMsg(null)
    try {
      await onSetConfig({ faction_id: Number(factionId) })
      setMsg({ ok: true, text: 'Saved.' })
    } catch (e) {
      setMsg({ ok: false, text: e.message })
    } finally { setSaving(false) }
  }

  async function handleClear() {
    if (!confirm('Clear all war room member data? Do this when starting a new war.')) return
    setClearing(true)
    try {
      await onClearState()
      setMsg({ ok: true, text: 'War room state cleared.' })
    } catch (e) {
      setMsg({ ok: false, text: e.message })
    } finally { setClearing(false) }
  }

  return (
    <div className="mt-4 pt-4 border-t border-gray-200 dark:border-slate-700 space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Opponent Faction ID</label>
          <input
            type="text" value={factionId} onChange={e => setFactionId(e.target.value)} placeholder="e.g. 8317"
            className="w-32 px-3 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <button onClick={handleSave} disabled={saving || !factionId.trim()}
          className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg font-medium transition-colors">
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button onClick={handleClear} disabled={clearing}
          className="px-3 py-1.5 text-sm bg-gray-200 hover:bg-gray-300 dark:bg-slate-700 dark:hover:bg-slate-600 text-gray-700 dark:text-gray-300 rounded-lg font-medium transition-colors">
          {clearing ? 'Clearing…' : 'Clear State'}
        </button>
      </div>
      {msg && <p className={`text-xs ${msg.ok ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>{msg.text}</p>}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function WarRoomView({ isLeadership }) {
  const { user } = useAuth()

  const [config, setConfig]         = useState(null)
  const [configLoading, setConfigLoading] = useState(true)
  const [members, setMembers]       = useState([])   // enemy
  const [ourMembers, setOurMembers] = useState([])   // us
  const [dibs, setDibs]             = useState({})   // keyed by target_id

  const [lastFetched, setLastFetched] = useState(null)
  const [pollError, setPollError]     = useState(null)
  const [toggling, setToggling]       = useState(false)
  const [toggleError, setToggleError] = useState(null)
  const [updatingSpies, setUpdatingSpies] = useState(false)
  const [spiesMsg, setSpiesMsg]       = useState(null)
  const [pollIntervalSec, setPollIntervalSec] = useState(3)

  const pollRef        = useRef(null)
  const bspFiredRef    = useRef(false)
  const opponentFidRef = useRef(null)
  const membersRef     = useRef([])
  const dibsRef        = useRef({})
  const userRef        = useRef(user)

  useEffect(() => { opponentFidRef.current = config?.faction_id }, [config?.faction_id])
  useEffect(() => { membersRef.current = members }, [members])
  useEffect(() => { dibsRef.current = dibs }, [dibs])
  useEffect(() => { userRef.current = user }, [user])

  // Filters — Sets; empty = show all
  const [statusFilter, setStatusFilter]     = useState(new Set())
  const [activityFilter, setActivityFilter] = useState(new Set())

  // Sort state
  const [sortCol, setSortCol] = useState('timer')
  const [sortDir, setSortDir] = useState('asc')

  function handleSort(col) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }

  function toggleStatusFilter(key) {
    setStatusFilter(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  function toggleActivityFilter(key) {
    setActivityFilter(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  // ── Load initial data + Realtime subscriptions ────────────────────────────

  useEffect(() => {
    let mounted = true

    async function loadConfig() {
      if (!user?.apiKey) return
      try {
        const cfg = await getWarRoomConfig(user.apiKey)
        if (mounted) setConfig(cfg)
      } catch (e) {
        console.error('War room config load error:', e)
      } finally {
        if (mounted) setConfigLoading(false)
      }
    }

    async function loadAllMembers() {
      const { data } = await supabase.from('war_room_state').select('*')
      if (!mounted || !data) return
      setOurMembers(data.filter(m => m.faction_id === OUR_FACTION_ID))
      setMembers(data.filter(m => m.faction_id !== OUR_FACTION_ID))
    }

    async function loadDibs() {
      const { data } = await supabase
        .from('war_room_dibs').select('target_id, claimed_by, claimed_name').is('released_at', null)
      if (!mounted || !data) return
      const map = {}
      data.forEach(d => { map[d.target_id] = d })
      setDibs(map)
    }

    loadConfig()
    loadAllMembers()
    loadDibs()

    const configSub = supabase.channel('war_room_config_ch')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'war_room_config' }, payload => {
        if (mounted && payload.new) setConfig(payload.new)
      }).subscribe()

    const stateSub = supabase.channel('war_room_state_ch')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'war_room_state' }, ({ new: row }) => {
        if (!mounted) return
        if (row.faction_id === OUR_FACTION_ID) {
          setOurMembers(prev => {
            const idx = prev.findIndex(m => m.member_id === row.member_id)
            return idx >= 0 ? prev.map((m, i) => i === idx ? row : m) : [...prev, row]
          })
        } else {
          setMembers(prev => {
            const idx = prev.findIndex(m => m.member_id === row.member_id)
            return idx >= 0 ? prev.map((m, i) => i === idx ? row : m) : [...prev, row]
          })
        }
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'war_room_state' }, ({ new: row }) => {
        if (!mounted) return
        // Auto-release dibs when a target leaves Okay state (dibs was "used")
        if (row.faction_id !== OUR_FACTION_ID && row.status_state !== 'Okay') {
          const prev = membersRef.current.find(m => m.member_id === row.member_id)
          if (prev?.status_state === 'Okay' && dibsRef.current[row.member_id]) {
            releaseDibs(row.member_id, userRef.current?.apiKey).catch(e => console.error('Auto-release dibs:', e))
            setDibs(d => { const next = { ...d }; delete next[row.member_id]; return next })
          }
        }
        if (row.faction_id === OUR_FACTION_ID) {
          setOurMembers(prev => prev.map(m => m.member_id === row.member_id ? row : m))
        } else {
          setMembers(prev => prev.map(m => m.member_id === row.member_id ? row : m))
        }
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'war_room_state' }, ({ old: row }) => {
        if (!mounted) return
        setMembers(prev => prev.filter(m => m.member_id !== row.member_id))
        setOurMembers(prev => prev.filter(m => m.member_id !== row.member_id))
      })
      .subscribe()

    const dibsSub = supabase.channel('war_room_dibs_ch')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'war_room_dibs' }, ({ new: row }) => {
        if (mounted) setDibs(prev => ({ ...prev, [row.target_id]: row }))
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'war_room_dibs' }, ({ new: row }) => {
        if (!mounted) return
        setDibs(prev => {
          if (row.released_at && prev[row.target_id]?.id === row.id) {
            const next = { ...prev }; delete next[row.target_id]; return next
          }
          return { ...prev, [row.target_id]: row }
        })
      })
      .subscribe()

    return () => {
      mounted = false
      supabase.removeChannel(configSub)
      supabase.removeChannel(stateSub)
      supabase.removeChannel(dibsSub)
    }
  }, [user?.apiKey])

  // ── BSP fire once when members first appear ───────────────────────────────

  useEffect(() => {
    if (!config?.enabled || !members.length || bspFiredRef.current || !user?.apiKey) return
    bspFiredRef.current = true
    const missing = members.filter(m => m.bsp_total === null).map(m => m.member_id)
    if (!missing.length) return
    fetchBspStats(missing, user.apiKey).catch(e => console.error('BSP auto-fetch error:', e))
  }, [members.length, config?.enabled, user?.apiKey])

  // ── Polling loop ──────────────────────────────────────────────────────────

  const poll = useCallback(async () => {
    if (!user?.apiKey || !config?.faction_id) return
    try {
      await Promise.all([
        fetchWarRoomMembers(config.faction_id, user.apiKey),
        fetchOurMembers(user.apiKey),
      ])
      setLastFetched(Date.now())
      setPollError(null)
    } catch (e) {
      console.error('War room poll error:', e)
      setPollError(e.message)
    }
  }, [user?.apiKey, config?.faction_id])

  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current)
    if (config?.enabled && config?.faction_id) {
      poll()
      pollRef.current = setInterval(poll, pollIntervalSec * 1000)
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [config?.enabled, config?.faction_id, poll, pollIntervalSec])

  // ── Leadership actions ────────────────────────────────────────────────────

  async function toggleEnabled() {
    if (!user?.apiKey) return
    setToggling(true); setToggleError(null)
    try {
      const enabling = !config?.enabled
      if (enabling) bspFiredRef.current = false
      await setWarRoomConfig({ enabled: enabling }, user.apiKey)
      setConfig(prev => ({ ...prev, enabled: enabling }))
    } catch (e) {
      setToggleError(e.message)
    } finally { setToggling(false) }
  }

  async function handleSetConfig(updates) {
    await setWarRoomConfig(updates, user.apiKey)
    setConfig(prev => ({ ...prev, ...updates }))
  }

  async function handleClearState() {
    await clearWarRoomState(user.apiKey)
    setMembers([]); setOurMembers([])
  }

  async function handleUpdateSpies() {
    if (!user?.apiKey || !members.length) return
    setUpdatingSpies(true); setSpiesMsg(null)
    try {
      const ids = members.map(m => m.member_id)
      await fetchBspStats(ids, user.apiKey)
      setSpiesMsg({ ok: true, text: `Enriching ${ids.length} members with BSP stats…` })
    } catch (e) {
      setSpiesMsg({ ok: false, text: e.message })
    } finally { setUpdatingSpies(false) }
  }

  // ── Dibs ──────────────────────────────────────────────────────────────────

  async function handleClaimDibs(memberId) {
    if (!user?.apiKey) return
    try {
      // Release any other target this user currently has dibs on (single dibs per member)
      const existing = Object.entries(dibs).find(([, d]) => String(d.claimed_by) === String(user?.id))
      if (existing && Number(existing[0]) !== memberId) {
        const prevTargetId = Number(existing[0])
        await releaseDibs(prevTargetId, user.apiKey)
        setDibs(prev => { const next = { ...prev }; delete next[prevTargetId]; return next })
      }
      await claimDibs(memberId, user.name, null, user.apiKey)
    }
    catch (e) { console.error('Claim dibs error:', e) }
  }

  async function handleReleaseDibs(memberId) {
    if (!user?.apiKey) return
    try { await releaseDibs(memberId, user.apiKey) }
    catch (e) { console.error('Release dibs error:', e) }
  }

  // ── Filtered + sorted member list ─────────────────────────────────────────

  const filtered = useMemo(() => {
    let list = members

    if (statusFilter.size > 0) {
      list = list.filter(m => statusFilter.has(stateToFilterKey(m.status_state)))
    }
    if (activityFilter.size > 0) {
      list = list.filter(m => activityFilter.has(m.last_action_status))
    }

    const d = sortDir === 'asc' ? 1 : -1
    return list.slice().sort((a, b) => {
      switch (sortCol) {
        case 'name':
          return d * a.member_name.localeCompare(b.member_name)
        case 'activity': {
          const order = { Online: 0, Idle: 1, Offline: 2 }
          return d * ((order[a.last_action_status] ?? 3) - (order[b.last_action_status] ?? 3))
        }
        case 'status':
          return d * (a.status_state ?? '').localeCompare(b.status_state ?? '')
        case 'timer': {
          const timerVal = m => {
            if (m.status_state === 'Okay') return 0
            if (m.status_until) return m.status_until
            return 9_999_999_999
          }
          return d * (timerVal(a) - timerVal(b))
        }
        case 'stats':
          return d * ((a.bsp_total ?? -1) - (b.bsp_total ?? -1))
        default: return 0
      }
    })
  }, [members, statusFilter, activityFilter, sortCol, sortDir])

  // ── Sortable header ───────────────────────────────────────────────────────

  function SortTh({ col, children, className = '' }) {
    const active = sortCol === col
    return (
      <th
        onClick={() => handleSort(col)}
        className={`py-2.5 px-3 sticky top-0 bg-gray-50 dark:bg-slate-800/80 border-b border-gray-200 dark:border-slate-700 cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-slate-700/60 transition-colors whitespace-nowrap ${className}`}
      >
        <span className="flex items-center gap-1">
          {children}
          <span className={`text-xs ${active ? 'text-blue-500 dark:text-blue-400' : 'text-gray-300 dark:text-gray-600'}`}>
            {active ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
          </span>
        </span>
      </th>
    )
  }

  // ── Render helpers ─────────────────────────────────────────────────────────

  if (configLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        <span className="ml-3 text-gray-600 dark:text-gray-400">Loading war room…</span>
      </div>
    )
  }

  const isActive   = !!config?.enabled
  const hasMembers = members.length > 0

  const factionLabel = config?.faction_name
    ? `${config.faction_name} (${config.faction_id})`
    : config?.faction_id ? `Faction ${config.faction_id}` : null

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-3">
      {/* Header card */}
      <div className="card">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            {/* Title row */}
            <div className="flex items-center gap-3 flex-wrap">
              <h2 className="text-xl font-bold text-gray-900 dark:text-white">
                War Room{factionLabel ? ` — ${factionLabel}` : ''}
              </h2>
              {isActive && (
                <span className="flex items-center gap-1.5 px-2.5 py-1 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 rounded-full text-xs font-semibold">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" /> LIVE
                </span>
              )}
            </div>
            {/* Subtitle / enemy summary */}
            {!isActive && (
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                {hasMembers
                  ? 'War room paused — showing last-known data. Enable to start live polling.'
                  : 'Real-time enemy faction monitor. Leadership must enable it to start polling.'}
              </p>
            )}
          </div>

          {/* Action buttons */}
          <div className="flex flex-col items-end gap-1.5 shrink-0">
            <div className="flex items-center gap-2 flex-wrap justify-end">
              {isActive && lastFetched && !pollError && (
                <span className="text-xs text-gray-400 dark:text-gray-500 hidden sm:block">
                  {Math.round((Date.now() - lastFetched) / 1000)}s ago
                </span>
              )}
              {isLeadership && (
                <>
                  {/* Poll interval — always visible to leadership */}
                  <div className="flex items-center gap-1.5" title="Polling interval in seconds (min 1s). With key rotation, lower values give fresher data.">
                    <label className="text-xs text-gray-400 dark:text-gray-500 whitespace-nowrap">Poll</label>
                    <input
                      type="number"
                      min={1}
                      max={60}
                      value={pollIntervalSec}
                      onChange={e => setPollIntervalSec(Math.max(1, Math.floor(Number(e.target.value))))}
                      className="w-14 px-2 py-1 text-xs text-center border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <span className="text-xs text-gray-400 dark:text-gray-500">s</span>
                  </div>
                  {isActive ? (
                    <>
                      <button
                        onClick={handleUpdateSpies}
                        disabled={updatingSpies || !hasMembers}
                        title={!hasMembers ? 'No members loaded yet' : 'Fetch BSP battle stats for all members'}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-100 hover:bg-purple-200 dark:bg-purple-900/30 dark:hover:bg-purple-900/50 text-purple-700 dark:text-purple-400 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-sm font-medium transition-colors"
                      >
                        {updatingSpies ? '⏳ Fetching…' : '🔍 Update Spies'}
                      </button>
                      <button
                        onClick={toggleEnabled}
                        disabled={toggling}
                        className="px-3 py-1.5 bg-red-100 hover:bg-red-200 dark:bg-red-900/30 dark:hover:bg-red-900/50 text-red-700 dark:text-red-400 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
                      >
                        {toggling ? 'Stopping…' : 'Stop'}
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={toggleEnabled}
                      disabled={toggling || !config?.faction_id}
                      title={!config?.faction_id ? 'Set an opponent faction ID first' : ''}
                      className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors"
                    >
                      <span className="w-2 h-2 rounded-full bg-white opacity-80" />
                      {toggling ? 'Enabling…' : 'Enable War Room'}
                    </button>
                  )}
                </>
              )}
            </div>
            {(pollError || toggleError || spiesMsg) && (
              <div className="text-right space-y-0.5">
                {pollError   && <p className="text-xs text-red-500 dark:text-red-400">⚠ Poll: {pollError}</p>}
                {toggleError && <p className="text-xs text-red-500 dark:text-red-400">⚠ {toggleError}</p>}
                {spiesMsg    && <p className={`text-xs ${spiesMsg.ok ? 'text-purple-600 dark:text-purple-400' : 'text-red-500 dark:text-red-400'}`}>{spiesMsg.text}</p>}
              </div>
            )}
          </div>
        </div>

        {isLeadership && <ConfigPanel config={config} onSetConfig={handleSetConfig} onClearState={handleClearState} />}

        {/* Filters — shown whenever there are members to filter */}
        {hasMembers && (
          <div className="mt-4 pt-4 border-t border-gray-200 dark:border-slate-700 flex flex-wrap gap-y-2 gap-x-4 items-center">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-xs font-medium text-gray-400 dark:text-gray-500 mr-0.5">Status:</span>
              <button
                onClick={() => setStatusFilter(new Set())}
                className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                  statusFilter.size === 0
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-slate-600'
                }`}
              >
                All
              </button>
              {STATUS_FILTERS.map(f => (
                <button key={f} onClick={() => toggleStatusFilter(f)}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                    statusFilter.has(f)
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-slate-600'
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-xs font-medium text-gray-400 dark:text-gray-500 mr-0.5">Activity:</span>
              <button
                onClick={() => setActivityFilter(new Set())}
                className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                  activityFilter.size === 0
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-slate-600'
                }`}
              >
                All
              </button>
              {ACTIVITY_FILTERS.map(f => (
                <button key={f} onClick={() => toggleActivityFilter(f)}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                    activityFilter.has(f)
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-slate-600'
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Faction status bar — shown when live and enemy members are loaded */}
      {isActive && hasMembers && (
        <FactionStatusBar
          enemyMembers={members}
          ourMembers={ourMembers}
          factionLabel={config?.faction_name ?? (config?.faction_id ? `Faction ${config.faction_id}` : null)}
        />
      )}

      {/* Member table — shown whenever members exist, or when active (so "waiting…" shows) */}
      {(hasMembers || isActive) ? (
        <div className="card p-0 overflow-hidden">
          {/* Paused notice banner */}
          {!isActive && hasMembers && (
            <div className="px-4 py-2 bg-amber-50 dark:bg-amber-900/20 border-b border-amber-200 dark:border-amber-700 text-xs text-amber-700 dark:text-amber-400 flex items-center gap-2">
              <span>⚠</span>
              <span>Paused — last-known snapshot. Timers shown are not live. Enable the war room to start polling.</span>
            </div>
          )}

          {!hasMembers ? (
            <div className="flex items-center justify-center py-16 text-gray-400 dark:text-gray-600 text-sm">
              Waiting for first poll… ({POLL_INTERVAL_MS / 1000}s interval)
            </div>
          ) : (
            <div className="overflow-auto max-h-[65vh]">
              <table className="w-full text-sm border-separate border-spacing-0">
                <thead>
                  <tr className="text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                    <SortTh col="name"     className="px-4">Name</SortTh>
                    <SortTh col="activity">Activity</SortTh>
                    <SortTh col="status">Status</SortTh>
                    <SortTh col="timer">Timer</SortTh>
                    <SortTh col="stats"   className="text-right">Stats</SortTh>
                    <th className="py-2.5 px-3 sticky top-0 bg-gray-50 dark:bg-slate-800/80 border-b border-gray-200 dark:border-slate-700 whitespace-nowrap">Flags</th>
                    <th className="py-2.5 px-3 sticky top-0 bg-gray-50 dark:bg-slate-800/80 border-b border-gray-200 dark:border-slate-700 whitespace-nowrap">Dibs</th>
                    <th className="py-2.5 px-3 sticky top-0 bg-gray-50 dark:bg-slate-800/80 border-b border-gray-200 dark:border-slate-700 whitespace-nowrap">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={8} className="py-12 text-center text-gray-400 dark:text-gray-600 text-sm">
                        No members match the current filters.
                      </td>
                    </tr>
                  )}
                  {filtered.map((m, idx) => {
                    const dib = dibs[m.member_id]
                    const isMyDib = dib && String(dib.claimed_by) === String(user?.id)
                    const rowBg = idx % 2 === 0 ? 'bg-white dark:bg-slate-900' : 'bg-gray-50/50 dark:bg-slate-800/40'

                    return (
                      <tr key={m.member_id} className={`${rowBg} hover:bg-blue-50/30 dark:hover:bg-blue-900/10 transition-colors`}>
                        {/* Name */}
                        <td className="py-2.5 px-4 whitespace-nowrap">
                          <div className="flex items-center gap-2">
                            <a href={`https://www.torn.com/profiles.php?XID=${m.member_id}`}
                              target="_blank" rel="noopener noreferrer"
                              className="font-medium text-blue-600 dark:text-blue-400 hover:underline">
                              {m.member_name}
                            </a>
                            <span className="text-xs text-gray-400 dark:text-gray-600">Lv{m.level}</span>
                          </div>
                        </td>

                        {/* Activity */}
                        <td className="py-2.5 px-3 whitespace-nowrap">
                          <div className="flex flex-col gap-0.5">
                            <ActivityBadge status={m.last_action_status} />
                            <span className="text-xs text-gray-400 dark:text-gray-600">{formatRelative(m.last_action_timestamp)}</span>
                          </div>
                        </td>

                        {/* Status */}
                        <td className="py-2.5 px-3">
                          <StatusCell state={m.status_state} description={m.status_description} />
                        </td>

                        {/* Timer */}
                        <td className="py-2.5 px-3 whitespace-nowrap">
                          <CountdownCell until={m.status_until} />
                        </td>

                        {/* Stats */}
                        <td className="py-2.5 px-3 whitespace-nowrap text-right">
                          <span className={`font-mono text-xs ${m.bsp_total === null ? 'text-gray-400 dark:text-gray-600 italic' : 'text-gray-800 dark:text-gray-200 font-semibold'}`}>
                            {formatStats(m.bsp_total)}
                          </span>
                        </td>

                        {/* Flags */}
                        <td className="py-2.5 px-3 whitespace-nowrap">
                          <div className="flex items-center gap-1.5">
                            {m.is_revivable       && <span title="Revivable"       className="text-base leading-none cursor-default">💉</span>}
                            {m.has_early_discharge && <span title="Early Discharge" className="text-base leading-none cursor-default">⚡</span>}
                            {m.is_in_oc           && <span title="In OC"           className="text-base leading-none cursor-default">🔒</span>}
                            {m.is_on_wall         && <span title="On Wall"         className="text-base leading-none cursor-default">🛡</span>}
                            {!m.is_revivable && !m.has_early_discharge && !m.is_in_oc && !m.is_on_wall && (
                              <span className="text-gray-300 dark:text-gray-700 text-xs">—</span>
                            )}
                          </div>
                        </td>

                        {/* Dibs */}
                        <td className="py-2.5 px-3 whitespace-nowrap">
                          {dib ? (
                            <div className="flex items-center gap-1.5">
                              <span className={`text-xs font-medium ${isMyDib ? 'text-blue-600 dark:text-blue-400' : 'text-gray-600 dark:text-gray-400'}`}>
                                {isMyDib ? 'You' : dib.claimed_name}
                              </span>
                              {isMyDib && (
                                <button onClick={() => handleReleaseDibs(m.member_id)}
                                  className="text-xs text-red-500 hover:text-red-700 dark:text-red-400 underline">
                                  Release
                                </button>
                              )}
                            </div>
                          ) : (
                            <button onClick={() => handleClaimDibs(m.member_id)}
                              className="text-xs px-2 py-0.5 rounded border border-gray-300 dark:border-slate-600 text-gray-600 dark:text-gray-400 hover:border-blue-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors">
                              Claim
                            </button>
                          )}
                        </td>

                        {/* Attack */}
                        <td className="py-2.5 px-3 whitespace-nowrap">
                          <a href={`https://www.torn.com/page.php?sid=attack&user2ID=${m.member_id}`}
                            target="_blank" rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 px-2.5 py-1 bg-red-600 hover:bg-red-700 text-white rounded text-xs font-medium transition-colors">
                            ⚔ Attack
                          </a>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="px-4 py-2.5 border-t border-gray-200 dark:border-slate-700 flex items-center justify-between text-xs text-gray-400 dark:text-gray-600">
            <span>Showing {filtered.length} of {members.length} members</span>
            {isActive
              ? <span>Polling every {pollIntervalSec}s · Timers update every 1s</span>
              : <span>Static snapshot · Enable to refresh</span>
            }
          </div>
        </div>
      ) : (
        // No members and not active — non-leadership sees a simple message
        !isLeadership && (
          <div className="card flex items-center justify-center py-10 text-gray-400 dark:text-gray-600">
            <span className="text-sm">War Room is not currently active.</span>
          </div>
        )
      )}
    </div>
  )
}
