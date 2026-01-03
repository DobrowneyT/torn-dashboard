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

export default function CrimesView({ crimesData }) {
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
      const { data, error } = await supabase
        .from('crimes')
        .select('*')
        .order('executed_at', { ascending: false, nullsFirst: false })
      
      if (error) throw error
      
      // Convert to same format as JSON for compatibility
      const crimesMap = {}
      data.forEach(crime => {
        crimesMap[crime.crime_id] = crime
      })
      
      setDbCrimes({ crimes: crimesMap })
    } catch (err) {
      console.error('Error loading crimes from database:', err)
      setDbCrimes(null)
    } finally {
      setLoadingDb(false)
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
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
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
        <div className="flex flex-wrap gap-4 items-center">
          <div>
            <label className="block text-sm font-medium mb-2">Filter by Status:</label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="input min-w-[200px]"
            >
              {CRIME_STATUS_OPTIONS.map(option => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          
          <div className="ml-auto flex gap-2 items-center">
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
            <div className="text-sm text-gray-500 dark:text-gray-400">
              State persisted
            </div>
          </div>
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
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b-2 border-gray-200 dark:border-slate-700">
              <tr className="text-left">
                <th 
                  className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700"
                  onClick={() => handleSort('id')}
                >
                  Crime ID <SortIcon columnKey="id" />
                </th>
                <th 
                  className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700"
                  onClick={() => handleSort('name')}
                >
                  Name <SortIcon columnKey="name" />
                </th>
                <th 
                  className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700"
                  onClick={() => handleSort('difficulty')}
                >
                  Difficulty <SortIcon columnKey="difficulty" />
                </th>
                <th 
                  className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700"
                  onClick={() => handleSort('status')}
                >
                  Status <SortIcon columnKey="status" />
                </th>
                <th 
                  className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700"
                  onClick={() => handleSort('filled_slots')}
                >
                  Slots <SortIcon columnKey="filled_slots" />
                </th>
                <th 
                  className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700"
                  onClick={() => handleSort('executed_at')}
                >
                  Executed At <SortIcon columnKey="executed_at" />
                </th>
                <th className="py-2 px-2 font-semibold text-xs">
                  Rewards
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredCrimes.length === 0 ? (
                <tr>
                  <td colSpan="7" className="py-8 text-center text-gray-500">
                    No crimes found matching the current filter.
                  </td>
                </tr>
              ) : (
                filteredCrimes.map((crime) => (
                  <tr 
                    key={crime.id} 
                    className="border-b border-gray-200 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-700/50"
                  >
                    <td className="py-2 px-2 font-medium text-xs">
                      {crime.id || crime.crime_id}
                    </td>
                    <td className="py-2 px-2 text-xs">
                      {crime.name}
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