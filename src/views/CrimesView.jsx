import { useState, useEffect, useMemo } from 'react'
import { useViewState } from '../contexts/ViewStateContext'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../utils/supabase'
import { syncCrimesFromAPI, getSyncStatusMessage } from '../utils/syncCrimesFromAPI'
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
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-4">
        <div className="card">
          <div className="text-sm text-gray-600 dark:text-gray-400">Total Crimes</div>
          <div className="text-2xl font-bold">{statusCounts.total || 0}</div>
        </div>
        
        <div className="card border-l-4 border-green-500">
          <div className="text-sm text-gray-600 dark:text-gray-400">Success</div>
          <div className="text-2xl font-bold text-green-600">{statusCounts.Success || 0}</div>
        </div>
        
        <div className="card border-l-4 border-blue-500">
          <div className="text-sm text-gray-600 dark:text-gray-400">Planning</div>
          <div className="text-2xl font-bold text-blue-600">{statusCounts.Planning || 0}</div>
        </div>
        
        <div className="card border-l-4 border-yellow-500">
          <div className="text-sm text-gray-600 dark:text-gray-400">Recruiting</div>
          <div className="text-2xl font-bold text-yellow-600">{statusCounts.Recruiting || 0}</div>
        </div>
        
        <div className="card border-l-4 border-red-500">
          <div className="text-sm text-gray-600 dark:text-gray-400">Failed</div>
          <div className="text-2xl font-bold text-red-600">{statusCounts.Failed || 0}</div>
        </div>
      </div>

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
                className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {syncing ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                    Syncing...
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    Sync with Torn API
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