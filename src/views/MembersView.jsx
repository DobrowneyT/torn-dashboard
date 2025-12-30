import { useState, useEffect, useMemo } from 'react'
import { useViewState } from '../contexts/ViewStateContext'

export default function MembersView({ cprData, crimesData }) {
  // Get persisted state
  const [persistedState, setPersistedState] = useViewState('members')
  
  // Initialize from persisted state or defaults
  const [searchTerm, setSearchTerm] = useState(persistedState.searchTerm || '')
  const [tierFilter, setTierFilter] = useState(persistedState.tierFilter || 'all')
  const [sortConfig, setSortConfig] = useState(
    persistedState.sortConfig || { key: 'tier', direction: 'asc' }
  )
  const [currentFactionMembers, setCurrentFactionMembers] = useState(null)
  const [loading, setLoading] = useState(true)

  // Persist state changes - setPersistedState is now stable, no need to include it
  useEffect(() => {
    setPersistedState({
      searchTerm,
      tierFilter,
      sortConfig
    })
  }, [searchTerm, tierFilter, sortConfig])

  // Fetch current faction members from Torn API
  useEffect(() => {
    async function fetchFactionMembers() {
      try {
        setLoading(true)
        const factionId = import.meta.env.VITE_FACTION_ID || '46427'
        const apiKey = import.meta.env.VITE_TORN_API_KEY || ''
        
        if (!apiKey) {
          console.warn('No Torn API key configured, showing all members')
          setCurrentFactionMembers(null)
          setLoading(false)
          return
        }

        const response = await fetch(
          `https://api.torn.com/faction/${factionId}?selections=basic&key=${apiKey}`
        )
        
        if (response.ok) {
          const data = await response.json()
          const memberIds = new Set(Object.keys(data.members || {}).map(id => id.toString()))
          setCurrentFactionMembers(memberIds)
        } else {
          console.error('Failed to fetch faction members')
          setCurrentFactionMembers(null)
        }
      } catch (error) {
        console.error('Error fetching faction members:', error)
        setCurrentFactionMembers(null)
      } finally {
        setLoading(false)
      }
    }

    fetchFactionMembers()
  }, [])

  const members = useMemo(() => {
    if (!cprData?.members) return []
    
    let filtered = Object.entries(cprData.members).map(([id, data]) => ({
      id,
      ...data,
      avgCpr: calculateAvgCpr(data),
      totalCrimes: calculateTotalCrimes(id, crimesData)
    }))

    // Filter to only current faction members if we have that data
    if (currentFactionMembers) {
      filtered = filtered.filter(m => currentFactionMembers.has(m.id.toString()))
    }

    if (searchTerm) {
      filtered = filtered.filter(m => 
        m.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        m.id.toString().includes(searchTerm)
      )
    }
    
    if (tierFilter !== 'all') {
      filtered = filtered.filter(m => m.tier === parseInt(tierFilter))
    }
    
    // Apply sorting
    return filtered.sort((a, b) => {
      let aVal = a[sortConfig.key]
      let bVal = b[sortConfig.key]
      
      // Handle special cases
      if (sortConfig.key === 'name') {
        aVal = (aVal || '').toLowerCase()
        bVal = (bVal || '').toLowerCase()
      } else if (sortConfig.key === 'id') {
        // Parse IDs as integers for proper numeric sorting
        aVal = parseInt(aVal) || 0
        bVal = parseInt(bVal) || 0
      } else if (sortConfig.key === 'avgCpr') {
        aVal = aVal === 'N/A' ? -1 : parseFloat(aVal)
        bVal = bVal === 'N/A' ? -1 : parseFloat(bVal)
      } else if (sortConfig.key === 'tier') {
        aVal = aVal || 6
        bVal = bVal || 6
      }
      
      if (aVal < bVal) {
        return sortConfig.direction === 'asc' ? -1 : 1
      }
      if (aVal > bVal) {
        return sortConfig.direction === 'asc' ? 1 : -1
      }
      return 0
    })
  }, [cprData, crimesData, searchTerm, tierFilter, currentFactionMembers, sortConfig])

  const handleSort = (key) => {
    let direction = 'asc'
    if (sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc'
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

  if (loading) {
    return (
      <div className="card">
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mr-3"></div>
          <p className="text-gray-600 dark:text-gray-400">Loading faction members...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="card">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-6">
        <div>
          <h2 className="text-xl font-semibold">Member Performance by Tier</h2>
          {currentFactionMembers && (
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
              Showing {members.length} current faction members
            </p>
          )}
          {!currentFactionMembers && (
            <p className="text-sm text-yellow-600 dark:text-yellow-400 mt-1">
              ⚠ Showing all members (configure VITE_TORN_API_KEY to filter current faction)
            </p>
          )}
        </div>
        <div className="flex gap-2 items-center">
          <input
            type="text"
            placeholder="Search members..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="input flex-1 md:w-64"
          />
          <select 
            value={tierFilter} 
            onChange={(e) => setTierFilter(e.target.value)} 
            className="input"
          >
            <option value="all">All Tiers</option>
            {[1,2,3,4,5,6].map(t => <option key={t} value={t}>Tier {t}</option>)}
          </select>
          <div className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
            💾 Persisted
          </div>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="border-b-2 border-gray-200 dark:border-slate-700">
            <tr className="text-left">
              <th 
                className="py-3 px-4 font-semibold text-sm cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700"
                onClick={() => handleSort('name')}
              >
                Member <SortIcon columnKey="name" />
              </th>
              <th 
                className="py-3 px-4 font-semibold text-sm cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700"
                onClick={() => handleSort('id')}
              >
                ID <SortIcon columnKey="id" />
              </th>
              <th 
                className="py-3 px-4 font-semibold text-sm cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700"
                onClick={() => handleSort('tier')}
              >
                Tier <SortIcon columnKey="tier" />
              </th>
              <th 
                className="py-3 px-4 font-semibold text-sm cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700"
                onClick={() => handleSort('totalCrimes')}
              >
                Crimes <SortIcon columnKey="totalCrimes" />
              </th>
              <th 
                className="py-3 px-4 font-semibold text-sm cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700"
                onClick={() => handleSort('avgCpr')}
              >
                Avg CPR <SortIcon columnKey="avgCpr" />
              </th>
              <th className="py-3 px-4 font-semibold text-sm">Top Roles</th>
            </tr>
          </thead>
          <tbody>
            {members.length === 0 ? (
              <tr><td colSpan="6" className="py-8 text-center text-gray-500">No members found</td></tr>
            ) : (
              members.map(m => (
                <tr key={m.id} className="border-b border-gray-200 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-700/50">
                  <td className="py-3 px-4 font-medium">{m.name || `Member ${m.id}`}</td>
                  <td className="py-3 px-4 text-sm text-gray-600 dark:text-gray-400">{m.id}</td>
                  <td className="py-3 px-4"><TierBadge tier={m.tier || 6} /></td>
                  <td className="py-3 px-4">{m.totalCrimes}</td>
                  <td className="py-3 px-4">{m.avgCpr}</td>
                  <td className="py-3 px-4 text-sm text-gray-600 dark:text-gray-400">{getTopRoles(m)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function TierBadge({ tier }) {
  const colors = {1:'bg-tier-1',2:'bg-tier-2',3:'bg-tier-3',4:'bg-tier-4',5:'bg-tier-5',6:'bg-tier-6'}
  return <span className={`inline-block px-3 py-1 rounded-lg text-white font-semibold text-sm ${colors[tier]}`}>Tier {tier}</span>
}

function calculateAvgCpr(memberData) {
  const cprByRole = memberData.cpr_by_role || {}
  let total = 0, count = 0
  Object.values(cprByRole).forEach(level => {
    Object.values(level).forEach(cpr => {
      if (typeof cpr === 'number') { total += cpr; count++ }
    })
  })
  return count > 0 ? (total / count).toFixed(1) : 'N/A'
}

function calculateTotalCrimes(memberId, crimesData) {
  if (!crimesData?.crimes) return 0
  return Object.values(crimesData.crimes).filter(crime => 
    (crime.participant_ids || []).includes(parseInt(memberId))
  ).length
}

function getTopRoles(memberData) {
  const cprByRole = memberData.cpr_by_role || {}
  const allRoles = []
  Object.entries(cprByRole).forEach(([level, roles]) => {
    Object.entries(roles).forEach(([role, cpr]) => {
      if (typeof cpr === 'number') allRoles.push({ level, role, cpr })
    })
  })
  return allRoles.sort((a,b) => b.cpr - a.cpr).slice(0,3).map(r => `L${r.level} ${r.role}`).join(', ') || 'No data'
}