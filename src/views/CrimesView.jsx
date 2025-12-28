import { useState, useMemo } from 'react'
import { format } from 'date-fns'

export default function CrimesView({ crimesData }) {
  const [daysFilter, setDaysFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')

  const crimes = useMemo(() => {
    if (!crimesData?.crimes) return []
    let filtered = Object.entries(crimesData.crimes).map(([id, data]) => ({ id, ...data }))
    
    if (daysFilter !== 'all') {
      const cutoff = new Date(Date.now() - parseInt(daysFilter) * 24 * 60 * 60 * 1000)
      filtered = filtered.filter(crime => {
        const crimeDate = new Date(crime.completed_at || crime.created_at || 0)
        return crimeDate >= cutoff
      })
    }
    if (statusFilter !== 'all') {
      filtered = filtered.filter(crime => crime.status === statusFilter)
    }
    return filtered.sort((a,b) => {
      const dateA = new Date(a.completed_at || a.created_at || 0)
      const dateB = new Date(b.completed_at || b.created_at || 0)
      return dateB - dateA
    }).slice(0, 100)
  }, [crimesData, daysFilter, statusFilter])

  return (
    <div className="card">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-6">
        <h2 className="text-xl font-semibold">Recent Crime History</h2>
        <div className="flex gap-2">
          <select value={daysFilter} onChange={(e) => setDaysFilter(e.target.value)} className="input">
            <option value="all">All Time</option>
            <option value="7">Last 7 Days</option>
            <option value="30">Last 30 Days</option>
            <option value="90">Last 90 Days</option>
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="input">
            <option value="all">All Statuses</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
          </select>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="border-b-2 border-gray-200 dark:border-slate-700">
            <tr className="text-left">
              <th className="py-3 px-4 font-semibold text-sm">Crime ID</th>
              <th className="py-3 px-4 font-semibold text-sm">Name</th>
              <th className="py-3 px-4 font-semibold text-sm">Level</th>
              <th className="py-3 px-4 font-semibold text-sm">Status</th>
              <th className="py-3 px-4 font-semibold text-sm">Payout</th>
              <th className="py-3 px-4 font-semibold text-sm">Participants</th>
              <th className="py-3 px-4 font-semibold text-sm">Date</th>
            </tr>
          </thead>
          <tbody>
            {crimes.length === 0 ? (
              <tr><td colSpan="7" className="py-8 text-center text-gray-500">No crimes found</td></tr>
            ) : (
              crimes.map(crime => (
                <tr key={crime.id} className="border-b border-gray-200 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-700/50">
                  <td className="py-3 px-4 font-mono text-sm">{crime.id}</td>
                  <td className="py-3 px-4">{crime.name || 'Unknown'}</td>
                  <td className="py-3 px-4">Level {crime.difficulty || 'N/A'}</td>
                  <td className="py-3 px-4"><StatusBadge status={crime.status} /></td>
                  <td className="py-3 px-4">${((crime.payout || 0) / 1e6).toFixed(2)}M</td>
                  <td className="py-3 px-4">{(crime.participants || []).length} members</td>
                  <td className="py-3 px-4 text-sm text-gray-600 dark:text-gray-400">
                    {formatDate(crime.completed_at || crime.created_at)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function StatusBadge({ status }) {
  const colors = {completed:'bg-green-500',failed:'bg-red-500','in-progress':'bg-yellow-500'}
  return <span className={`inline-block px-3 py-1 rounded-lg text-white font-semibold text-sm ${colors[status] || 'bg-gray-500'}`}>{status}</span>
}

function formatDate(dateString) {
  if (!dateString) return 'N/A'
  try { return format(new Date(dateString), 'MMM dd, yyyy') }
  catch { return 'Invalid date' }
}