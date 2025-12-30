import { useState, useMemo, useEffect } from 'react'

export default function PayoutsView({ cprData }) {
  const [period, setPeriod] = useState('4')  // Default to last 4 weeks
  const [payoutData, setPayoutData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [sortBy, setSortBy] = useState('total')  // 'total' or 'recent'

  useEffect(() => {
    async function loadPayouts() {
      try {
        setLoading(true)
        const response = await fetch('/torn-forge-oc-system/data/payouts.json')
        if (response.ok) {
          const data = await response.json()
          setPayoutData(data)
        } else {
          console.error('Failed to load payout data')
        }
      } catch (error) {
        console.error('Error loading payouts:', error)
      } finally {
        setLoading(false)
      }
    }
    loadPayouts()
  }, [])

  const payouts = useMemo(() => {
    if (!payoutData?.members) return []
    
    const weeksToShow = period === 'all' ? Infinity : parseInt(period)
    
    return Object.values(payoutData.members).map(member => {
      // Filter weekly payouts to selected period
      const recentPayouts = member.weekly_payouts
        .sort((a, b) => b.week_ending.localeCompare(a.week_ending))
        .slice(0, weeksToShow)
      
      const periodTotal = recentPayouts.reduce((sum, w) => sum + w.payout, 0)
      const avgPayout = recentPayouts.length > 0 ? periodTotal / recentPayouts.length : 0
      const mostRecentPayout = recentPayouts[0]?.payout || 0
      
      return {
        memberId: member.member_id,
        name: member.member_name,
        tier: member.current_tier,
        totalPayout: periodTotal,
        avgPayout: avgPayout,
        recentPayout: mostRecentPayout,
        weeksActive: recentPayouts.length,
        weeklyDetails: recentPayouts
      }
    })
    .filter(m => m.weeksActive > 0)  // Only show members with payouts in selected period
    .sort((a, b) => {
      if (sortBy === 'total') return b.totalPayout - a.totalPayout
      if (sortBy === 'recent') return b.recentPayout - a.recentPayout
      return b.avgPayout - a.avgPayout
    })
  }, [payoutData, period, sortBy])

  if (loading) {
    return (
      <div className="card">
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mr-3"></div>
          <p className="text-gray-600 dark:text-gray-400">Loading payout data...</p>
        </div>
      </div>
    )
  }

  if (!payoutData) {
    return (
      <div className="card">
        <p className="text-center text-gray-500 py-8">No payout data available</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Summary Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="card">
          <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {payoutData.metadata.total_weeks}
          </div>
          <div className="text-sm text-gray-600 dark:text-gray-400 uppercase tracking-wide mt-1">
            Weeks Tracked
          </div>
        </div>
        <div className="card">
          <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            ${(payoutData.metadata.total_payout_all_time / 1e9).toFixed(2)}B
          </div>
          <div className="text-sm text-gray-600 dark:text-gray-400 uppercase tracking-wide mt-1">
            Total Distributed
          </div>
        </div>
        <div className="card">
          <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {payouts.length}
          </div>
          <div className="text-sm text-gray-600 dark:text-gray-400 uppercase tracking-wide mt-1">
            Active Members
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="card">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <h2 className="text-xl font-semibold">Weekly Payout Distribution</h2>
          <div className="flex gap-2">
            <select value={period} onChange={(e) => setPeriod(e.target.value)} className="input">
              <option value="1">Last Week</option>
              <option value="4">Last 4 Weeks</option>
              <option value="8">Last 8 Weeks</option>
              <option value="12">Last 12 Weeks</option>
              <option value="all">All Time</option>
            </select>
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className="input">
              <option value="total">Sort by Total</option>
              <option value="recent">Sort by Recent</option>
              <option value="avg">Sort by Average</option>
            </select>
          </div>
        </div>
      </div>

      {/* Payout Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {payouts.length === 0 ? (
          <p className="col-span-full text-center text-gray-500 py-8">No payout data for selected period</p>
        ) : (
          payouts.map(payout => (
            <PayoutCard key={payout.memberId} payout={payout} />
          ))
        )}
      </div>
    </div>
  )
}

function PayoutCard({ payout }) {
  const [showDetails, setShowDetails] = useState(false)

  return (
    <div className="card border border-gray-200 dark:border-slate-700 hover:shadow-md transition-shadow">
      <div className="mb-3">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-lg">{payout.name}</h3>
          <TierBadge tier={payout.tier} />
        </div>
      </div>
      
      <div className="mb-3">
        <div className="text-3xl font-bold text-blue-600 dark:text-blue-400">
          ${(payout.totalPayout / 1e6).toFixed(2)}M
        </div>
        <div className="text-sm text-gray-600 dark:text-gray-400 mt-1">
          Avg: ${(payout.avgPayout / 1e6).toFixed(2)}M per week
        </div>
      </div>
      
      <div className="space-y-2 text-sm text-gray-600 dark:text-gray-400 mb-3">
        <div>
          {payout.weeksActive} {payout.weeksActive === 1 ? 'week' : 'weeks'} active
        </div>
        <div>
          Last payout: ${(payout.recentPayout / 1e6).toFixed(2)}M
        </div>
      </div>

      <button
        onClick={() => setShowDetails(!showDetails)}
        className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
      >
        {showDetails ? 'Hide' : 'Show'} weekly breakdown
      </button>

      {showDetails && (
        <div className="mt-3 pt-3 border-t border-gray-200 dark:border-slate-700">
          <div className="space-y-2 text-sm">
            {payout.weeklyDetails.map(week => (
              <div key={week.week_ending} className="flex justify-between items-center">
                <span className="text-gray-600 dark:text-gray-400">{week.week_ending}</span>
                <span className="font-semibold">${(week.payout / 1e6).toFixed(2)}M</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function TierBadge({ tier }) {
  const colors = {1:'bg-tier-1',2:'bg-tier-2',3:'bg-tier-3',4:'bg-tier-4',5:'bg-tier-5',6:'bg-tier-6'}
  return <span className={`inline-block px-2 py-1 rounded text-white font-semibold text-xs ${colors[tier]}`}>Tier {tier}</span>
}