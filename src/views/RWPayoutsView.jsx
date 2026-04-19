import { useState, useEffect, useMemo } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../utils/supabase'
import { formatCurrency, formatCurrencyShort } from '../utils/payoutCalculations'
import { formatWarDateRange } from '../utils/warPayoutCalculations'
import StatCards from '../components/StatCards'

const OUR_FACTION_ID = 10739

export default function RWPayoutsView() {
  const { user } = useAuth()
  const [loading, setLoading] = useState(true)
  const [warPayouts, setWarPayouts] = useState([])
  const [selectedPayout, setSelectedPayout] = useState(null)
  const [payoutMembers, setPayoutMembers] = useState([])
  const [loadingDetails, setLoadingDetails] = useState(false)

  useEffect(() => {
    if (user?.id) loadPayoutData()
  }, [user?.id])

  async function loadPayoutData() {
    try {
      setLoading(true)

      // Load all war payouts for this user
      const { data, error } = await supabase
        .from('war_payout_members')
        .select('payout, war_payout_id, war_payouts(id, war_id, total_payout, member_count, created_at, ranked_wars(start_at, end_at, opponent_name, opponent_id, winner_faction_id, our_score, opponent_score))')
        .eq('member_id', user.id.toString())
        .order('war_payout_id', { ascending: false })

      if (error) throw error
      setWarPayouts(data || [])
    } catch (err) {
      console.error('Error loading war payout data:', err)
    } finally {
      setLoading(false)
    }
  }

  async function loadPayoutDetails(warPayoutId) {
    if (selectedPayout === warPayoutId) {
      setSelectedPayout(null)
      return
    }
    setSelectedPayout(warPayoutId)
    setLoadingDetails(true)
    try {
      const { data, error } = await supabase
        .from('war_payout_members')
        .select('member_id, member_name, payout')
        .eq('war_payout_id', warPayoutId)
        .order('payout', { ascending: false })

      if (error) throw error
      setPayoutMembers(data || [])
    } catch (err) {
      console.error('Error loading payout details:', err)
    } finally {
      setLoadingDetails(false)
    }
  }

  const myStats = useMemo(() => {
    if (warPayouts.length === 0) return null
    const totalEarned = warPayouts.reduce((sum, p) => sum + (p.payout || 0), 0)
    return {
      totalEarned,
      warsActive: warPayouts.length,
      avgPerWar: totalEarned / warPayouts.length,
      lastPayout: warPayouts[0]?.payout || 0,
    }
  }, [warPayouts])

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

  return (
    <div className="space-y-6">
      {/* My Stats */}
      {myStats && (
        <StatCards stats={[
          { label: 'Total Earned', value: formatCurrencyShort(myStats.totalEarned), color: 'text-blue-600' },
          { label: 'Wars Paid', value: myStats.warsActive },
          { label: 'Avg / War', value: formatCurrencyShort(myStats.avgPerWar) },
          { label: 'Last Payout', value: formatCurrencyShort(myStats.lastPayout), color: 'text-green-600' },
        ]} />
      )}

      {/* Payout History */}
      <div className="card">
        <h2 className="text-xl font-semibold mb-4">Payout History</h2>

        {warPayouts.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400 py-4">No war payouts yet.</p>
        ) : (
          <div className="space-y-2">
            {warPayouts.map((wp) => {
              const war = wp.war_payouts?.ranked_wars
              const payoutData = wp.war_payouts
              const result = war
                ? (!war.end_at || war.end_at === 0
                    ? 'ongoing'
                    : war.winner_faction_id === OUR_FACTION_ID ? 'win' : 'loss')
                : null
              const resultColor = result === 'win' ? 'text-green-600' : result === 'loss' ? 'text-red-500' : 'text-yellow-600'
              const label = war
                ? `vs ${war.opponent_name || `#${war.opponent_id}`}`
                : `Payout #${wp.war_payout_id}`
              const dateLabel = war ? formatWarDateRange(war.start_at, war.end_at) : ''
              const isExpanded = selectedPayout === wp.war_payout_id

              return (
                <div key={wp.war_payout_id}>
                  <div
                    className={`border rounded-lg p-4 cursor-pointer transition-colors ${
                      isExpanded
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                        : 'border-gray-200 dark:border-slate-700 hover:border-gray-300 dark:hover:border-slate-600'
                    }`}
                    onClick={() => loadPayoutDetails(wp.war_payout_id)}
                  >
                    <div className="flex items-center justify-between">
                      <div className="min-w-0">
                        <div className="font-semibold flex items-center gap-2">
                          {result && (
                            <span className={`text-xs font-bold ${resultColor}`}>
                              {result === 'win' ? 'W' : result === 'loss' ? 'L' : 'IP'}
                            </span>
                          )}
                          <span className="truncate">{label}</span>
                        </div>
                        <div className="text-sm text-gray-600 dark:text-gray-400">
                          {dateLabel}
                          {payoutData?.member_count && ` | ${payoutData.member_count} members`}
                        </div>
                      </div>
                      <div className="text-right flex-shrink-0 ml-4">
                        <div className="text-lg font-bold text-blue-600">
                          {formatCurrencyShort(wp.payout || 0)}
                        </div>
                        {payoutData?.total_payout && (
                          <div className="text-xs text-gray-500 dark:text-gray-400">
                            Pool: {formatCurrencyShort(payoutData.total_payout)}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Expanded payout details */}
                  {isExpanded && (
                    <div className="mt-1 border border-gray-200 dark:border-slate-700 rounded-lg overflow-hidden">
                      {loadingDetails ? (
                        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 p-4">
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600"></div>
                          Loading...
                        </div>
                      ) : (
                        <div className="overflow-auto max-h-[300px]">
                          <table className="w-full text-sm border-separate border-spacing-0">
                            <thead>
                              <tr className="text-left">
                                <th className="py-2 px-4 text-xs font-semibold sticky top-0 bg-gray-50 dark:bg-slate-700/50 border-b border-gray-200 dark:border-slate-700">Member</th>
                                <th className="py-2 px-4 text-xs font-semibold text-right sticky top-0 bg-gray-50 dark:bg-slate-700/50 border-b border-gray-200 dark:border-slate-700">Payout</th>
                              </tr>
                            </thead>
                            <tbody>
                              {payoutMembers.map(m => (
                                <tr key={m.member_id} className="border-b border-gray-100 dark:border-slate-700/50 last:border-0">
                                  <td className="py-1.5 px-4 text-xs">{m.member_name}</td>
                                  <td className="py-1.5 px-4 text-xs text-right font-semibold text-blue-600">
                                    {formatCurrency(m.payout || 0)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
