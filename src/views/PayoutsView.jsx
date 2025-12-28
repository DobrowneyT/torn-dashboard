import { useState, useMemo } from 'react'
import { config } from '../config'

export default function PayoutsView({ cprData, crimesData }) {
  const [period, setPeriod] = useState('30')

  const payouts = useMemo(() => {
    if (!cprData?.members || !crimesData?.crimes) return []
    const cutoffTimestamp = period === 'all' ? 0 : (Date.now() / 1000) - parseInt(period) * 24 * 60 * 60

    return Object.entries(cprData.members).map(([memberId, memberData]) => {
      const tier = memberData.tier || 6
      const tickets = config.payoutTickets[tier] || 0
      const name = memberData.name || `Member ${memberId}`

      const crimesInPeriod = Object.values(crimesData.crimes).filter(crime => {
        // Use executed_at for completed crimes, created_at for in-progress
        const crimeTimestamp = crime.executed_at || crime.created_at || 0
        const isInPeriod = crimeTimestamp >= cutoffTimestamp
        // Check participant_ids array instead of participants
        const participated = (crime.participant_ids || []).includes(parseInt(memberId))
        // Check for Successful status (actual database format)
        const isCompleted = crime.status === 'Successful' || crime.status === 'Success'
        return isInPeriod && participated && isCompleted
      })

      // Sum up rewards.money from completed crimes
      const totalPayout = crimesInPeriod.reduce((sum, c) => sum + (c.rewards?.money || 0), 0)

      return { memberId, name, tier, tickets, crimesCount: crimesInPeriod.length, totalPayout }
    }).sort((a, b) => b.totalPayout - a.totalPayout).slice(0, 20)
  }, [cprData, crimesData, period])

  return (
    <div className="card">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-6">
        <h2 className="text-xl font-semibold">Payout Analysis</h2>
        <select value={period} onChange={(e) => setPeriod(e.target.value)} className="input md:w-48">
          <option value="7">Last 7 Days</option>
          <option value="30">Last 30 Days</option>
          <option value="90">Last 90 Days</option>
          <option value="all">All Time</option>
        </select>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {payouts.length === 0 ? (
          <p className="col-span-full text-center text-gray-500 py-8">No payout data available</p>
        ) : (
          payouts.map(payout => (
            <div key={payout.memberId} className="card border border-gray-200 dark:border-slate-700 hover:shadow-md transition-shadow">
              <div className="mb-3">
                <h3 className="font-semibold text-lg">{payout.name}</h3>
              </div>
              <div className="mb-3">
                <div className="text-3xl font-bold text-blue-600 dark:text-blue-400">
                  ${(payout.totalPayout / 1e6).toFixed(2)}M
                </div>
              </div>
              <div className="space-y-2 text-sm text-gray-600 dark:text-gray-400">
                <div><TierBadge tier={payout.tier} /></div>
                <div>{payout.crimesCount} crimes • {payout.tickets} tickets</div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function TierBadge({ tier }) {
  const colors = {1:'bg-tier-1',2:'bg-tier-2',3:'bg-tier-3',4:'bg-tier-4',5:'bg-tier-5',6:'bg-tier-6'}
  return <span className={`inline-block px-2 py-1 rounded text-white font-semibold text-xs ${colors[tier]}`}>Tier {tier}</span>
}