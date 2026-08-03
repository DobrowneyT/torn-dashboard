import { useState, useMemo } from 'react'
import { X } from 'lucide-react'
import { getCrimeStats, formatCurrency } from '../utils/payoutCalculations'

// Crime Statistics breakdown for a pay period: totals, success/fail by
// difficulty, and an expandable per-crime list with status filters. Shared by
// OC → Payout Management and OC → Payouts history so both render identically.
// `stats` is a getCrimeStats() result; the view re-filters to crimes executed
// within [fromTimestamp, toTimestamp] and recomputes totals for that window.
export default function CrimeStatsView({ stats, fromTimestamp, toTimestamp, onClose }) {
  const [expandedCrime, setExpandedCrime] = useState(null)
  const [statusFilters, setStatusFilters] = useState({
    success: true,
    failed: true,
    pending: false
  })

  // Filter crimes to only those executed in the pay period
  const payPeriodCrimes = useMemo(() => {
    return (stats?.crimesList || []).filter(crime => {
      if (!crime.executed_at) return false
      return crime.executed_at >= fromTimestamp && crime.executed_at <= toTimestamp
    })
  }, [stats, fromTimestamp, toTimestamp])

  const filteredStats = useMemo(() => getCrimeStats(payPeriodCrimes), [payPeriodCrimes])

  const filteredCrimes = useMemo(() => {
    return payPeriodCrimes.filter(crime => {
      const isSuccess = crime.status === 'Successful' || crime.status === 'Success'
      const isFailed = crime.status === 'Failed' || crime.status === 'Failure'
      const isPending = crime.status === 'Planning' || crime.status === 'Recruiting'

      if (isSuccess && !statusFilters.success) return false
      if (isFailed && !statusFilters.failed) return false
      if (isPending && !statusFilters.pending) return false

      return true
    })
  }, [payPeriodCrimes, statusFilters])

  const toggleFilter = (filter) => {
    setStatusFilters(prev => ({ ...prev, [filter]: !prev[filter] }))
  }

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold">Crime Statistics (Pay Period Only)</h3>
        <button onClick={onClose} className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
          <X className="w-6 h-6" />
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <div className="bg-white dark:bg-slate-800 rounded-lg p-3 border border-gray-200 dark:border-slate-700">
          <div className="text-xs text-gray-600 dark:text-gray-400">Total Crimes</div>
          <div className="text-2xl font-bold">{filteredStats.totals.count}</div>
        </div>
        <div className="bg-white dark:bg-slate-800 rounded-lg p-3 border border-green-200 dark:border-green-800">
          <div className="text-xs text-gray-600 dark:text-gray-400">Successful</div>
          <div className="text-xl font-bold text-green-600">{filteredStats.totals.success}</div>
        </div>
        <div className="bg-white dark:bg-slate-800 rounded-lg p-3 border border-red-200 dark:border-red-800">
          <div className="text-xs text-gray-600 dark:text-gray-400">Failed</div>
          <div className="text-xl font-bold text-red-600">{filteredStats.totals.failed}</div>
        </div>
        <div className="bg-white dark:bg-slate-800 rounded-lg p-3 border border-blue-200 dark:border-blue-800">
          <div className="text-xs text-gray-600 dark:text-gray-400">Total Money</div>
          <div className="text-lg font-bold text-blue-600">{formatCurrency(filteredStats.totals.totalMoney)}</div>
        </div>
      </div>

      <h4 className="font-semibold mb-2">By Difficulty Level</h4>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-4">
        {Object.entries(filteredStats.byDifficulty)
          .sort(([a], [b]) => parseInt(a) - parseInt(b))
          .map(([level, data]) => {
            const successRate = data.total > 0 ? ((data.success / data.total) * 100).toFixed(1) : 0
            return (
              <div key={level} className="bg-white dark:bg-slate-800 rounded-lg p-2 border border-gray-200 dark:border-slate-700 text-center">
                <div className="text-xs font-semibold text-gray-600 dark:text-gray-400">Level {level}</div>
                <div className="text-sm">
                  <span className="text-green-600">{data.success}</span>
                  {' / '}
                  <span className="text-red-600">{data.failed}</span>
                </div>
                <div className="text-xs text-gray-500">
                  {successRate}% success
                </div>
              </div>
            )
          })}
      </div>

      <div className="mb-4">
        <h4 className="font-semibold mb-2">Filter by Status</h4>
        <div className="flex gap-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={statusFilters.success}
              onChange={() => toggleFilter('success')}
              className="w-4 h-4 text-green-600"
            />
            <span className="text-sm">Success ({filteredStats.totals.success})</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={statusFilters.failed}
              onChange={() => toggleFilter('failed')}
              className="w-4 h-4 text-red-600"
            />
            <span className="text-sm">Failed ({filteredStats.totals.failed})</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={statusFilters.pending}
              onChange={() => toggleFilter('pending')}
              className="w-4 h-4 text-yellow-600"
            />
            <span className="text-sm">Pending (Planning/Recruiting)</span>
          </label>
        </div>
      </div>

      <h4 className="font-semibold mb-2">Individual Crimes ({filteredCrimes.length} shown)</h4>
      <div className="space-y-2 max-h-96 overflow-y-auto">
        {filteredCrimes.map((crime) => {
          const isPending = crime.status === 'Planning' || crime.status === 'Recruiting'
          const isSuccess = crime.status === 'Successful' || crime.status === 'Success'

          return (
            <div key={crime.id} className="bg-white dark:bg-slate-800 rounded-lg border border-gray-200 dark:border-slate-700">
              <div
                className="p-3 cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-700/50 flex items-center justify-between"
                onClick={() => setExpandedCrime(expandedCrime === crime.id ? null : crime.id)}
              >
                <div className="flex items-center gap-3">
                  <span className="text-lg">{expandedCrime === crime.id ? '▼' : '▶'}</span>
                  <div>
                    <div className="font-semibold text-sm">
                      {crime.name} (Level {crime.difficulty})
                    </div>
                    <div className="text-xs text-gray-500">
                      Crime #{crime.id} • {crime.participants.length} participants
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {isSuccess && (
                    <span className="text-green-600 font-semibold text-sm">
                      {formatCurrency(crime.moneyReward)}
                    </span>
                  )}
                  <span className={`px-2 py-1 rounded text-xs font-medium ${isSuccess
                    ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
                    : isPending
                      ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400'
                      : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400'
                    }`}>
                    {crime.status}
                  </span>
                </div>
              </div>

              {expandedCrime === crime.id && (
                <div className="px-3 pb-3 border-t border-gray-200 dark:border-slate-700">
                  <div className="mt-3">
                    <h5 className="font-semibold text-xs mb-2">Participants:</h5>
                    <div className="space-y-1">
                      {crime.slots && crime.slots.length > 0 ? (
                        crime.slots
                          .filter(slot => slot.user && slot.user.id)
                          .map((slot, idx) => {
                            const positionLabel = slot.position_number
                              ? `${slot.position} ${slot.position_number}`
                              : slot.position

                            const userName = slot.user.name || 'Unknown'
                            const userId = slot.user.id
                            const displayName = userName.includes('[') ? userName : `${userName} [${userId}]`

                            return (
                              <div key={idx} className="text-xs flex justify-between items-center py-1">
                                <span className="text-gray-700 dark:text-gray-300">
                                  {displayName} - {positionLabel}
                                </span>
                                <span className="text-gray-500">
                                  CPR: {Math.round(slot.checkpoint_pass_rate || 0)}
                                </span>
                              </div>
                            )
                          })
                      ) : (
                        <div className="text-xs text-gray-500">No participant data available</div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
