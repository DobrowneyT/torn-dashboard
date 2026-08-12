import { useEffect, useMemo, useState, useCallback } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { apiGet } from '../utils/apiClient'
import BattleStatsCell from '../components/BattleStatsCell'
import { matchesStatRange } from '../utils/statInput'
import {
  indexBattleStats, withBattleStats, battleStatsSortValue, matchesStatsSource,
} from '../utils/warRoomBattleStats'
import { STAT_PATHS_BY_KEY } from '../utils/statPaths'
import {
  buildMemberRow, classifyRow, summarizeCompliance, isInactive, PI_NAME,
} from '../utils/memberMetrics'
import { formatCurrency } from '../utils/payoutCalculations'
import {
  fetchSavedViews, createSavedView, updateSavedView, deleteSavedView,
  fetchThresholdSets, createThresholdSet, updateThresholdSet, deleteThresholdSet,
} from '../utils/leadershipViews'
import StatPickerModal from '../components/StatPickerModal'
import ThresholdModal from '../components/ThresholdModal'

// ────────────────────────────────────────────────────────────────────────────
// Constants & built-in views
// ────────────────────────────────────────────────────────────────────────────

// We pull the member's full stored history once (projected to catalog stats
// server-side, so it stays small) and window it client-side — no refetch on
// window change. "All" now genuinely spans everything, not a 30-day cap.
const TIME_WINDOWS = [
  { id: '1d',   label: '1d',   days: 1 },
  { id: '7d',   label: '7d',   days: 7 },
  { id: '30d',  label: '30d',  days: 30 },
  { id: '90d',  label: '90d',  days: 90 },
  { id: '365d', label: '1y',   days: 365 },
  { id: 'all',  label: 'All',  days: null },
]

// Built-in presets — always available, can't be edited or deleted.
const BUILT_IN_VIEWS = [
  {
    id: 'default',
    name: 'Default',
    columns: ['name', 'level', 'timeplayed', 'refills', 'xantaken', 'energydrinkused', 'property', 'donator', 'activitystreak'],
    builtin: true,
  },
  {
    id: 'war',
    name: 'War',
    columns: ['name', 'level', 'rankedwarhits', 'attackswon', 'retals', 'respectforfaction'],
    builtin: true,
  },
  {
    id: 'crimes',
    name: 'Crimes',
    columns: ['name', 'tier', 'organizedcrimes', 'crimestotal', 'alcoholused', 'bustssuccess', 'nerverefills'],
    builtin: true,
  },
  {
    id: 'activity',
    name: 'Activity',
    columns: ['name', 'gym_energy', 'energydrinkused', 'statenhancersused', 'xantaken', 'bloodwithdrawn', 'bustssuccess', 'timeplayed', 'activitystreak'],
    builtin: true,
  },
]

// ────────────────────────────────────────────────────────────────────────────
// Identity columns — not in STAT_PATHS, sourced from members + profile + gym
// ────────────────────────────────────────────────────────────────────────────

const IDENTITY_COLUMNS = {
  name: {
    label: 'Name',
    sortValue: r => r.member_name?.toLowerCase() ?? '',
    render: r => (
      <span className={r.data_partial ? 'underline decoration-amber-400 decoration-2 underline-offset-2' : ''} title={r.data_partial ? r.data_partial_reason : undefined}>
        <a
          href={`https://www.torn.com/profiles.php?XID=${r.member_id}`}
          target="_blank" rel="noopener noreferrer"
          className="font-medium text-blue-600 dark:text-blue-400 hover:underline"
        >
          {r.member_name ?? `[${r.member_id}]`}
        </a>
        <span className="ml-2 text-xs text-gray-400 dark:text-gray-600">[{r.member_id}]</span>
      </span>
    ),
  },
  level: {
    label: 'Level',
    sortValue: r => r.level ?? 0,
    render: r => r.level ?? '—',
  },
  last_active: {
    label: 'Last Active',
    sortValue: r => r.last_action_timestamp ?? 0,
    render: r => formatRelativeTime(r.last_action_timestamp),
    compliance: r => isInactive(r.last_action_timestamp) ? 'red' : null,
  },
  donator: {
    label: 'Donator',
    sortValue: r => (r.is_donator ? 1 : 0),
    render: r => r.is_donator ? (r.donator_label ?? 'Yes') : (r.is_donator === false ? '—' : '?'),
    compliance: r => (r.is_donator === false ? 'red' : null),
  },
  property: {
    label: 'Property',
    sortValue: r => r.property_name ?? '',
    render: r => r.property_name ?? '—',
    compliance: r => (r.property_name && r.property_name !== PI_NAME ? 'red' : null),
  },
  tier: {
    label: 'Tier',
    sortValue: r => r.tier ?? 0,
    render: r => r.tier ?? '—',
  },
  days_in_faction: {
    label: 'Total Days',
    sortValue: r => r.total_days_in_faction ?? -1,
    render: r => r.total_days_in_faction == null
      ? <span className="text-gray-400">—</span>
      : <span className="font-mono">{r.total_days_in_faction.toLocaleString()}</span>,
  },
  streak: {
    label: 'Streak',
    sortValue: r => r.streak_days ?? -1,
    render: r => r.streak_days == null
      ? <span className="text-gray-400">—</span>
      : <span className="font-mono">{r.streak_days.toLocaleString()}d</span>,
  },
  battle_stats: {
    label: 'Battle Stats',
    // Null, not 0, so the sort sinks unread members in BOTH directions (#351).
    sortValue: r => battleStatsSortValue(r),
    render: r => <BattleStatsCell member={r} />,
  },
  gym_energy: {
    label: 'Gym Energy/d',
    sortValue: r => r.gym_energy_perday ?? -1,
    render: (r, _ctx) => {
      if (r.gym_energy_perday == null) return <span className="text-gray-400">—</span>
      const daily = r.gym_energy_perday
      const total = r.gym_energy_delta
      return (
        <span className="font-mono">
          {Math.round(daily).toLocaleString()}
          {total != null && r.days_covered > 0 && (
            <span className="ml-1.5 text-xs text-gray-400 dark:text-gray-500">
              ({Math.round(total).toLocaleString()} in {r.days_covered}d)
            </span>
          )}
        </span>
      )
    },
  },
}

// Identity columns surfaced in the stat-picker modal (anything users can pick).
const IDENTITY_COLUMNS_FOR_MODAL = Object.entries(IDENTITY_COLUMNS).map(([key, def]) => ({
  key, label: def.label,
}))

// ────────────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────────────

export default function MemberOverview() {
  // Battle stats are the most sensitive number we hold about a member — they
  // decide who can hit whom — so the endpoint is gated to war leads and above
  // (#348). Visitors reach this page through the leadership layout but are NOT
  // in that set, so the column must not render for them either. The server is
  // the real guard; this only avoids a pointless 403 and an empty column.
  const { isLeadership, isAdmin, isWarLead } = useAuth()
  const canSeeBattleStats = Boolean(isLeadership || isAdmin || isWarLead)
  const { user } = useAuth()

  // ── Data ──
  const [snapshots, setSnapshots] = useState([])
  const [members, setMembers]     = useState([])
  const [battleStats, setBattleStats] = useState({})
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState(null)

  // ── UI state ──
  const [timeWindow, setTimeWindow]           = useState('30d')
  const [activeViewId, setActiveViewId]       = useState('default')
  const [activeThresholdId, setActiveThresholdId] = useState(null)
  const [search, setSearch]                   = useState('')
  const [donatorFilter, setDonatorFilter]     = useState('any')
  const [piFilter, setPiFilter]               = useState('any')
  const [activeFilter, setActiveFilter]       = useState('any')
  const [minTenure, setMinTenure]             = useState('')   // '' = no tenure filter
  const [statsMin, setStatsMin]               = useState('')   // '' = no bound
  const [statsMax, setStatsMax]               = useState('')
  const [statsSource, setStatsSource]         = useState('any')
  const [sortCol, setSortCol]                 = useState('name')
  const [sortDir, setSortDir]                 = useState('asc')
  const [showWarningsOnly, setShowWarningsOnly] = useState(false)
  const [showInconclusiveOnly, setShowInconclusiveOnly] = useState(false)

  // ── Shared (DB-backed) views & thresholds ──
  const [savedViews, setSavedViews]         = useState([])
  const [thresholdSets, setThresholdSets]   = useState([])
  const [viewModalOpen, setViewModalOpen]   = useState(false)
  const [viewModalMode, setViewModalMode]   = useState('new')   // 'new' | 'edit'
  const [thresholdModalOpen, setThresholdModalOpen] = useState(false)
  const [thresholdModalMode, setThresholdModalMode] = useState('new')

  // ── Load data ──
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        setLoading(true)

        // Pull the full history once (server projects it to catalog stats), then
        // window it client-side — so every window incl. "All" works instantly.
        const [snapshotsResp, membersResp, viewsResp, threshResp, statsResp] = await Promise.all([
          apiGet(`/api/overview/daily-stats?window=all`),
          apiGet('/api/members'),
          fetchSavedViews().catch(e => { console.warn('saved views fetch failed', e); return [] }),
          fetchThresholdSets().catch(e => { console.warn('threshold sets fetch failed', e); return [] }),
          // Swallowed on failure rather than fatal: a 403 here is the ordinary
          // answer for a role without battle-stats access, and the rest of the
          // page has nothing to do with it.
          canSeeBattleStats
            ? apiGet('/api/members/battle-stats').catch(e => { console.warn('battle stats fetch failed', e); return null })
            : Promise.resolve(null),
        ])
        if (cancelled) return
        setSnapshots(snapshotsResp.snapshots ?? [])
        setMembers(membersResp.members ?? [])
        setBattleStats(indexBattleStats(statsResp?.battle_stats ?? []))
        setSavedViews(viewsResp ?? [])
        setThresholdSets(threshResp ?? [])
        setLoading(false)
      } catch (e) {
        if (!cancelled) { setError(e.message); setLoading(false) }
      }
    })()
    return () => { cancelled = true }
  }, [])

  // ── Group snapshots by member (already newest-first) ──
  const snapshotsByMember = useMemo(() => {
    const m = new Map()
    for (const s of snapshots) {
      if (!m.has(s.member_id)) m.set(s.member_id, [])
      m.get(s.member_id).push(s)
    }
    return m
  }, [snapshots])

  // ── Compute per-member row (identity + per-stat deltas / daily averages) ──
  const memberRows = useMemo(() => {
    const window = TIME_WINDOWS.find(w => w.id === timeWindow) ?? TIME_WINDOWS[2]
    const rows = members.map(m =>
      buildMemberRow(m, snapshotsByMember.get(String(m.member_id)) ?? [], window.days)
    )
    // Projected onto the same bsp_* names the War Room uses, so the shared cell
    // and the shared sort read one shape rather than two (#353).
    return canSeeBattleStats ? withBattleStats(rows, battleStats) : rows
  }, [members, snapshotsByMember, timeWindow, battleStats, canSeeBattleStats])

  // ── Resolve active threshold set ──
  const activeThresholds = useMemo(() => {
    if (activeThresholdId == null) return null
    return thresholdSets.find(t => t.id === activeThresholdId) ?? null
  }, [activeThresholdId, thresholdSets])

  // ── Annotate rows with threshold failures + inconclusive (amber) flags ──
  const rowsWithFlags = useMemo(() =>
    memberRows.map(r => ({ ...r, ...classifyRow(r, activeThresholds?.thresholds ?? null) })),
    [memberRows, activeThresholds])

  // ── Compliance summary (flagged vs inconclusive are separate buckets) ──
  const compliance = useMemo(() => summarizeCompliance(rowsWithFlags), [rowsWithFlags])

  // ── Filtered rows ──
  const filteredRows = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return rowsWithFlags.filter(r => {
      if (needle && !(r.member_name ?? '').toLowerCase().includes(needle)) return false
      if (donatorFilter === 'yes' && r.is_donator !== true)  return false
      if (donatorFilter === 'no'  && r.is_donator !== false) return false
      if (piFilter === 'yes' && r.property_name !== PI_NAME) return false
      if (piFilter === 'no'  && (r.property_name == null || r.property_name === PI_NAME)) return false
      if (activeFilter === 'active'   && isInactive(r.last_action_timestamp)) return false
      if (activeFilter === 'inactive' && !isInactive(r.last_action_timestamp)) return false
      if (minTenure !== '' && Number.isFinite(Number(minTenure))) {
        // A member with unknown total days can't clear a tenure floor.
        if (r.total_days_in_faction == null || r.total_days_in_faction < Number(minTenure)) return false
      }
      if (canSeeBattleStats) {
        if (!matchesStatRange(r.bsp_total ?? null, statsMin, statsMax)) return false
        if (!matchesStatsSource(r, statsSource)) return false
      }
      if (showWarningsOnly && r.compliance_status !== 'flagged') return false
      if (showInconclusiveOnly && r.compliance_status !== 'inconclusive') return false
      return true
    })
  }, [rowsWithFlags, search, donatorFilter, piFilter, activeFilter, minTenure, showWarningsOnly,
      showInconclusiveOnly, canSeeBattleStats, statsMin, statsMax, statsSource])

  // ── Resolve active view → ordered list of column ids ──
  const allViews = useMemo(() => [...BUILT_IN_VIEWS, ...savedViews], [savedViews])
  const activeView = useMemo(() => {
    return allViews.find(v => v.id === activeViewId) ?? BUILT_IN_VIEWS[0]
  }, [activeViewId, allViews])
  const isBuiltinView = !!activeView.builtin

  // A saved view can name a column the current role may not see — views are
  // shared, and the person who built one may outrank the person opening it.
  // Filtering here rather than at each render site means there is one place
  // that decides, and no path that renders an empty battle-stats column.
  const visibleColumns = useMemo(
    () => activeView.columns.filter(c => c !== 'battle_stats' || canSeeBattleStats),
    [activeView, canSeeBattleStats]
  )

  // ── Sort ──
  const sortedRows = useMemo(() => {
    const col = resolveColumn(sortCol)
    if (!col) return filteredRows
    const dir = sortDir === 'asc' ? 1 : -1
    return [...filteredRows].sort((a, b) => {
      const va = col.sortValue(a)
      const vb = col.sortValue(b)
      if (va == null && vb == null) return 0
      if (va == null) return 1
      if (vb == null) return -1
      if (typeof va === 'string' && typeof vb === 'string') return dir * va.localeCompare(vb)
      return dir * ((va > vb) - (va < vb))
    })
  }, [filteredRows, sortCol, sortDir])

  // ── Handlers ──
  const handleSort = (colId) => {
    if (sortCol === colId) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(colId); setSortDir('asc') }
  }

  const openNewView = () => { setViewModalMode('new'); setViewModalOpen(true) }
  const openEditView = () => { setViewModalMode('edit'); setViewModalOpen(true) }

  const handleSaveNewView = useCallback(async (name, columns) => {
    const created = await createSavedView({ name, columns, user }, user.apiKey)
    setSavedViews(prev => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)))
    setActiveViewId(created.id)
  }, [user])

  const handleUpdateView = useCallback(async (name, columns) => {
    if (isBuiltinView) return
    const updated = await updateSavedView(activeView.id, { name, columns }, user.apiKey)
    setSavedViews(prev =>
      prev.map(v => v.id === updated.id ? updated : v)
          .sort((a, b) => a.name.localeCompare(b.name))
    )
  }, [activeView.id, isBuiltinView, user.apiKey])

  const handleDeleteView = useCallback(async () => {
    if (isBuiltinView) return
    await deleteSavedView(activeView.id, user.apiKey)
    setSavedViews(prev => prev.filter(v => v.id !== activeView.id))
    setActiveViewId('default')
  }, [activeView.id, isBuiltinView, user.apiKey])

  const openNewThreshold = () => { setThresholdModalMode('new'); setThresholdModalOpen(true) }
  const openEditThreshold = () => { setThresholdModalMode('edit'); setThresholdModalOpen(true) }

  const handleSaveNewThreshold = useCallback(async (name, thresholds) => {
    const created = await createThresholdSet({ name, thresholds, user }, user.apiKey)
    setThresholdSets(prev => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)))
    setActiveThresholdId(created.id)
  }, [user])

  const handleUpdateThreshold = useCallback(async (name, thresholds) => {
    if (!activeThresholds) return
    const updated = await updateThresholdSet(activeThresholds.id, { name, thresholds }, user.apiKey)
    setThresholdSets(prev =>
      prev.map(t => t.id === updated.id ? updated : t)
          .sort((a, b) => a.name.localeCompare(b.name))
    )
  }, [activeThresholds, user.apiKey])

  const handleDeleteThreshold = useCallback(async () => {
    if (!activeThresholds) return
    await deleteThresholdSet(activeThresholds.id, user.apiKey)
    setThresholdSets(prev => prev.filter(t => t.id !== activeThresholds.id))
    setActiveThresholdId(null)
  }, [activeThresholds, user.apiKey])

  // ── Render ──
  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        <span className="ml-3 text-gray-600 dark:text-gray-400">Loading member overview…</span>
      </div>
    )
  }
  if (error) {
    return (
      <div className="card border-red-300 dark:border-red-700">
        <p className="text-sm text-red-600 dark:text-red-400">Failed to load: {error}</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="card space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-xl font-bold text-gray-900 dark:text-white">Member Overview</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {compliance.total} members · {sortedRows.length} shown · daily averages over {timeWindow === 'all' ? 'all available data' : timeWindow}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setShowWarningsOnly(v => !v); setShowInconclusiveOnly(false) }}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                showWarningsOnly
                  ? 'bg-red-600 text-white'
                  : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/30'
              }`}
              title="Show only members failing one or more requirements"
            >
              ⚠ {compliance.flagged} / {compliance.total} flagged
              {showWarningsOnly ? ' · showing' : ''}
            </button>
            <button
              onClick={() => { setShowInconclusiveOnly(v => !v); setShowWarningsOnly(false) }}
              disabled={compliance.inconclusive === 0}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 ${
                showInconclusiveOnly
                  ? 'bg-amber-500 text-white'
                  : 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/30'
              }`}
              title="Show only members we can't fully assess (missing data)"
            >
              🟡 {compliance.inconclusive} inconclusive
              {showInconclusiveOnly ? ' · showing' : ''}
            </button>
          </div>
        </div>

        {/* View row */}
        <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-gray-200 dark:border-slate-700">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400 mr-1">View:</span>
            {allViews.map(v => (
              <button
                key={v.id}
                onClick={() => setActiveViewId(v.id)}
                className={`px-2.5 py-1 text-xs rounded-full font-medium transition-colors ${
                  activeViewId === v.id
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-slate-600'
                }`}
                title={v.builtin ? 'Built-in view' : `Saved by ${v.created_by_name ?? 'leadership'}`}
              >
                {v.name}
              </button>
            ))}
            {!isBuiltinView && (
              <button
                onClick={openEditView}
                className="px-2.5 py-1 text-xs rounded-full font-medium bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-slate-600"
                title="Edit this view's columns"
              >
                ✎ Edit
              </button>
            )}
            <button
              onClick={openNewView}
              className="px-2.5 py-1 text-xs rounded-full font-medium bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-slate-600"
              title="Create a new view by picking stats"
            >
              + New view
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400 mr-1">Window:</span>
            {TIME_WINDOWS.map(w => (
              <button
                key={w.id}
                onClick={() => setTimeWindow(w.id)}
                className={`px-2.5 py-1 text-xs rounded-full font-medium transition-colors ${
                  timeWindow === w.id
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-slate-600'
                }`}
              >
                {w.label}
              </button>
            ))}
          </div>
        </div>

        {/* Threshold row */}
        <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-gray-200 dark:border-slate-700">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400 mr-1">Thresholds:</span>
            <button
              onClick={() => setActiveThresholdId(null)}
              className={`px-2.5 py-1 text-xs rounded-full font-medium transition-colors ${
                activeThresholdId == null
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-slate-600'
              }`}
            >
              None
            </button>
            {thresholdSets.map(t => (
              <button
                key={t.id}
                onClick={() => setActiveThresholdId(t.id)}
                className={`px-2.5 py-1 text-xs rounded-full font-medium transition-colors ${
                  activeThresholdId === t.id
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-slate-600'
                }`}
                title={`Saved by ${t.created_by_name ?? 'leadership'}`}
              >
                {t.name}
              </button>
            ))}
            {activeThresholds && (
              <button
                onClick={openEditThreshold}
                className="px-2.5 py-1 text-xs rounded-full font-medium bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-slate-600"
                title="Edit this threshold set"
              >
                ✎ Edit
              </button>
            )}
            <button
              onClick={openNewThreshold}
              className="px-2.5 py-1 text-xs rounded-full font-medium bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-slate-600"
              title="Create a new threshold set"
            >
              + New set
            </button>
            {activeThresholds && (
              <span className="ml-2 text-xs text-red-600 dark:text-red-400">
                {compliance.thresholdFail} below threshold
              </span>
            )}
          </div>
        </div>

        {/* Filters row */}
        <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-gray-200 dark:border-slate-700">
          <input
            type="text"
            placeholder="Search name…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-56 px-3 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <FilterTri label="Donator"  value={donatorFilter} onChange={setDonatorFilter} yesLabel="Yes" noLabel="No" />
          <FilterTri label="PI"       value={piFilter}      onChange={setPiFilter}      yesLabel="Yes" noLabel="No" />
          <FilterTri label="Active"   value={activeFilter}  onChange={setActiveFilter}  yesLabel="Active" noLabel="Inactive" />
          <div className="flex items-center gap-1">
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Tenure ≥</span>
            <input
              type="number" min="0" placeholder="days"
              value={minTenure}
              onChange={e => setMinTenure(e.target.value)}
              className="w-20 px-2 py-1 text-sm border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          {canSeeBattleStats && (
            <>
              <div className="flex items-center gap-1">
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Stats</span>
                {/* Same k/m/b shorthand as the War Room — one parser, so the
                    two pages cannot read "2.6b" differently (#355). */}
                <input
                  type="text" placeholder="min" title="e.g. 3m, 2.6b"
                  value={statsMin}
                  onChange={e => setStatsMin(e.target.value)}
                  className="w-16 px-2 py-1 text-sm border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <span className="text-xs text-gray-400">–</span>
                <input
                  type="text" placeholder="max" title="e.g. 3m, 2.6b"
                  value={statsMax}
                  onChange={e => setStatsMax(e.target.value)}
                  className="w-16 px-2 py-1 text-sm border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div className="flex items-center gap-1">
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Source</span>
                {/* "BSP only" is the list of members to chase for a key. */}
                <select
                  value={statsSource}
                  onChange={e => setStatsSource(e.target.value)}
                  className="px-2 py-1 text-sm border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="any">Any</option>
                  <option value="torn">OWN (exact)</option>
                  <option value="tornstats">TS (spy)</option>
                  <option value="bsp">BSP (estimate)</option>
                  <option value="none">No reading</option>
                </select>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="card p-0 overflow-hidden">
        <div className="overflow-auto max-h-[70vh]">
          <table className="w-full text-sm border-separate border-spacing-0">
            <thead>
              <tr className="text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                {visibleColumns.map(colId => {
                  const col = resolveColumn(colId)
                  if (!col) return null
                  const active = sortCol === colId
                  return (
                    <th
                      key={colId}
                      onClick={() => handleSort(colId)}
                      className="py-2.5 px-3 sticky top-0 bg-gray-50 dark:bg-slate-800 border-b border-gray-200 dark:border-slate-700 cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-slate-700 whitespace-nowrap"
                    >
                      <span className="flex items-center gap-1">
                        {col.label}
                        <span className={`text-xs ${active ? 'text-blue-500' : 'text-gray-300 dark:text-gray-600'}`}>
                          {active ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
                        </span>
                      </span>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {sortedRows.length === 0 && (
                <tr>
                  <td colSpan={visibleColumns.length} className="py-12 text-center text-gray-400 dark:text-gray-600 text-sm">
                    No members match the current filters.
                  </td>
                </tr>
              )}
              {sortedRows.map((r, idx) => {
                const baseBg = idx % 2 === 0
                  ? 'bg-white dark:bg-slate-900'
                  : 'bg-gray-50/50 dark:bg-slate-800/40'
                const rowClass = r.compliance_status === 'flagged'
                  ? 'bg-red-50 dark:bg-red-900/15'
                  : r.compliance_status === 'inconclusive'
                    ? 'bg-amber-50/60 dark:bg-amber-900/10'
                    : r.data_partial
                      ? `${baseBg} ring-1 ring-amber-200 dark:ring-amber-900/40`
                      : baseBg
                return (
                  <tr key={r.member_id} className={rowClass}>
                    {visibleColumns.map(colId => {
                      const col = resolveColumn(colId)
                      if (!col) return null
                      // Compliance-driven flag (identity columns)
                      let flag = col.compliance ? col.compliance(r) : null
                      // Threshold-driven flags (stat columns): red = below the
                      // bar, amber = thresholded but no data to assess.
                      if (r.threshold_failures && r.threshold_failures.has(colId)) flag = 'red'
                      else if (r.threshold_inconclusive && r.threshold_inconclusive.has(colId)) flag = 'yellow'
                      return (
                        <td
                          key={colId}
                          className={`py-2.5 px-3 whitespace-nowrap text-gray-700 dark:text-gray-300 ${complianceClass(flag)}`}
                        >
                          {col.render(r, timeWindow)}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-2 border-t border-gray-200 dark:border-slate-700 text-xs text-gray-400 dark:text-gray-500 flex items-center gap-4 flex-wrap">
          <span>Showing {sortedRows.length} of {compliance.total} members</span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full bg-amber-400" />
            partial data
          </span>
          {activeThresholds && (
            <span className="inline-flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-full bg-red-500" />
              below threshold
            </span>
          )}
          <span className="inline-flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full bg-amber-500" />
            inconclusive (missing data)
          </span>
        </div>
      </div>

      {/* Modals */}
      <StatPickerModal
        open={viewModalOpen}
        onClose={() => setViewModalOpen(false)}
        initialName={viewModalMode === 'edit' ? activeView.name : ''}
        initialSelection={viewModalMode === 'edit' ? activeView.columns : activeView.columns}
        identityColumns={canSeeBattleStats
          ? IDENTITY_COLUMNS_FOR_MODAL
          : IDENTITY_COLUMNS_FOR_MODAL.filter(c => c.key !== 'battle_stats')}
        canSaveAsNew={true}
        canUpdate={viewModalMode === 'edit' && !isBuiltinView}
        canDelete={viewModalMode === 'edit' && !isBuiltinView}
        onSaveNew={handleSaveNewView}
        onUpdate={handleUpdateView}
        onDelete={handleDeleteView}
      />
      <ThresholdModal
        open={thresholdModalOpen}
        onClose={() => setThresholdModalOpen(false)}
        initialName={thresholdModalMode === 'edit' && activeThresholds ? activeThresholds.name : ''}
        initialThresholds={thresholdModalMode === 'edit' && activeThresholds ? activeThresholds.thresholds : {}}
        canSaveAsNew={true}
        canUpdate={thresholdModalMode === 'edit' && !!activeThresholds}
        canDelete={thresholdModalMode === 'edit' && !!activeThresholds}
        onSaveNew={handleSaveNewThreshold}
        onUpdate={handleUpdateThreshold}
        onDelete={handleDeleteThreshold}
      />
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function formatRelativeTime(unixTs) {
  if (!unixTs) return '—'
  const diff = Math.floor(Date.now() / 1000) - unixTs
  if (diff < 60)         return 'just now'
  if (diff < 3_600)      return `${Math.floor(diff / 60)}m ago`
  if (diff < 86_400)     return `${Math.floor(diff / 3_600)}h ago`
  return `${Math.floor(diff / 86_400)}d ago`
}

function complianceClass(flag) {
  if (flag === 'red')    return 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300'
  if (flag === 'yellow') return 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300'
  if (flag === 'green')  return 'bg-green-50/40 dark:bg-green-900/10 text-green-700 dark:text-green-300'
  return ''
}

// Resolve a column id to an object with `label`, `sortValue`, `render`, optional `compliance`.
// Stat columns are synthesised on demand from STAT_PATHS_BY_KEY.
function resolveColumn(colId) {
  if (IDENTITY_COLUMNS[colId]) return IDENTITY_COLUMNS[colId]
  const def = STAT_PATHS_BY_KEY[colId]
  if (!def) return null
  const showDailyDivider = !def.noPerDay
  const sortKey = showDailyDivider ? colId + '_perday' : colId + '_current'
  return {
    label: def.label,
    sortValue: r => r[sortKey] ?? -Infinity,
    render: r => {
      const cur    = r[colId + '_current']
      const delta  = r[colId + '_delta']
      const perDay = r[colId + '_perday']
      if (def.noPerDay) {
        if (cur == null) return <span className="text-gray-400">—</span>
        return <span className="font-mono">{formatNumber(cur, def)}</span>
      }
      if (perDay == null) return <span className="text-gray-400">—</span>
      return (
        <span className="font-mono">
          {formatNumber(perDay, def)}
          {delta != null && r.days_covered > 0 && (
            <span className="ml-1.5 text-xs text-gray-400 dark:text-gray-500">
              ({formatNumber(delta, def)} in {r.days_covered}d)
            </span>
          )}
        </span>
      )
    },
  }
}

function formatNumber(n, def) {
  if (n == null) return '—'
  if (def.isCurrency) return formatCurrency(Math.round(n))
  return n.toLocaleString(undefined, { maximumFractionDigits: 1 })
}

// ────────────────────────────────────────────────────────────────────────────
// Small UI bits
// ────────────────────────────────────────────────────────────────────────────

function FilterTri({ label, value, onChange, yesLabel, noLabel }) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-xs font-medium text-gray-500 dark:text-gray-400">{label}:</span>
      {['any', 'yes', 'no'].map(opt => (
        <button
          key={opt}
          onClick={() => onChange(opt)}
          className={`px-2.5 py-1 text-xs rounded-full font-medium transition-colors ${
            value === opt
              ? 'bg-blue-600 text-white'
              : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-slate-600'
          }`}
        >
          {opt === 'any' ? 'Any' : opt === 'yes' ? yesLabel : noLabel}
        </button>
      ))}
    </div>
  )
}
