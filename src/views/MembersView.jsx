import { useState, useMemo } from 'react'

export default function MembersView({ cprData, crimesData }) {
  const [searchTerm, setSearchTerm] = useState('')
  const [tierFilter, setTierFilter] = useState('all')

  const members = useMemo(() => {
    if (!cprData?.members) return []
    let filtered = Object.entries(cprData.members).map(([id, data]) => ({
      id, ...data,
      avgCpr: calculateAvgCpr(data),
      totalCrimes: calculateTotalCrimes(id, crimesData)
    }))
    if (searchTerm) {
      filtered = filtered.filter(m => m.name?.toLowerCase().includes(searchTerm.toLowerCase()))
    }
    if (tierFilter !== 'all') {
      filtered = filtered.filter(m => m.tier === parseInt(tierFilter))
    }
    return filtered.sort((a, b) => (a.tier || 6) - (b.tier || 6))
  }, [cprData, crimesData, searchTerm, tierFilter])

  return (
    <div className="card">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-6">
        <h2 className="text-xl font-semibold">Member Performance by Tier</h2>
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
              <th className="py-3 px-4 font-semibold text-sm">Tier</th>
              <th className="py-3 px-4 font-semibold text-sm">Crimes</th>
              <th className="py-3 px-4 font-semibold text-sm">Avg CPR</th>
              <th className="py-3 px-4 font-semibold text-sm">Top Roles</th>
            </tr>
          </thead>
          <tbody>
            {members.length === 0 ? (
              <tr><td colSpan="5" className="py-8 text-center text-gray-500">No members found</td></tr>
            ) : (
              members.map(m => (
                <tr key={m.id} className="border-b border-gray-200 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-700/50">
                  <td className="py-3 px-4 font-medium">{m.name || `Member ${m.id}`}</td>
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
    (crime.participants || []).some(p => p.user_id === parseInt(memberId))
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