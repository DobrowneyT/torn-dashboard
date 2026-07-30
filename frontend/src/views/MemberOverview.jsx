import { useEffect, useMemo, useState, useCallback } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { apiGet } from '../utils/apiClient'
import {
  STAT_PATHS, STAT_PATHS_BY_KEY, getByPath,
} from '../utils/statPaths'
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

const ACTIVE_THRESHOLD_HOURS = 48       // > this → flagged inactive
const PI_NAME = 'Private Island'        // exact property name we require

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
  const { user } = useAuth()

  // ── Data ──
  const [snapshots, setSnapshots] = useState([])
  const [members, setMembers]     = useState([])
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
  const [sortCol, setSortCol]                 = useState('name')
  const [sortDir, setSortDir]                 = useState('asc')
  const [showWarningsOnly, setShowWarningsOnly] = useState(false)

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
        const [snapshotsResp, membersResp, viewsResp, threshResp] = await Promise.all([
          apiGet(`/api/overview/daily-stats?window=all`),
          apiGet('/api/members'),
          fetchSavedViews().catch(e => { console.warn('saved views fetch failed', e); return [] }),
          fetchThresholdSets().catch(e => { console.warn('threshold sets fetch failed', e); return [] }),
        ])
        if (cancelled) return
        setSnapshots(snapshotsResp.snapshots ?? [])
        setMembers(membersResp.members ?? [])
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
    return members.map(m => {
      const snaps = snapshotsByMember.get(String(m.member_id)) ?? []
      const newest = snaps[0]
      const oldest = pickOldestInWindow(snaps, window.days)
      const haveTwoSnaps = newest && oldest && newest !== oldest
      const daysCovered = haveTwoSnaps
        ? daysBetween(oldest.snapshot_date, newest.snapshot_date)
        : 0

      // A row is "data complete" if we have a delta over the full requested
      // window. The "All" window is always complete by definition.
      const dataComplete = window.days == null
        ? haveTwoSnaps
        : daysCovered >= window.days
      const dataPartial = !dataComplete && haveTwoSnaps
      const dataMissing = !haveTwoSnaps
      const dataPartialReason = dataMissing
        ? 'Only one snapshot — need at least two days of data to compute a delta.'
        : dataPartial
          ? `Only ${daysCovered}d of ${window.days}d of data.`
          : null

      const row = {
        member_id: m.member_id,
        member_name: m.member_name,
        tier: m.tier,
        level: getByPath(newest?.profile, 'level'),
        last_action_timestamp: newest?.last_action_timestamp ?? getByPath(newest?.profile, 'last_action.timestamp'),
        is_donator: newest?.is_donator,
        donator_label: getByPath(newest?.profile, 'donator_status'),
        property_name: newest?.property_name,
        snapshot_count: snaps.length,
        days_covered: daysCovered,
        data_complete: dataComplete,
        data_partial: !dataComplete,
        data_partial_reason: dataPartialReason,
      }

      // Per-stat deltas. We divide by daysCovered (which pickOldestInWindow
      // already caps at window.days), never by raw window length, so a 4-day
      // delta on a 7-day window correctly reports the daily rate over 4 days.
      const newestPs = newest?.personalstats
      const oldestPs = oldest?.personalstats
      for (const def of STAT_PATHS) {
        let cur = getByPath(newestPs, def.path)
        let old = oldestPs ? getByPath(oldestPs, def.path) : null
        if (def.isSeconds) {
          if (cur != null) cur = cur / 3600
          if (old != null) old = old / 3600
        }
        const delta = (cur != null && old != null && haveTwoSnaps) ? cur - old : null
        const perDay = (delta != null && daysCovered > 0) ? delta / daysCovered : null
        row[def.key + '_current'] = cur
        row[def.key + '_delta']   = delta
        row[def.key + '_perday']  = perDay
      }

      // Gym energy: same delta-or-nothing rule (no cumulative fallback).
      const gymEnergyNew = newest?.gym_energy
      const gymEnergyOld = oldest?.gym_energy
      const gymDelta = (gymEnergyNew != null && gymEnergyOld != null && haveTwoSnaps)
        ? gymEnergyNew - gymEnergyOld
        : null
      row.gym_energy        = gymEnergyNew
      row.gym_energy_delta  = gymDelta
      row.gym_energy_perday = (gymDelta != null && daysCovered > 0) ? gymDelta / daysCovered : null

      return row
    })
  }, [members, snapshotsByMember, timeWindow])

  // ── Resolve active threshold set ──
  const activeThresholds = useMemo(() => {
    if (activeThresholdId == null) return null
    return thresholdSets.find(t => t.id === activeThresholdId) ?? null
  }, [activeThresholdId, thresholdSets])

  // ── Annotate rows with threshold failures ──
  const rowsWithFlags = useMemo(() => {
    if (!activeThresholds) {
      return memberRows.map(r => ({ ...r, threshold_failures: null }))
    }
    return memberRows.map(r => {
      const failures = new Set()
      for (const [statKey, min] of Object.entries(activeThresholds.thresholds)) {
        if (min == null || !Number.isFinite(Number(min))) continue
        const value = (statKey === 'gym_energy')
          ? r.gym_energy_perday
          : r[statKey + '_perday']
        if (value == null) continue  // no data — don't flag
        if (value < Number(min)) failures.add(statKey)
      }
      return { ...r, threshold_failures: failures.size > 0 ? failures : null }
    })
  }, [memberRows, activeThresholds])

  // ── Compliance summary ──
  const compliance = useMemo(() => {
    let inactive = 0, nonDonator = 0, nonPI = 0, warning = 0, thresholdFail = 0
    for (const r of rowsWithFlags) {
      let hasIssue = false
      if (isInactive(r.last_action_timestamp))            { inactive++;      hasIssue = true }
      if (r.is_donator === false)                          { nonDonator++;    hasIssue = true }
      if (r.property_name && r.property_name !== PI_NAME)  { nonPI++;         hasIssue = true }
      if (r.threshold_failures && r.threshold_failures.size > 0) { thresholdFail++; hasIssue = true }
      if (hasIssue) warning++
    }
    return { total: rowsWithFlags.length, warning, inactive, nonDonator, nonPI, thresholdFail }
  }, [rowsWithFlags])

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
      if (showWarningsOnly) {
        const hasWarning =
             isInactive(r.last_action_timestamp)
          || r.is_donator === false
          || (r.property_name && r.property_name !== PI_NAME)
          || (r.threshold_failures && r.threshold_failures.size > 0)
        if (!hasWarning) return false
      }
      return true
    })
  }, [rowsWithFlags, search, donatorFilter, piFilter, activeFilter, showWarningsOnly])

  // ── Resolve active view → ordered list of column ids ──
  const allViews = useMemo(() => [...BUILT_IN_VIEWS, ...savedViews], [savedViews])
  const activeView = useMemo(() => {
    return allViews.find(v => v.id === activeViewId) ?? BUILT_IN_VIEWS[0]
  }, [activeViewId, allViews])
  const isBuiltinView = !!activeView.builtin

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
          <button
            onClick={() => setShowWarningsOnly(v => !v)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              showWarningsOnly
                ? 'bg-red-600 text-white'
                : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/30'
            }`}
            title="Toggle filter to only show members failing one or more requirements"
          >
            ⚠ {compliance.warning} / {compliance.total} flagged
            {showWarningsOnly ? ' · showing' : ' · click to filter'}
          </button>
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
        </div>
      </div>

      {/* Table */}
      <div className="card p-0 overflow-hidden">
        <div className="overflow-auto max-h-[70vh]">
          <table className="w-full text-sm border-separate border-spacing-0">
            <thead>
              <tr className="text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                {activeView.columns.map(colId => {
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
                  <td colSpan={activeView.columns.length} className="py-12 text-center text-gray-400 dark:text-gray-600 text-sm">
                    No members match the current filters.
                  </td>
                </tr>
              )}
              {sortedRows.map((r, idx) => {
                const rowFails = r.threshold_failures && r.threshold_failures.size > 0
                const baseBg = idx % 2 === 0
                  ? 'bg-white dark:bg-slate-900'
                  : 'bg-gray-50/50 dark:bg-slate-800/40'
                const rowClass = rowFails
                  ? 'bg-red-50 dark:bg-red-900/15'
                  : r.data_partial
                    ? `${baseBg} ring-1 ring-amber-200 dark:ring-amber-900/40`
                    : baseBg
                return (
                  <tr key={r.member_id} className={rowClass}>
                    {activeView.columns.map(colId => {
                      const col = resolveColumn(colId)
                      if (!col) return null
                      // Compliance-driven flag (identity columns)
                      let flag = col.compliance ? col.compliance(r) : null
                      // Threshold-driven flag (stat columns)
                      if (r.threshold_failures && r.threshold_failures.has(colId)) flag = 'red'
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
        </div>
      </div>

      {/* Modals */}
      <StatPickerModal
        open={viewModalOpen}
        onClose={() => setViewModalOpen(false)}
        initialName={viewModalMode === 'edit' ? activeView.name : ''}
        initialSelection={viewModalMode === 'edit' ? activeView.columns : activeView.columns}
        identityColumns={IDENTITY_COLUMNS_FOR_MODAL}
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

function pickOldestInWindow(snapshots, days) {
  if (!snapshots || snapshots.length === 0) return null
  if (snapshots.length === 1) return snapshots[0]
  if (days == null) return snapshots[snapshots.length - 1]
  // snapshots are newest-first. Pick the newest one whose date is <= target.
  const target = new Date()
  target.setDate(target.getDate() - days)
  const targetStr = target.toISOString().slice(0, 10)
  for (const s of snapshots) {
    if (s.snapshot_date <= targetStr) return s
  }
  return snapshots[snapshots.length - 1]
}

function daysBetween(olderDate, newerDate) {
  const a = new Date(olderDate)
  const b = new Date(newerDate)
  return Math.max(1, Math.round((b - a) / 86_400_000))
}

function isInactive(unixTs) {
  if (!unixTs) return false
  const ageHours = (Date.now() / 1000 - unixTs) / 3600
  return ageHours > ACTIVE_THRESHOLD_HOURS
}

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
