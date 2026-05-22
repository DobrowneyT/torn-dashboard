import { useEffect, useMemo, useState, useCallback } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../utils/supabase'
import { STAT_PATHS, getByPath } from '../utils/statPaths'
import { formatCurrency } from '../utils/payoutCalculations'

// ────────────────────────────────────────────────────────────────────────────
// Constants & built-in views
// ────────────────────────────────────────────────────────────────────────────

const SNAPSHOT_DAYS = 30                // how much history we pull at once
const ACTIVE_THRESHOLD_HOURS = 48       // > this → flagged inactive
const PI_NAME = 'Private Island'        // exact property name we require

const TIME_WINDOWS = [
  { id: '1d',  label: '1d',  days: 1 },
  { id: '7d',  label: '7d',  days: 7 },
  { id: '30d', label: '30d', days: 30 },
  { id: 'all', label: 'All', days: null },
]

// Built-in presets. Each `columns` entry is either an identity column id
// or a STAT_PATHS key. Always available; not stored in localStorage.
const BUILT_IN_VIEWS = [
  {
    id: 'default',
    name: 'Default',
    columns: ['name', 'level', 'last_active', 'donator', 'property', 'attackswon', 'rankedwarhits'],
  },
  {
    id: 'war',
    name: 'War',
    columns: ['name', 'rankedwarhits', 'rankedwarwins', 'attackswon', 'defendswon', 'respectforfaction', 'networth'],
  },
  {
    id: 'oc',
    name: 'OC',
    columns: ['name', 'organizedcrimes', 'criminaloffenses', 'timeplayed'],
  },
  {
    id: 'activity',
    name: 'Activity',
    columns: ['name', 'last_active', 'timeplayed', 'refills', 'nerverefills', 'gym_energy'],
  },
]

// ────────────────────────────────────────────────────────────────────────────
// Identity columns (not in STAT_PATHS — pulled from members + profile + gym cols)
// ────────────────────────────────────────────────────────────────────────────

const IDENTITY_COLUMNS = {
  name: {
    label: 'Name',
    sortValue: r => r.member_name?.toLowerCase() ?? '',
    render: r => (
      <span>
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
    label: 'Lv',
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
    sortValue: r => r.gym_energy_perday ?? 0,
    render: r => r.gym_energy_perday != null ? Math.round(r.gym_energy_perday).toLocaleString() : '—',
  },
}

// ────────────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────────────

export default function MemberOverview() {
  const { user } = useAuth()

  // ── Data ──
  const [snapshots, setSnapshots] = useState([])
  const [members, setMembers] = useState([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState(null)

  // ── UI state ──
  const [timeWindow, setTimeWindow] = useState('30d')
  const [activeViewId, setActiveViewId] = useState('default')
  const [search, setSearch] = useState('')
  const [donatorFilter, setDonatorFilter] = useState('any')   // any | yes | no
  const [piFilter, setPiFilter] = useState('any')             // any | yes | no
  const [activeFilter, setActiveFilter] = useState('any')     // any | active | inactive
  const [sortCol, setSortCol] = useState('name')
  const [sortDir, setSortDir] = useState('asc')
  const [showWarningsOnly, setShowWarningsOnly] = useState(false)
  const [savedViews, setSavedViews] = useState([])

  // ── Load saved views (localStorage, per user) ──
  const savedViewsKey = useMemo(() => user?.id ? `mem_overview_views:${user.id}` : null, [user?.id])
  useEffect(() => {
    if (!savedViewsKey) return
    try {
      const raw = localStorage.getItem(savedViewsKey)
      setSavedViews(raw ? JSON.parse(raw) : [])
    } catch { setSavedViews([]) }
  }, [savedViewsKey])

  // ── Load data ──
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        setLoading(true)
        const since = new Date(Date.now() - (SNAPSHOT_DAYS + 1) * 24 * 60 * 60 * 1000)
          .toISOString().slice(0, 10)
        const [snapsResp, membersResp] = await Promise.all([
          supabase
            .from('member_daily_stats')
            .select('member_id, snapshot_date, personalstats, profile, is_donator, property_name, last_action_timestamp, gym_strength, gym_speed, gym_dexterity, gym_defense, gym_energy')
            .gte('snapshot_date', since)
            .order('member_id', { ascending: true })
            .order('snapshot_date', { ascending: false }),
          supabase
            .from('members')
            .select('member_id, member_name, tier')
            .eq('is_current', true),
        ])
        if (cancelled) return
        if (snapsResp.error) throw snapsResp.error
        if (membersResp.error) throw membersResp.error
        setSnapshots(snapsResp.data ?? [])
        setMembers(membersResp.data ?? [])
        setLoading(false)
      } catch (e) {
        if (!cancelled) { setError(e.message); setLoading(false) }
      }
    })()
    return () => { cancelled = true }
  }, [])

  // ── Group snapshots by member ──
  const snapshotsByMember = useMemo(() => {
    const m = new Map()
    for (const s of snapshots) {
      if (!m.has(s.member_id)) m.set(s.member_id, [])
      m.get(s.member_id).push(s)
    }
    // Each list is already newest-first thanks to the SQL order
    return m
  }, [snapshots])

  // ── Compute per-member row (identity + per-stat per-day averages) ──
  const memberRows = useMemo(() => {
    const window = TIME_WINDOWS.find(w => w.id === timeWindow) ?? TIME_WINDOWS[2]
    return members.map(m => {
      const snaps = snapshotsByMember.get(String(m.member_id)) ?? []
      const newest = snaps[0]
      const oldest = pickOldestInWindow(snaps, window.days)
      const daysCovered = (newest && oldest && newest !== oldest)
        ? daysBetween(oldest.snapshot_date, newest.snapshot_date)
        : 0

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
      }

      // Stat per-day deltas
      const newestPs = newest?.personalstats
      const oldestPs = oldest?.personalstats
      for (const def of STAT_PATHS) {
        let cur = getByPath(newestPs, def.path)
        let old = oldestPs ? getByPath(oldestPs, def.path) : null
        if (def.isSeconds) {
          if (cur != null) cur = cur / 3600
          if (old != null) old = old / 3600
        }
        const delta = (cur != null && old != null) ? cur - old : null
        const perDay = delta != null
          ? (daysCovered > 0 ? delta / daysCovered : delta)
          : null
        row[def.key + '_current'] = cur
        row[def.key + '_delta']   = delta
        row[def.key + '_perday']  = perDay
      }

      // Gym energy per day
      const gymEnergyNew = newest?.gym_energy
      const gymEnergyOld = oldest?.gym_energy
      row.gym_energy = gymEnergyNew
      row.gym_energy_perday = (gymEnergyNew != null && gymEnergyOld != null && daysCovered > 0)
        ? (gymEnergyNew - gymEnergyOld) / daysCovered
        : (gymEnergyNew != null ? gymEnergyNew : null)

      return row
    })
  }, [members, snapshotsByMember, timeWindow])

  // ── Compliance summary across the whole faction ──
  const compliance = useMemo(() => {
    let inactive = 0, nonDonator = 0, nonPI = 0, warning = 0
    for (const r of memberRows) {
      let hasIssue = false
      if (isInactive(r.last_action_timestamp)) { inactive++;    hasIssue = true }
      if (r.is_donator === false)              { nonDonator++;  hasIssue = true }
      if (r.property_name && r.property_name !== PI_NAME) { nonPI++; hasIssue = true }
      if (hasIssue) warning++
    }
    return { total: memberRows.length, warning, inactive, nonDonator, nonPI }
  }, [memberRows])

  // ── Filtered rows ──
  const filteredRows = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return memberRows.filter(r => {
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
        if (!hasWarning) return false
      }
      return true
    })
  }, [memberRows, search, donatorFilter, piFilter, activeFilter, showWarningsOnly])

  // ── Resolve active view → ordered list of column ids ──
  const activeView = useMemo(() => {
    const all = [...BUILT_IN_VIEWS, ...savedViews]
    return all.find(v => v.id === activeViewId) ?? BUILT_IN_VIEWS[0]
  }, [activeViewId, savedViews])

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

  const handleSaveView = useCallback(() => {
    const name = prompt('Name this view:')
    if (!name || !savedViewsKey) return
    const newView = {
      id: `custom-${Date.now()}`,
      name: name.trim(),
      columns: activeView.columns,
    }
    const next = [...savedViews, newView]
    setSavedViews(next)
    localStorage.setItem(savedViewsKey, JSON.stringify(next))
    setActiveViewId(newView.id)
  }, [savedViews, savedViewsKey, activeView.columns])

  const handleDeleteView = useCallback((viewId) => {
    if (!savedViewsKey) return
    if (!confirm('Delete this saved view?')) return
    const next = savedViews.filter(v => v.id !== viewId)
    setSavedViews(next)
    localStorage.setItem(savedViewsKey, JSON.stringify(next))
    if (activeViewId === viewId) setActiveViewId('default')
  }, [savedViews, savedViewsKey, activeViewId])

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

  const allViews = [...BUILT_IN_VIEWS, ...savedViews]
  const isCustomView = activeView.id.startsWith('custom-')

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="card space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-xl font-bold text-gray-900 dark:text-white">Member Overview</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {compliance.total} members · {sortedRows.length} shown · {timeWindow === '1d' ? 'snapshot delta' : `per-day avg over ${timeWindow}`}
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

        {/* View + time window */}
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
              >
                {v.name}
              </button>
            ))}
            <button
              onClick={handleSaveView}
              className="px-2.5 py-1 text-xs rounded-full font-medium bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-slate-600"
              title="Save the active column set as a new view"
            >
              + Save as
            </button>
            {isCustomView && (
              <button
                onClick={() => handleDeleteView(activeView.id)}
                className="px-2 py-1 text-xs text-red-600 dark:text-red-400 hover:underline"
                title="Delete this saved view"
              >
                Delete view
              </button>
            )}
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
                      className="py-2.5 px-3 sticky top-0 bg-gray-50 dark:bg-slate-800/80 border-b border-gray-200 dark:border-slate-700 cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-slate-700/60 whitespace-nowrap"
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
              {sortedRows.map((r, idx) => (
                <tr key={r.member_id} className={idx % 2 === 0 ? 'bg-white dark:bg-slate-900' : 'bg-gray-50/50 dark:bg-slate-800/40'}>
                  {activeView.columns.map(colId => {
                    const col = resolveColumn(colId)
                    if (!col) return null
                    const flag = col.compliance ? col.compliance(r) : null
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
              ))}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-2 border-t border-gray-200 dark:border-slate-700 text-xs text-gray-400 dark:text-gray-500">
          Showing {sortedRows.length} of {compliance.total} members
        </div>
      </div>
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
  // snapshots are newest-first. Pick the one closest to `days` ago.
  const target = new Date()
  target.setDate(target.getDate() - days)
  const targetStr = target.toISOString().slice(0, 10)
  // Find the newest snapshot whose date is <= target. Fall back to oldest available.
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
  if (!unixTs) return false  // unknown — don't flag
  const ageHours = (Date.now() / 1000 - unixTs) / 3600
  return ageHours > ACTIVE_THRESHOLD_HOURS
}

function formatRelativeTime(unixTs) {
  if (!unixTs) return '—'
  const diff = Math.floor(Date.now() / 1000) - unixTs
  if (diff < 60)         return 'just now'
  if (diff < 3_600)      return `${Math.floor(diff / 60)}m ago`
  if (diff < 86_400)     return `${Math.floor(diff / 3_600)}h ago`
  if (diff < 86_400 * 7) return `${Math.floor(diff / 86_400)}d ago`
  return `${Math.floor(diff / 86_400)}d ago`
}

function complianceClass(flag) {
  if (flag === 'red')    return 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300'
  if (flag === 'yellow') return 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300'
  if (flag === 'green')  return 'bg-green-50/40 dark:bg-green-900/10 text-green-700 dark:text-green-300'
  return ''
}

// Resolve a column id to an object with `label`, `sortValue`, `render`, optional `compliance`.
// Stat columns are synthesised on demand from STAT_PATHS.
function resolveColumn(colId) {
  if (IDENTITY_COLUMNS[colId]) return IDENTITY_COLUMNS[colId]
  const def = STAT_PATHS.find(s => s.key === colId)
  if (!def) return null
  return {
    label: def.label,
    sortValue: r => r[colId + '_perday'] ?? 0,
    render: r => {
      const perDay = r[colId + '_perday']
      const delta  = r[colId + '_delta']
      if (perDay == null) return <span className="text-gray-400">—</span>
      const fmt = (n) =>
        def.isCurrency
          ? formatCurrency(Math.round(n))
          : n.toLocaleString(undefined, { maximumFractionDigits: 1 })
      return (
        <span className="font-mono">
          {fmt(perDay)}
          {delta != null && r.days_covered > 0 && (
            <span className="ml-1.5 text-xs text-gray-400 dark:text-gray-500">
              ({fmt(delta)})
            </span>
          )}
        </span>
      )
    },
  }
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
