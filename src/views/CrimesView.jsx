import { useState, useEffect, useMemo } from 'react'
import { useViewState } from '../contexts/ViewStateContext'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../utils/supabase'
import { syncCrimesFromAPI, getSyncStatusMessage } from '../utils/syncCrimesFromAPI'
import { RefreshCw } from 'lucide-react'
import { 
  getCrimeStatusLabel, 
  getCrimeStatusColor, 
  CrimeStatusBadge,
  CRIME_STATUS_OPTIONS
} from '../utils/crimeStatusUtils'
import { config } from '../config'

export default function CrimesView({ crimesData, isLeadership }) {
  const { user } = useAuth()
  const [persistedState, setPersistedState] = useViewState('crimes')
  
  const [statusFilter, setStatusFilter] = useState(persistedState.statusFilter || 'all')
  const [sortConfig, setSortConfig] = useState(
    persistedState.sortConfig || { key: 'executed_at', direction: 'desc' }
  )
  
  // Sync state
  const [syncing, setSyncing] = useState(false)
  const [syncMessage, setSyncMessage] = useState(null)
  const [syncError, setSyncError] = useState(null)

  // Database crimes (overrides JSON if available)
  const [dbCrimes, setDbCrimes] = useState(null)
  const [loadingDb, setLoadingDb] = useState(true)

  // Participant detail popover
  const [selectedCrimeId, setSelectedCrimeId] = useState(null)
  const [crimeSlots, setCrimeSlots] = useState([])
  const [loadingSlots, setLoadingSlots] = useState(false)

  useEffect(() => {
    setPersistedState({ statusFilter, sortConfig })
  }, [statusFilter, sortConfig, setPersistedState])

  // Load crimes from database
  useEffect(() => {
    loadCrimesFromDatabase()
  }, [])

  async function loadCrimesFromDatabase() {
    try {
      setLoadingDb(true)

      // Paginate to load all crimes (Supabase default limit is 1000)
      const crimesMap = {}
      const pageSize = 1000
      let offset = 0
      let hasMore = true

      while (hasMore) {
        const { data, error } = await supabase
          .from('crimes')
          .select('*')
          .order('created_at', { ascending: false, nullsFirst: false })
          .range(offset, offset + pageSize - 1)

        if (error) throw error

        for (const crime of data) {
          crimesMap[crime.crime_id] = crime
        }

        hasMore = data.length === pageSize
        offset += pageSize
      }

      setDbCrimes({ crimes: crimesMap })
    } catch (err) {
      console.error('Error loading crimes from database:', err)
      setDbCrimes(null)
    } finally {
      setLoadingDb(false)
    }
  }

  async function handleToggleCrimeDetails(crimeId) {
    if (selectedCrimeId === crimeId) {
      setSelectedCrimeId(null)
      setCrimeSlots([])
      return
    }

    setSelectedCrimeId(crimeId)
    setLoadingSlots(true)

    try {
      const { data, error } = await supabase
        .from('crime_slots')
        .select('user_id, user_name, position, position_number, checkpoint_pass_rate')
        .eq('crime_id', crimeId)
        .not('user_id', 'is', null)

      if (error) throw error

      // Look up missing names from members table
      const slots = data || []
      const missingNameIds = slots.filter(s => !s.user_name).map(s => s.user_id)
      if (missingNameIds.length > 0) {
        const { data: members } = await supabase
          .from('members')
          .select('member_id, member_name')
          .in('member_id', missingNameIds)
        const nameMap = Object.fromEntries((members || []).map(m => [m.member_id, m.member_name]))
        slots.forEach(s => {
          if (!s.user_name && nameMap[s.user_id]) {
            s.user_name = nameMap[s.user_id]
          }
        })
      }
      setCrimeSlots(slots)
    } catch (err) {
      console.error('Error loading crime slots:', err)
      setCrimeSlots([])
    } finally {
      setLoadingSlots(false)
    }
  }

  async function handleSyncWithAPI() {
    try {
      setSyncing(true)
      setSyncMessage(null)
      setSyncError(null)
      
      const apiKey = user.apiKey || import.meta.env.VITE_TORN_API_KEY
      const factionId = config.faction.id
      
      if (!apiKey) {
        throw new Error('No API key available')
      }
      
      const result = await syncCrimesFromAPI(apiKey, factionId)
      
      if (result.success) {
        setSyncMessage(getSyncStatusMessage(result))
        // Reload crimes from database
        await loadCrimesFromDatabase()
        // Auto-dismiss success message
        setTimeout(() => setSyncMessage(null), 5000)
      } else {
        setSyncError(result.error)
        setTimeout(() => setSyncError(null), 10000)
      }
      
    } catch (err) {
      setSyncError(err.message)
      setTimeout(() => setSyncError(null), 10000)
    } finally {
      setSyncing(false)
    }
  }

  // Use database crimes if available, otherwise fall back to JSON prop
  const activeCrimesData = dbCrimes || crimesData

  const filteredCrimes = useMemo(() => {
    if (!activeCrimesData?.crimes) return []

    let crimes = Object.entries(activeCrimesData.crimes).map(([id, crime]) => ({
      id,
      ...crime
    }))

    if (statusFilter !== 'all') {
      crimes = crimes.filter(crime => {
        const normalizedStatus = getCrimeStatusLabel(crime.status)
        return normalizedStatus === statusFilter
      })
    }

    crimes.sort((a, b) => {
      let aVal = a[sortConfig.key]
      let bVal = b[sortConfig.key]

      if (aVal < bVal) {
        return sortConfig.direction === 'asc' ? -1 : 1
      }
      if (aVal > bVal) {
        return sortConfig.direction === 'asc' ? 1 : -1
      }
      return 0
    })

    return crimes
  }, [activeCrimesData, statusFilter, sortConfig])

  const statusCounts = useMemo(() => {
    if (!activeCrimesData?.crimes) return {}

    const counts = {
      'Success': 0,
      'Planning': 0,
      'Recruiting': 0,
      'Failed': 0,
      'total': 0
    }

    Object.values(activeCrimesData.crimes).forEach(crime => {
      const normalizedStatus = getCrimeStatusLabel(crime.status)
      if (counts[normalizedStatus] !== undefined) {
        counts[normalizedStatus]++
      }
      counts.total++
    })

    return counts
  }, [activeCrimesData])

  const handleSort = (key) => {
    let direction = 'desc'
    if (sortConfig.key === key && sortConfig.direction === 'desc') {
      direction = 'asc'
    }
    setSortConfig({ key, direction })
  }

  const SortIcon = ({ columnKey }) => {
    if (sortConfig.key !== columnKey) {
      return <span className="ml-1 text-gray-400">⇅</span>
    }
    return (
      <span className="ml-1">
        {sortConfig.direction === 'asc' ? '↑' : '↓'}
      </span>
    )
  }

  const formatTimestamp = (timestamp) => {
    if (!timestamp) return 'N/A'
    return new Date(timestamp * 1000).toLocaleString()
  }

  if (loadingDb && !crimesData) {
    return (
      <div className="card">
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mr-3"></div>
          <p className="text-gray-600 dark:text-gray-400">Loading crimes...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <CurrentCrimesPanel apiKey={user?.apiKey} memberId={user?.id} />

      <div className="card">
        <div className="flex flex-col sm:flex-row sm:items-end gap-3">
          <div className="flex-1">
            <label className="block text-sm font-medium mb-2">Filter by Status:</label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="input w-full sm:w-auto sm:min-w-[200px]"
            >
              {CRIME_STATUS_OPTIONS.map(option => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          {isLeadership && (
            <div className="flex gap-2 items-center sm:ml-auto">
              <button
                onClick={handleSyncWithAPI}
                disabled={syncing}
                className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {syncing ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                    Fetching…
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-4 h-4" />
                    Fetch Crimes
                  </>
                )}
              </button>
            </div>
          )}
        </div>
        
        {syncMessage && (
          <div className="mt-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-3">
            <p className="text-sm text-green-600 dark:text-green-400">{syncMessage}</p>
          </div>
        )}
        
        {syncError && (
          <div className="mt-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3">
            <p className="text-sm text-red-600 dark:text-red-400">{syncError}</p>
          </div>
        )}
      </div>

      <div className="card">
        <h2 className="text-xl font-semibold mb-4">Crimes List</h2>
        <div className="overflow-auto max-h-[70vh] relative">
          <table className="w-full text-sm border-separate border-spacing-0">
            <thead>
              <tr className="text-left">
                <th
                  className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700 sticky top-0 left-0 z-30 bg-white dark:bg-slate-800 border-b-2 border-gray-200 dark:border-slate-700"
                  onClick={() => handleSort('name')}
                >
                  Name <SortIcon columnKey="name" />
                </th>
                <th
                  className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700 sticky top-0 z-20 bg-white dark:bg-slate-800 border-b-2 border-gray-200 dark:border-slate-700"
                  onClick={() => handleSort('id')}
                >
                  Crime ID <SortIcon columnKey="id" />
                </th>
                <th
                  className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700 sticky top-0 z-20 bg-white dark:bg-slate-800 border-b-2 border-gray-200 dark:border-slate-700"
                  onClick={() => handleSort('difficulty')}
                >
                  Difficulty <SortIcon columnKey="difficulty" />
                </th>
                <th
                  className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700 sticky top-0 z-20 bg-white dark:bg-slate-800 border-b-2 border-gray-200 dark:border-slate-700"
                  onClick={() => handleSort('status')}
                >
                  Status <SortIcon columnKey="status" />
                </th>
                <th
                  className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700 sticky top-0 z-20 bg-white dark:bg-slate-800 border-b-2 border-gray-200 dark:border-slate-700"
                  onClick={() => handleSort('filled_slots')}
                >
                  Slots <SortIcon columnKey="filled_slots" />
                </th>
                <th
                  className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700 sticky top-0 z-20 bg-white dark:bg-slate-800 border-b-2 border-gray-200 dark:border-slate-700"
                  onClick={() => handleSort('executed_at')}
                >
                  Executed At <SortIcon columnKey="executed_at" />
                </th>
                <th className="py-2 px-2 font-semibold text-xs sticky top-0 z-20 bg-white dark:bg-slate-800 border-b-2 border-gray-200 dark:border-slate-700">
                  Rewards
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredCrimes.length === 0 ? (
                <tr>
                  <td colSpan="7" className="py-8 text-center text-gray-500 dark:text-gray-400">
                    No crimes found matching the current filter.
                  </td>
                </tr>
              ) : (
                filteredCrimes.map((crime) => (
                  <tr
                    key={crime.id}
                    className="border-b border-gray-200 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-700/50"
                  >
                    <td className="py-2 px-2 text-xs relative sticky left-0 z-[5] bg-white dark:bg-slate-800">
                      <button
                        onClick={() => handleToggleCrimeDetails(crime.id || crime.crime_id)}
                        className="text-blue-600 dark:text-blue-400 hover:underline cursor-pointer text-left"
                      >
                        {crime.name}
                      </button>
                      {selectedCrimeId === (crime.id || crime.crime_id) && (
                        <div className="absolute z-50 left-0 top-full mt-1 bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-600 rounded-lg shadow-lg p-3 w-[280px] sm:w-[360px] max-w-[calc(100vw-2rem)]">
                          <div className="flex items-center justify-between mb-2">
                            <h5 className="font-semibold text-xs">Participants</h5>
                            <button
                              onClick={(e) => { e.stopPropagation(); setSelectedCrimeId(null) }}
                              className="text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 text-xs"
                            >
                              ✕
                            </button>
                          </div>
                          {loadingSlots ? (
                            <div className="text-xs text-gray-500 dark:text-gray-400 py-2">Loading...</div>
                          ) : crimeSlots.length === 0 ? (
                            <div className="text-xs text-gray-500 dark:text-gray-400 py-2">No participant data</div>
                          ) : (
                            <div className="space-y-1">
                              {crimeSlots.map((slot, idx) => {
                                const posLabel = slot.position_number
                                  ? `${slot.position} ${slot.position_number}`
                                  : slot.position
                                return (
                                  <div key={idx} className="text-xs flex justify-between items-center py-0.5">
                                    <span className="text-gray-700 dark:text-gray-300">
                                      {slot.user_name || 'Unknown'} [{slot.user_id}] — {posLabel}
                                    </span>
                                    <span className="text-gray-500 dark:text-gray-400 ml-2 whitespace-nowrap">
                                      CPR: {Math.round(slot.checkpoint_pass_rate || 0)}
                                    </span>
                                  </div>
                                )
                              })}
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="py-2 px-2 font-medium text-xs">
                      {crime.id || crime.crime_id}
                    </td>
                    <td className="py-2 px-2 text-xs">
                      <DifficultyBadge difficulty={crime.difficulty} />
                    </td>
                    <td className="py-2 px-2 text-xs">
                      <CrimeStatusBadge status={crime.status} />
                    </td>
                    <td className="py-2 px-2 text-xs">
                      {crime.filled_slots}/{crime.total_slots}
                    </td>
                    <td className="py-2 px-2 text-xs text-gray-600 dark:text-gray-400">
                      {formatTimestamp(crime.executed_at)}
                    </td>
                    <td className="py-2 px-2 text-xs">
                      {crime.rewards_money || crime.rewards?.money ? (
                        <span className="text-green-600 dark:text-green-400">
                          ${(crime.rewards_money || crime.rewards?.money || 0).toLocaleString()}
                        </span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {filteredCrimes.length > 0 && (
          <div className="mt-4 text-sm text-gray-600 dark:text-gray-400">
            Showing {filteredCrimes.length} of {statusCounts.total} crimes
            {dbCrimes && (
              <span className="ml-2 text-blue-600 dark:text-blue-400">
                (Live from database)
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function DifficultyBadge({ difficulty }) {
  const colors = {
    1: 'bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-400',
    2: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
    3: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
    4: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400',
    5: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400',
    6: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
    7: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400',
    8: 'bg-pink-100 text-pink-800 dark:bg-pink-900/30 dark:text-pink-400',
    9: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-400',
    10: 'bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-400',
  }

  const colorClass = colors[difficulty] || colors[1]

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${colorClass}`}>
      Level {difficulty}
    </span>
  )
}

// ── Current Crimes (live) ───────────────────────────────────────────────────
// Pulls the faction's available crimes straight from the Torn API (cat=available)
// so members can see what's open, how long until a recruiting crime stalls, and
// which crimes are still empty — plus their own CPR for each open slot.
function formatCountdown(secs) {
  if (secs == null) return '—'
  const a = Math.abs(secs)
  const d = Math.floor(a / 86400)
  const h = Math.floor((a % 86400) / 3600)
  const m = Math.floor((a % 3600) / 60)
  const s = a % 60
  const pad = (n) => String(n).padStart(2, '0')
  return `${d > 0 ? d + 'd ' : ''}${pad(h)}:${pad(m)}:${pad(s)}`
}

function CurrentCrimesPanel({ apiKey, memberId }) {
  const [crimes, setCrimes] = useState(null)
  const [myCpr, setMyCpr] = useState({})
  const [memberNames, setMemberNames] = useState({})   // member_id → name (slots give id only)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [, setTick] = useState(0)

  // Tick once a second so the countdowns stay live.
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [])

  // Member id → name lookup (the crimes API only returns slot user IDs).
  useEffect(() => {
    let cancelled = false
    supabase.from('members').select('member_id, member_name')
      .then(({ data }) => {
        if (cancelled) return
        const map = {}
        for (const m of (data || [])) map[String(m.member_id)] = m.member_name
        setMemberNames(map)
      })
    return () => { cancelled = true }
  }, [])

  // The viewer's own CPR per crime/position, to show their fit on open slots.
  useEffect(() => {
    if (!memberId) return
    let cancelled = false
    supabase.from('member_cpr_v2').select('crime_name, position_label, cpr_value').eq('member_id', String(memberId))
      .then(({ data }) => {
        if (cancelled) return
        const map = {}
        for (const r of (data || [])) map[`${r.crime_name}||${r.position_label}`] = r.cpr_value
        setMyCpr(map)
      })
    return () => { cancelled = true }
  }, [memberId])

  useEffect(() => {
    if (!apiKey) { setError('Log in with an API key to see current crimes.'); setLoading(false); return }
    let cancelled = false
    setLoading(true); setError(null)
    fetch(`https://api.torn.com/v2/faction/crimes?cat=available&sort=ASC&key=${apiKey}&comment=Forge_OC_Current`)
      .then(r => r.json())
      .then(data => {
        if (cancelled) return
        if (data.error) { setError(data.error.error || 'Torn API error'); setCrimes([]) }
        else setCrimes(data.crimes || [])
      })
      .catch(e => { if (!cancelled) { setError(e.message); setCrimes([]) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [apiKey])

  const now = Math.floor(Date.now() / 1000)

  const groups = useMemo(() => {
    const g = { recruiting: [], empty: [], planning: [] }
    for (const c of (crimes || [])) {
      if (c.status === 'Planning') g.planning.push(c)
      else if (c.status === 'Recruiting') (c.planning_at == null ? g.empty : g.recruiting).push(c)
    }
    g.recruiting.sort((a, b) => (a.ready_at || 0) - (b.ready_at || 0))
    g.empty.sort((a, b) => (a.expired_at || 0) - (b.expired_at || 0))
    g.planning.sort((a, b) => (a.ready_at || 0) - (b.ready_at || 0))
    return g
  }, [crimes])

  // At-a-glance actionables: open slots to fill, and who frees up (OCs executing) within 24h.
  // A member is only ever in one OC, so each person appears at most once in `freeing`.
  const summary = useMemo(() => {
    const all = crimes || []
    const horizon = Math.floor(Date.now() / 1000) + 86400
    let openSpots = 0
    const freeing = []
    for (const c of all) {
      for (const s of (c.slots || [])) if (!s.user) openSpots++
      if (c.status === 'Planning' && c.ready_at && c.ready_at <= horizon) {
        for (const s of (c.slots || [])) {
          if (s.user) freeing.push({
            id: String(s.user.id),
            crimeId: c.id,
            crimeName: c.name,
            position: s.position_info?.label || s.position,
            readyAt: c.ready_at,
          })
        }
      }
    }
    freeing.sort((a, b) => (a.readyAt || 0) - (b.readyAt || 0))
    const crimesFreeing = new Set(freeing.map(f => f.crimeId)).size
    return { openSpots, freeing, crimesFreeing, totalCrimes: all.length }
  }, [crimes])

  // Deep-link straight to a crime on the faction OC tab.
  const crimeUrl = (id) => `https://www.torn.com/factions.php?step=your&type=12#/tab=crimes&crimeId=${id}`

  // Colour a box green/amber/red by a CPR vs its requirement (default 75 when unconfigured).
  const fitClass = (cpr, req) => {
    if (cpr == null) return 'border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800'  // no CPR data
    if (cpr >= req) return 'border-emerald-400 dark:border-emerald-600 bg-emerald-50 dark:bg-emerald-900/20'
    if (req - cpr <= 5) return 'border-amber-400 dark:border-amber-600 bg-amber-50 dark:bg-amber-900/20'
    return 'border-2 border-red-400 dark:border-red-600 bg-red-50 dark:bg-red-900/20'
  }

  // One slot as a two-line cell: position on top; occupant + CPR (or your fit) below.
  // colorFilled = colour filled slots by the occupant's CPR (Planning); otherwise they stay gray.
  function SlotCell({ crimeName, crimeId, slot, colorFilled }) {
    const label = slot.position_info?.label || slot.position
    const req = config.cprRequirements?.[crimeName]?.positions?.[label] ?? 75

    if (slot.user) {
      const name = memberNames[String(slot.user.id)] || `#${slot.user.id}`
      const cpr = slot.checkpoint_pass_rate
      const cls = colorFilled
        ? fitClass(cpr, req)
        : 'border-gray-200 dark:border-slate-600 bg-gray-100 dark:bg-slate-700'
      return (
        <div className={`flex flex-col px-2 py-1 rounded border text-xs min-w-[7rem] ${cls}`}>
          <span className="font-medium text-gray-700 dark:text-gray-300 truncate">{label}</span>
          <span className="text-gray-600 dark:text-gray-400 truncate">
            {name}{cpr != null ? ` · ${Math.round(cpr)}` : ''}
          </span>
        </div>
      )
    }

    // Open — colour by the viewer's CPR; the whole box links to the crime to join.
    const mine = myCpr[`${crimeName}||${label}`]
    return (
      <a href={crimeUrl(crimeId)} target="_blank" rel="noreferrer"
        className={`flex flex-col px-2 py-1 rounded border text-xs min-w-[7rem] transition hover:brightness-95 ${fitClass(mine, req)}`}>
        <span className="font-medium text-gray-700 dark:text-gray-300 truncate">{label}</span>
        <span className="text-gray-500 dark:text-gray-400 truncate">
          EMPTY{mine != null ? ` · you ${Math.round(mine)}` : ''} / {req}
        </span>
      </a>
    )
  }

  function CrimeRow({ c, timerTs, timerLabel, pausedLabel, colorFilled }) {
    const filled = c.slots.filter(s => s.user).length
    const overdue = timerTs != null && timerTs <= now
    return (
      <div className="flex flex-col gap-2 p-3 rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <DifficultyBadge difficulty={c.difficulty} />
            <a href={crimeUrl(c.id)} target="_blank" rel="noreferrer"
              className="font-medium text-blue-600 dark:text-blue-400 hover:underline">{c.name}</a>
            <span className="text-xs text-gray-500 dark:text-gray-400">{filled}/{c.slots.length} filled</span>
          </div>
          <span className={`font-mono text-sm ${overdue ? 'text-red-600 dark:text-red-400 font-semibold' : 'text-gray-700 dark:text-gray-300'}`}>
            {overdue ? `⏸ ${pausedLabel}` : `${timerLabel} ${formatCountdown(timerTs - now)}`}
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {c.slots.map((s, i) => <SlotCell key={i} crimeName={c.name} crimeId={c.id} slot={s} colorFilled={colorFilled} />)}
        </div>
      </div>
    )
  }

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-lg font-bold text-gray-900 dark:text-white">Current Crimes</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400">Live from Torn — who's freeing up, where the open spots are, and join deadlines.</p>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 py-4">
          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600" /> Loading current crimes…
        </div>
      ) : error ? (
        <p className="text-sm text-amber-600 dark:text-amber-400 py-2">{error}</p>
      ) : (crimes && crimes.length === 0) ? (
        <p className="text-sm text-gray-500 dark:text-gray-400 py-2">No recruiting or planning crimes right now.</p>
      ) : (
        <div className="space-y-4">
          {/* At-a-glance: open spots to fill + who's coming out in the next 24h */}
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-3 py-2">
              <div className="text-xs text-amber-700 dark:text-amber-300">Open spots to fill</div>
              <div className="text-2xl font-bold text-amber-700 dark:text-amber-300">{summary.openSpots}</div>
              <div className="text-[11px] text-amber-600/80 dark:text-amber-400/80">across {summary.totalCrimes} active {summary.totalCrimes === 1 ? 'crime' : 'crimes'}</div>
            </div>
            <div className="rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/20 px-3 py-2">
              <div className="text-xs text-emerald-700 dark:text-emerald-300">Coming out in 24h</div>
              <div className="text-2xl font-bold text-emerald-700 dark:text-emerald-300">{summary.freeing.length}</div>
              <div className="text-[11px] text-emerald-600/80 dark:text-emerald-400/80">from {summary.crimesFreeing} executing {summary.crimesFreeing === 1 ? 'crime' : 'crimes'}</div>
            </div>
          </div>

          {summary.freeing.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-1.5">
                Freeing up — soonest first
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {summary.freeing.map((f, i) => {
                  const secs = f.readyAt - now
                  const ready = secs <= 0
                  return (
                    <a key={i} href={crimeUrl(f.crimeId)} target="_blank" rel="noreferrer"
                      title={`${f.crimeName} — ${f.position}`}
                      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 hover:brightness-95">
                      <span className="font-medium text-gray-700 dark:text-gray-300">{memberNames[f.id] || `#${f.id}`}</span>
                      <span className={`font-mono ${ready ? 'text-emerald-600 dark:text-emerald-400 font-semibold' : 'text-gray-500 dark:text-gray-400'}`}>
                        {ready ? 'ready' : formatCountdown(secs)}
                      </span>
                    </a>
                  )
                })}
              </div>
            </div>
          )}

          {groups.empty.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400 mb-1.5">
                Empty — needs a starter ({groups.empty.length})
              </h3>
              <div className="space-y-1.5">
                {groups.empty.map(c => (
                  <CrimeRow key={c.id} c={c} timerTs={c.expired_at} timerLabel="Expires in" pausedLabel="Expired" colorFilled={false} />
                ))}
              </div>
            </div>
          )}
          {groups.recruiting.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400 mb-1.5">
                Recruiting — has open slots ({groups.recruiting.length})
              </h3>
              <div className="space-y-1.5">
                {groups.recruiting.map(c => (
                  <CrimeRow key={c.id} c={c} timerTs={c.ready_at} timerLabel="Pauses in" pausedLabel="Stalled — needs a member" colorFilled={false} />
                ))}
              </div>
            </div>
          )}
          {groups.planning.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-blue-600 dark:text-blue-400 mb-1.5">
                In Planning — full ({groups.planning.length})
              </h3>
              <div className="space-y-1.5">
                {groups.planning.map(c => (
                  <CrimeRow key={c.id} c={c} timerTs={c.ready_at} timerLabel="Ready in" pausedLabel="Ready" colorFilled={true} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}