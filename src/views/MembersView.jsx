import { useState, useMemo, useEffect } from 'react'

export default function MembersView({ cprData, crimesData }) {
  const [searchTerm, setSearchTerm] = useState('')
  const [tierFilter, setTierFilter] = useState('all')
  const [currentFactionMembers, setCurrentFactionMembers] = useState(null)
  const [loading, setLoading] = useState(true)

  // Fetch current faction members from Torn API
  useEffect(() => {
    async function fetchFactionMembers() {
      try {
        setLoading(true)
        // You'll need to add your faction API key to config or env
        const factionId = import.meta.env.VITE_FACTION_ID || '46427' // Replace with your faction ID
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
          // Extract member IDs from faction data
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
    
    return filtered.sort((a, b) => (a.tier || 6) - (b.tier || 6))
  }, [cprData, crimesData, searchTerm, tierFilter, currentFactionMembers])

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
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="Search members..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="input flex-1 md:w-64"
          />
          <select value={tierFilter} onChange={(e) => setTierFilter(e.target.value)} className="input">
            <option value="all">All Tiers</option>
            {[1,2,3,4,5,6].map(t => <option key={t} value={t}>Tier {t}</option>)}
          </select>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="border-b-2 border-gray-200 dark:border-slate-700">
            <tr className="text-left">
              <th className="py-3 px-4 font-semibold text-sm">Member</th>
              <th className="py-3 px-4 font-semibold text-sm">ID</th>
              <th className="py-3 px-4 font-semibold text-sm">Tier</th>
              <th className="py-3 px-4 font-semibold text-sm">Crimes</th>
              <th className="py-3 px-4 font-semibold text-sm">Avg CPR</th>
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