import { useState, useMemo } from 'react'
import { format } from 'date-fns'

export default function CrimesView({ crimesData }) {
  const [daysFilter, setDaysFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')

  const crimes = useMemo(() => {
    if (!crimesData?.crimes) return []
    let filtered = Object.entries(crimesData.crimes).map(([id, data]) => {
      // Map status to standardized values
      const normalizedStatus = normalizeStatus(data.status)
      
      // Use executed_at for completed crimes, otherwise use created_at
      const crimeDate = data.executed_at || data.created_at
      
      return {
        id,
        ...data,
        status: normalizedStatus,
        completed_at: data.executed_at,
        date: crimeDate,
        // Extract payout from rewards.money
        payout: data.rewards?.money || 0,
        // Use participant_ids length
        participantCount: (data.participant_ids || []).length
      }
    })
    
    if (daysFilter !== 'all') {
      const cutoff = Date.now() / 1000 - parseInt(daysFilter) * 24 * 60 * 60
      filtered = filtered.filter(crime => crime.date >= cutoff)
    }
    
    if (statusFilter !== 'all') {
      filtered = filtered.filter(crime => crime.status === statusFilter)
    }
    
    return filtered.sort((a, b) => (b.date || 0) - (a.date || 0)).slice(0, 100)
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
            <option value="in-progress">In Progress</option>
            <option value="recruiting">Recruiting</option>
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
                  <td className="py-3 px-4">{formatPayout(crime.payout)}</td>
                  <td className="py-3 px-4">{crime.participantCount} members</td>
                  <td className="py-3 px-4 text-sm text-gray-600 dark:text-gray-400">
                    {formatDate(crime.date)}
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

function normalizeStatus(status) {
  const statusMap = {
    'Successful': 'completed',
    'Success': 'completed',
    'Completed': 'completed',
    'Failed': 'failed',
    'Failure': 'failed',
    'Planning': 'in-progress',
    'Executing': 'in-progress',
    'Recruiting': 'recruiting',
    'Ready': 'in-progress'
  }
  return statusMap[status] || status.toLowerCase()
}

function StatusBadge({ status }) {
  const colors = {
    'completed': 'bg-green-500',
    'failed': 'bg-red-500',
    'in-progress': 'bg-blue-500',
    'recruiting': 'bg-yellow-500'
  }
  const labels = {
    'completed': 'Completed',
    'failed': 'Failed',
    'in-progress': 'In Progress',
    'recruiting': 'Recruiting'
  }
  return (
    <span className={`inline-block px-3 py-1 rounded-lg text-white font-semibold text-sm ${colors[status] || 'bg-gray-500'}`}>
      {labels[status] || status}
    </span>
  )
}

function formatPayout(payout) {
  if (!payout || payout === 0) return 'N/A'
  return `$${(payout / 1e6).toFixed(2)}M`
}

function formatDate(timestamp) {
  if (!timestamp) return 'N/A'
  try {
    // Handle Unix timestamp (seconds)
    const date = new Date(timestamp * 1000)
    return format(date, 'MMM dd, yyyy HH:mm')
  } catch {
    return 'Invalid date'
  }
}