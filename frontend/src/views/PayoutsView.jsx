import { useState, useEffect, useMemo } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useFactionConfig } from '../contexts/FactionConfigContext'
import { useViewState } from '../contexts/ViewStateContext'
import { apiGet } from '../utils/apiClient'
import { formatCurrency, formatCurrencyShort, formatTimeHours, getCrimeStats, weekCrimeRowsToMap } from '../utils/payoutCalculations'
import { X, Info, BarChart3 } from 'lucide-react'
import StatCards from '../components/StatCards'
import CrimeStatsView from '../components/CrimeStatsView'

export default function PayoutsView({ isLeadership }) {
  const { user } = useAuth()
  const [persistedState, setPersistedState] = useViewState('payouts')

  const [period, setPeriod] = useState(persistedState.period || '4')

  // Data state
  const [payoutWeeks, setPayoutWeeks] = useState([])
  const [memberPayouts, setMemberPayouts] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedWeek, setSelectedWeek] = useState(null)
  const [weekMembers, setWeekMembers] = useState([])
  const [loadingWeekDetails, setLoadingWeekDetails] = useState(false)

  // Member drill-down
  const [selectedMember, setSelectedMember] = useState(null)
  const [memberCrimes, setMemberCrimes] = useState([])
  const [loadingMemberCrimes, setLoadingMemberCrimes] = useState(false)

  // Crime Statistics for a saved week (same view as Payout Management)
  const [crimeStatsWeek, setCrimeStatsWeek] = useState(null)   // weekData | null
  const [crimeStats, setCrimeStats] = useState(null)           // getCrimeStats() result
  const [loadingCrimeStats, setLoadingCrimeStats] = useState(false)

  // Week comparison
  const [compareMode, setCompareMode] = useState(false)
  const [compareWeekIds, setCompareWeekIds] = useState([null, null])
  const [compareData, setCompareData] = useState([null, null])
  const [loadingCompare, setLoadingCompare] = useState(false)

  // Info modal
  const [showInfo, setShowInfo] = useState(false)

  // Persist state
  useEffect(() => {
    setPersistedState({ period })
  }, [period, setPersistedState])

  // Load payout data
  useEffect(() => {
    loadPayoutData()
  }, [user?.id])

  async function loadPayoutData() {
    try {
      setLoading(true)

      const [{ weeks }, { members }] = await Promise.all([
        apiGet('/api/payouts/weeks?limit=100'),
        apiGet('/api/payouts/members'),
      ])
      setPayoutWeeks(weeks)
      setMemberPayouts(members)

    } catch (error) {
      console.error('Error loading payout data:', error)
    } finally {
      setLoading(false)
    }
  }

  async function loadWeekDetails(weekId) {
    try {
      setLoadingWeekDetails(true)
      setSelectedWeek(weekId)

      const { members } = await apiGet(`/api/payouts/weeks/${weekId}/members`)
      setWeekMembers(members)

    } catch (error) {
      console.error('Error loading week details:', error)
    } finally {
      setLoadingWeekDetails(false)
    }
  }

  async function loadMemberCrimes(memberId, weekStart, weekEnd) {
    try {
      setLoadingMemberCrimes(true)
      setSelectedMember(memberId)

      const startTs = Math.floor(new Date(weekStart).getTime() / 1000)
      const endTs = Math.floor(new Date(weekEnd).getTime() / 1000) + 86400

      // Server merges the member's slot into each crime; filter to the week
      // window by when they joined.
      const { crimes } = await apiGet(`/api/members/${memberId}/crimes?limit=1000`)
      setMemberCrimes(crimes.filter(c =>
        c.member_joined_at != null && c.member_joined_at >= startTs && c.member_joined_at < endTs
      ))

    } catch (error) {
      console.error('Error loading member crimes:', error)
    } finally {
      setLoadingMemberCrimes(false)
    }
  }

  // Load the saved week's linked crimes and build the same Crime Statistics
  // the Payout Management page shows — no payout re-run needed (crime_ids are
  // stored with the week). Shared getCrimeStats + weekCrimeRowsToMap keep the
  // two views identical.
  async function openCrimeStats(weekData) {
    if (!weekData) return
    try {
      setCrimeStatsWeek(weekData)
      setLoadingCrimeStats(true)
      setCrimeStats(null)
      const { crimes } = await apiGet(`/api/payouts/weeks/${weekData.id}/crimes`)
      setCrimeStats(getCrimeStats(weekCrimeRowsToMap(crimes)))
    } catch (error) {
      console.error('Error loading crime statistics:', error)
      setCrimeStats(getCrimeStats({}))
    } finally {
      setLoadingCrimeStats(false)
    }
  }

  // Get current user's payouts
  const myPayouts = useMemo(() => {
    if (!user?.id) return []
    return memberPayouts.filter(p => p.member_id === user.id.toString())
  }, [memberPayouts, user?.id])

  // My payout stats
  const myStats = useMemo(() => {
    if (myPayouts.length === 0) return null
    const totalEarned = myPayouts.reduce((sum, p) => sum + (p.payout || 0), 0)
    return {
      totalEarned,
      weeksActive: myPayouts.length,
      avgPerWeek: totalEarned / myPayouts.length,
      lastPayout: myPayouts[0]?.payout || 0,
    }
  }, [myPayouts])

  async function loadCompareWeek(index, weekId) {
    const newIds = [...compareWeekIds]
    newIds[index] = weekId
    setCompareWeekIds(newIds)

    if (!weekId) {
      const newData = [...compareData]
      newData[index] = null
      setCompareData(newData)
      return
    }

    setLoadingCompare(true)
    try {
      const { data, error } = await supabase
        .from('oc_payout_members')
        .select('*')
        .eq('week_id', weekId)
        .order('payout', { ascending: false })

      if (error) throw error
      const newData = [...compareData]
      newData[index] = data || []
      setCompareData(newData)
    } catch (err) {
      console.error('Error loading compare week:', err)
    } finally {
      setLoadingCompare(false)
    }
  }

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
      {/* My Payouts — summary bubbles */}
      {myStats && (
        <StatCards stats={[
          { label: 'Total Earned', value: formatCurrencyShort(myStats.totalEarned), color: 'text-blue-600' },
          { label: 'Weeks Active', value: myStats.weeksActive },
          { label: 'Avg / Week', value: formatCurrencyShort(myStats.avgPerWeek) },
          { label: 'Last Payout', value: formatCurrencyShort(myStats.lastPayout), color: 'text-green-600' },
        ]} />
      )}

      {/* Payout History — single card */}
      <div className="card">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-4">
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-semibold">Payout History</h2>
            <button
              onClick={() => setShowInfo(true)}
              className="p-1 text-gray-500 hover:text-blue-600 dark:text-gray-400 dark:hover:text-blue-400 transition-colors"
              title="How OC payouts are calculated"
              aria-label="Payout info"
            >
              <Info className="w-5 h-5" />
            </button>
          </div>
          <div className="flex gap-2 items-center flex-wrap">
            <select
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              className="input"
            >
              <option value="1">Last Week</option>
              <option value="4">Last 4 Weeks</option>
              <option value="8">Last 8 Weeks</option>
              <option value="12">Last 12 Weeks</option>
              <option value="all">All Time</option>
            </select>
            {payoutWeeks.length >= 2 && (
              <button
                onClick={() => {
                  setCompareMode(!compareMode)
                  if (compareMode) {
                    setCompareWeekIds([null, null])
                    setCompareData([null, null])
                  }
                }}
                className={`text-sm px-4 py-2 rounded ${
                  compareMode
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                }`}
              >
                {compareMode ? 'Exit Compare' : 'Compare Weeks'}
              </button>
            )}
          </div>
        </div>

        {/* Compare Weeks Section */}
        {compareMode && (
          <div className="mb-6 p-4 border border-gray-200 dark:border-slate-700 rounded-lg">
            <h3 className="text-sm font-semibold mb-3">Compare Weeks</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              {[0, 1].map(i => (
                <div key={i}>
                  <label className="block text-sm font-medium text-gray-600 dark:text-gray-400 mb-1">
                    Week {i + 1}
                  </label>
                  <select
                    value={compareWeekIds[i] || ''}
                    onChange={e => loadCompareWeek(i, e.target.value ? parseInt(e.target.value) : null)}
                    className="w-full p-2 border rounded dark:bg-gray-700 dark:border-gray-600 text-sm"
                  >
                    <option value="">Select a week...</option>
                    {payoutWeeks.map(w => (
                      <option key={w.id} value={w.id}>
                        {w.week_start} to {w.week_end} — {formatCurrencyShort(w.member_payout_total || 0)}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>

            {loadingCompare && (
              <div className="text-center py-4 text-gray-500 dark:text-gray-400">Loading...</div>
            )}

            {compareData[0] && compareData[1] && (
              <CompareTable weekA={compareData[0]} weekB={compareData[1]}
                labelA={payoutWeeks.find(w => w.id === parseInt(compareWeekIds[0]))?.week_start || 'Week A'}
                labelB={payoutWeeks.find(w => w.id === parseInt(compareWeekIds[1]))?.week_start || 'Week B'}
              />
            )}
          </div>
        )}

        {/* Weekly Breakdown */}
        <div className="space-y-2">
          {payoutWeeks.slice(0, period === 'all' ? undefined : parseInt(period)).map((week) => (
            <div
              key={week.id}
              className={`border rounded-lg p-4 cursor-pointer transition-colors ${
                selectedWeek === week.id
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                  : 'border-gray-200 dark:border-slate-700 hover:border-gray-300 dark:hover:border-slate-600'
              }`}
              onClick={() => loadWeekDetails(week.id)}
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-semibold">{week.week_start} - {week.week_end}</div>
                  <div className="text-sm text-gray-600 dark:text-gray-400">
                    {week.crimes_processed || 0} crimes | {week.member_count || '-'} members
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-lg font-bold text-blue-600">
                    {formatCurrencyShort(week.member_payout_total || week.total_member_payout || 0)}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {week.faction_cut_percent || 20}% faction cut
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Week Details Modal */}
      {selectedWeek && (
        <WeekDetailsModal
          weekId={selectedWeek}
          weekData={payoutWeeks.find(w => w.id === selectedWeek)}
          members={weekMembers}
          loading={loadingWeekDetails}
          onClose={() => setSelectedWeek(null)}
          onMemberClick={(memberId, weekStart, weekEnd) => loadMemberCrimes(memberId, weekStart, weekEnd)}
          onShowCrimeStats={openCrimeStats}
          isLeadership={isLeadership}
        />
      )}

      {/* Crime Statistics Modal — same breakdown as Payout Management */}
      {crimeStatsWeek && (
        <CrimeStatsModal
          weekData={crimeStatsWeek}
          stats={crimeStats}
          loading={loadingCrimeStats}
          onClose={() => { setCrimeStatsWeek(null); setCrimeStats(null) }}
        />
      )}

      {/* Member Crimes Modal */}
      {selectedMember && (
        <MemberCrimesModal
          memberId={selectedMember}
          crimes={memberCrimes}
          loading={loadingMemberCrimes}
          onClose={() => setSelectedMember(null)}
        />
      )}

      {/* OC Payout Info Modal */}
      {showInfo && <OcPayoutInfoModal onClose={() => setShowInfo(false)} />}
    </div>
  )
}

function OcPayoutInfoModal({ onClose }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-dialog sm:max-w-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex-shrink-0 p-4 border-b border-gray-200 dark:border-slate-700 flex items-center justify-between">
          <h3 className="text-lg font-semibold">How OC Payouts Work</h3>
          <button onClick={onClose} className="p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
            <X className="w-6 h-6" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-4 text-sm text-gray-700 dark:text-gray-300 leading-relaxed">
          <section>
            <h4 className="font-semibold text-gray-900 dark:text-gray-100 mb-2">Weekly pooled payouts</h4>
            <p>
              We run OC payouts weekly and pool all crime rewards together. To keep it fair, we pay based on the crimes you are <em>eligible for</em>, not just the crimes you happened to complete &mdash; that's what the tier system is for.
            </p>
          </section>

          <section>
            <h4 className="font-semibold text-gray-900 dark:text-gray-100 mb-2">The tier system</h4>
            <p>
              Each tier has a set of CPR requirements across the higher-level crimes. Meet all of them and you land at Tier&nbsp;1 (highest pay). As your CPR drops below the thresholds, you move down toward Tier&nbsp;6 (lowest pay). New members start at Tier&nbsp;0 (manual review) until a leader assigns them a tier.
            </p>
          </section>

          <section>
            <h4 className="font-semibold text-gray-900 dark:text-gray-100 mb-2">Time-spent scaling</h4>
            <p>
              On top of your tier eligibility, payouts are scaled by how much of the week you actually spent in a crime:
            </p>
            <ul className="list-disc list-inside mt-2 space-y-1">
              <li><strong>5/7 days or more</strong> in a crime &rarr; full payout for your tier.</li>
              <li><strong>2 to 5 days</strong> &rarr; scaled linearly between $0 and full payout.</li>
              <li><strong>Less than 2/7 days</strong> &rarr; $0 for the week.</li>
            </ul>
            <p className="mt-2">
              So: join crimes, and the moment your current crime finishes, jump straight into another. The more time you spend sitting in an OC, the closer you get to a full payout.
            </p>
          </section>
        </div>
        <div className="flex-shrink-0 p-4 border-t border-gray-200 dark:border-slate-700 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors text-sm font-medium"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  )
}

function TierBadge({ tier }) {
  const colors = {0:'bg-tier-review',1:'bg-tier-1',2:'bg-tier-2',3:'bg-tier-3',4:'bg-tier-4',5:'bg-tier-5',6:'bg-tier-6'}
  const label = tier === 0 ? 'Review' : `T${tier}`
  return <span className={`inline-block px-2 py-1 rounded text-white font-semibold text-xs ${colors[tier] ?? 'bg-tier-review'}`}>{label}</span>
}

function WeekDetailsModal({ weekId, weekData, members, loading, onClose, onMemberClick, onShowCrimeStats, isLeadership }) {
  // Non-tiered factions hide the Tier column here too (#136).
  const { usesTiers } = useFactionConfig()
  const [sortCol, setSortCol] = useState('payout')
  const [sortDir, setSortDir] = useState('desc')

  function handleSort(col) {
    if (sortCol === col) {
      setSortDir(prev => prev === 'asc' ? 'desc' : 'asc')
    } else {
      setSortCol(col)
      setSortDir('desc')
    }
  }

  const sortedMembers = useMemo(() => {
    const d = sortDir === 'asc' ? 1 : -1
    return members.slice().sort((a, b) => {
      switch (sortCol) {
        case 'name':       return d * (a.member_name || '').localeCompare(b.member_name || '')
        case 'tier':       return d * ((a.tier || 0) - (b.tier || 0))
        case 'time':       return d * ((a.time_spent || 0) - (b.time_spent || 0))
        case 'tickets':    return d * ((a.base_tickets || 0) - (b.base_tickets || 0))
        case 'penalty':    return d * ((a.sit_out_penalty || 0) - (b.sit_out_penalty || 0))
        case 'share':      return d * ((a.share_percent || 0) - (b.share_percent || 0))
        case 'payout':     return d * ((a.payout || 0) - (b.payout || 0))
        case 'theoretical': return d * ((a.theoretical_payout || 0) - (b.theoretical_payout || 0))
        default:           return d * ((a.payout || 0) - (b.payout || 0))
      }
    })
  }, [members, sortCol, sortDir])

  if (loading) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-white dark:bg-slate-800 rounded-lg p-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        </div>
      </div>
    )
  }

  const weekStart = members[0]?.week_start
  const weekEnd = members[0]?.week_end

  const moneyReward = weekData?.total_money_reward || 0
  const itemReward = weekData?.total_item_reward || 0
  const itemCost = weekData?.total_item_cost || 0
  const netTotal = moneyReward + (weekData?.net_item_value || 0)
  const factionCut = weekData?.faction_cut_amount || 0
  const factionCutPct = weekData?.faction_cut_percent || 20
  const memberPool = weekData?.member_payout_total || 0
  const memberCount = weekData?.member_count || members.length
  const crimeCount = weekData?.crimes_processed || 0

  function SortHeader({ col, label, className = '', sticky: isSticky }) {
    const active = sortCol === col
    return (
      <th
        className={`py-2 px-2 text-xs font-semibold cursor-pointer select-none hover:text-gray-700 dark:hover:text-gray-200 transition-colors ${isSticky ? 'sticky top-0 z-20 bg-white dark:bg-slate-800 border-b-2 border-gray-200 dark:border-slate-700' : ''} ${className}`}
        onClick={() => handleSort(col)}
      >
        {label}
        <span className="ml-1 text-gray-400">
          {active ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
        </span>
      </th>
    )
  }

  return (
    <div className="modal-overlay">
      <div className="modal-dialog sm:max-w-5xl">
        <div className="flex-shrink-0 p-4 border-b border-gray-200 dark:border-slate-700 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold">Week Details</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {weekStart} - {weekEnd} | {members.length} members
            </p>
          </div>
          <div className="flex items-center gap-2">
            {weekData && onShowCrimeStats && (
              <button
                onClick={() => onShowCrimeStats(weekData)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold transition-colors"
                title="View crime-by-crime statistics for this week"
              >
                <BarChart3 className="w-4 h-4" />
                Crime Statistics
              </button>
            )}
            <button onClick={onClose} className="p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
              <X className="w-6 h-6" />
            </button>
          </div>
        </div>

        {/* Payout Summary — outside scroll area */}
        {weekData && (
          <div className="flex-shrink-0 px-4 pt-4 pb-2">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <SummaryStatCard label="Money Reward" value={formatCurrency(moneyReward)} />
              <SummaryStatCard label="Item Reward" value={formatCurrency(itemReward)} />
              <SummaryStatCard label="Item Cost" value={formatCurrency(itemCost)} color="text-red-600" />
              <SummaryStatCard label="Net Total" value={formatCurrency(netTotal)} color="text-blue-600" />
              <SummaryStatCard label={`Faction Cut (${factionCutPct}%)`} value={formatCurrency(factionCut)} />
              <SummaryStatCard label="Member Pool" value={formatCurrency(memberPool)} color="text-green-600" />
              <SummaryStatCard label="Members" value={memberCount} />
              <SummaryStatCard label="Crimes" value={crimeCount} />
            </div>
          </div>
        )}

        {/* Member Table — scrollable with frozen header */}
        <div className="flex-1 overflow-auto px-4 pb-4">
            <table className="w-full text-sm border-separate border-spacing-0">
              <thead>
                <tr className="text-left">
                  <SortHeader col="name" label="Member" sticky />
                  {usesTiers && <SortHeader col="tier" label="Tier" sticky />}
                  <SortHeader col="time" label="Time" sticky />
                  <SortHeader col="tickets" label="Tickets" sticky />
                  <SortHeader col="penalty" label="Penalty" sticky />
                  <SortHeader col="share" label="Share %" sticky />
                  <SortHeader col="payout" label="Payout" sticky />
                  {isLeadership && <SortHeader col="theoretical" label="Theoretical" sticky />}
                  <th className="py-2 px-2 text-xs font-semibold sticky top-0 z-20 bg-white dark:bg-slate-800 border-b-2 border-gray-200 dark:border-slate-700">Actions</th>
                </tr>
              </thead>
              <tbody>
                {sortedMembers.map((m) => (
                  <tr key={m.member_id} className="border-b border-gray-100 dark:border-slate-800">
                    <td className="py-2 px-2 text-xs font-medium">{m.member_name}</td>
                    {usesTiers && <td className="py-2 px-2"><TierBadge tier={m.tier} /></td>}
                    <td className="py-2 px-2 text-xs">{formatTimeHours(m.time_spent || 0)}</td>
                    <td className="py-2 px-2 text-xs">{m.base_tickets}</td>
                    <td className="py-2 px-2 text-xs">
                      <span className={m.sit_out_penalty < 0 ? 'text-red-600' : ''}>
                        {(m.sit_out_penalty || 0).toFixed(1)}
                      </span>
                    </td>
                    <td className="py-2 px-2 text-xs">{(m.share_percent || 0).toFixed(4)}%</td>
                    <td className="py-2 px-2 text-xs font-semibold text-blue-600">
                      {formatCurrency(m.payout || 0)}
                    </td>
                    {isLeadership && (
                      <td className="py-2 px-2 text-xs text-gray-600">
                        {formatCurrency(m.theoretical_payout || 0)}
                      </td>
                    )}
                    <td className="py-2 px-2 text-xs">
                      <button
                        onClick={() => onMemberClick(m.member_id, weekStart, weekEnd)}
                        className="text-blue-600 hover:underline"
                      >
                        Crimes
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
        </div>
      </div>
    </div>
  )
}

function CrimeStatsModal({ weekData, stats, loading, onClose }) {
  // Pay-period window for CrimeStatsView's executed_at filter — prefer the
  // stored timestamps, fall back to the date strings (mirrors Payout Management).
  const fromTs = weekData.week_start_timestamp
    ?? Math.floor(new Date(weekData.week_start).getTime() / 1000)
  const toTs = weekData.week_end_timestamp
    ?? (Math.floor(new Date(weekData.week_end).getTime() / 1000) + 86400)

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-dialog sm:max-w-4xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex-1 overflow-y-auto p-4">
          {loading || !stats ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mr-3"></div>
              <p className="text-gray-600 dark:text-gray-400">Loading crime statistics...</p>
            </div>
          ) : (
            <CrimeStatsView
              stats={stats}
              fromTimestamp={fromTs}
              toTimestamp={toTs}
              onClose={onClose}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function SummaryStatCard({ label, value, color = '' }) {
  return (
    <div className="bg-gray-50 dark:bg-slate-700/50 rounded-lg p-3">
      <div className={`text-sm font-bold ${color || 'text-gray-900 dark:text-gray-100'}`}>
        {value}
      </div>
      <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{label}</div>
    </div>
  )
}

function MemberCrimesModal({ memberId, crimes, loading, onClose }) {
  if (loading) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-white dark:bg-slate-800 rounded-lg p-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        </div>
      </div>
    )
  }

  return (
    <div className="modal-overlay">
      <div className="modal-dialog sm:max-w-4xl">
        <div className="flex-shrink-0 p-4 border-b border-gray-200 dark:border-slate-700 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold">Crimes Participated</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {crimes.length} crimes found
            </p>
          </div>
          <button onClick={onClose} className="p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {crimes.length === 0 ? (
            <p className="text-center text-gray-500 dark:text-gray-400 py-8">No crimes found for this period</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b-2 border-gray-200 dark:border-slate-700 sticky top-0 bg-white dark:bg-slate-800">
                <tr className="text-left">
                  <th className="py-2 px-2 text-xs font-semibold">Crime</th>
                  <th className="py-2 px-2 text-xs font-semibold">Level</th>
                  <th className="py-2 px-2 text-xs font-semibold">Status</th>
                  <th className="py-2 px-2 text-xs font-semibold">Position</th>
                  <th className="py-2 px-2 text-xs font-semibold">CPR</th>
                  <th className="py-2 px-2 text-xs font-semibold">Reward</th>
                  <th className="py-2 px-2 text-xs font-semibold">Executed</th>
                </tr>
              </thead>
              <tbody>
                {crimes.map((crime) => (
                  <tr key={crime.crime_id} className="border-b border-gray-100 dark:border-slate-800">
                    <td className="py-2 px-2 text-xs font-medium">{crime.name}</td>
                    <td className="py-2 px-2 text-xs">{crime.difficulty}</td>
                    <td className="py-2 px-2 text-xs">
                      <StatusBadge status={crime.status} />
                    </td>
                    <td className="py-2 px-2 text-xs">{crime.member_position}</td>
                    <td className="py-2 px-2 text-xs">{Math.round(crime.member_cpr || 0)}</td>
                    <td className="py-2 px-2 text-xs font-semibold text-green-600">
                      {crime.status === 'Successful' ? formatCurrency(crime.rewards_money || 0) : '-'}
                    </td>
                    <td className="py-2 px-2 text-xs text-gray-600">
                      {crime.executed_at ? new Date(crime.executed_at * 1000).toLocaleDateString() : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}

function StatusBadge({ status }) {
  const colors = {
    'Successful': 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
    'Success': 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
    'Failed': 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
    'Failure': 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
    'Planning': 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
    'Recruiting': 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400'
  }

  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${colors[status] || 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'}`}>
      {status}
    </span>
  )
}

function CompareTable({ weekA, weekB, labelA, labelB }) {
  const allMembers = new Map()

  for (const m of weekA) {
    allMembers.set(m.member_id, { name: m.member_name, a: m, b: null })
  }
  for (const m of weekB) {
    if (allMembers.has(m.member_id)) {
      allMembers.get(m.member_id).b = m
    } else {
      allMembers.set(m.member_id, { name: m.member_name, a: null, b: m })
    }
  }

  const rows = Array.from(allMembers.values()).sort((a, b) => {
    const aMax = Math.max(a.a?.payout || 0, a.b?.payout || 0)
    const bMax = Math.max(b.a?.payout || 0, b.b?.payout || 0)
    return bMax - aMax
  })

  function diffCell(valA, valB, formatter = v => v) {
    const diff = (valB || 0) - (valA || 0)
    const color = diff > 0 ? 'text-green-600' : diff < 0 ? 'text-red-500' : 'text-gray-400'
    return (
      <span className={`text-xs ${color}`}>
        {diff > 0 ? '+' : ''}{formatter(diff)}
      </span>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-b-2 border-gray-200 dark:border-gray-700">
          <tr className="text-left text-xs text-gray-500 dark:text-gray-400">
            <th className="py-2 pr-3">Member</th>
            <th className="py-2 pr-3 text-right">{labelA}</th>
            <th className="py-2 pr-3 text-right">{labelB}</th>
            <th className="py-2 pr-3 text-right">Change</th>
            <th className="py-2 pr-3 text-center">Tier A/B</th>
            <th className="py-2 text-right">Time A/B (h)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ name, a, b }) => (
            <tr key={name} className="border-b border-gray-100 dark:border-gray-700/50">
              <td className="py-2 pr-3 text-gray-900 dark:text-white">{name}</td>
              <td className="py-2 pr-3 text-right font-medium">
                {a ? formatCurrencyShort(a.payout) : '-'}
              </td>
              <td className="py-2 pr-3 text-right font-medium">
                {b ? formatCurrencyShort(b.payout) : '-'}
              </td>
              <td className="py-2 pr-3 text-right">
                {a && b ? diffCell(a.payout, b.payout, v => formatCurrencyShort(v)) : '-'}
              </td>
              <td className="py-2 pr-3 text-center text-xs text-gray-500 dark:text-gray-400">
                {a?.tier ?? '-'} / {b?.tier ?? '-'}
              </td>
              <td className="py-2 text-right text-xs text-gray-500 dark:text-gray-400">
                {a ? ((a.time_spent || 0) / 3600).toFixed(0) : '-'} / {b ? ((b.time_spent || 0) / 3600).toFixed(0) : '-'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
