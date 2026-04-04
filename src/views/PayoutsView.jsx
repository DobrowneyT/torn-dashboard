import { useState, useEffect, useMemo } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useViewState } from '../contexts/ViewStateContext'
import { supabase } from '../utils/supabase'
import { formatCurrency, formatCurrencyShort, formatTimeHours } from '../utils/payoutCalculations'

export default function PayoutsView({ isLeadership }) {
  const { user } = useAuth()
  const [persistedState, setPersistedState] = useViewState('payouts')
  
  // View mode: 'all' for all weeks, 'my' for current user's payouts
  const [viewMode, setViewMode] = useState(persistedState.viewMode || 'all')
  const [period, setPeriod] = useState(persistedState.period || '4')
  const [sortBy, setSortBy] = useState(persistedState.sortBy || 'total')
  
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

  // Week comparison
  const [compareMode, setCompareMode] = useState(false)
  const [compareWeekIds, setCompareWeekIds] = useState([null, null])
  const [compareData, setCompareData] = useState([null, null])
  const [loadingCompare, setLoadingCompare] = useState(false)

  // Persist state
  useEffect(() => {
    setPersistedState({ viewMode, period, sortBy })
  }, [viewMode, period, sortBy, setPersistedState])

  // Load payout data
  useEffect(() => {
    loadPayoutData()
  }, [user?.id])

  async function loadPayoutData() {
    try {
      setLoading(true)
      
      // Load all payout weeks
      const { data: weeks, error: weeksError } = await supabase
        .from('oc_payout_weeks')
        .select('*')
        .order('week_end', { ascending: false })
      
      if (weeksError) throw weeksError
      setPayoutWeeks(weeks || [])
      
      // Load member payouts (either all or just current user)
      const memberQuery = supabase
        .from('oc_payout_members')
        .select('*')
        .order('week_end', { ascending: false })
      
      const { data: members, error: membersError } = await memberQuery
      
      if (membersError) throw membersError
      setMemberPayouts(members || [])
      
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
      
      const { data, error } = await supabase
        .from('oc_payout_members')
        .select('*')
        .eq('week_id', weekId)
        .order('payout', { ascending: false })
      
      if (error) throw error
      setWeekMembers(data || [])
      
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
      
      // Get the week timestamps
      const startTs = Math.floor(new Date(weekStart).getTime() / 1000)
      const endTs = Math.floor(new Date(weekEnd).getTime() / 1000) + 86400
      
      // Find crimes where this member participated via crime_slots
      const { data: slots, error: slotsError } = await supabase
        .from('crime_slots')
        .select('crime_id, joined_at, position, checkpoint_pass_rate')
        .eq('user_id', memberId)
        .gte('joined_at', startTs)
        .lt('joined_at', endTs)
      
      if (slotsError) throw slotsError
      
      if (!slots || slots.length === 0) {
        setMemberCrimes([])
        return
      }
      
      const crimeIds = [...new Set(slots.map(s => s.crime_id))]
      
      // Get crime details
      const { data: crimes, error: crimesError } = await supabase
        .from('crimes')
        .select('*')
        .in('crime_id', crimeIds)
        .order('executed_at', { ascending: false })
      
      if (crimesError) throw crimesError
      
      // Combine slot and crime data
      const crimesWithSlots = (crimes || []).map(crime => {
        const memberSlot = slots.find(s => s.crime_id === crime.crime_id)
        return {
          ...crime,
          member_joined_at: memberSlot?.joined_at,
          member_position: memberSlot?.position,
          member_cpr: memberSlot?.checkpoint_pass_rate
        }
      })
      
      setMemberCrimes(crimesWithSlots)
      
    } catch (error) {
      console.error('Error loading member crimes:', error)
    } finally {
      setLoadingMemberCrimes(false)
    }
  }

  // Get current user's payouts
  const myPayouts = useMemo(() => {
    if (!user?.id) return []
    return memberPayouts.filter(p => p.member_id === user.id.toString())
  }, [memberPayouts, user?.id])

  // Aggregate payouts by member for the "all" view
  const aggregatedPayouts = useMemo(() => {
    const weeksToShow = period === 'all' ? Infinity : parseInt(period)
    const recentWeeks = payoutWeeks.slice(0, weeksToShow)
    const recentWeekIds = new Set(recentWeeks.map(w => w.id))
    
    // Group by member
    const memberMap = {}
    
    memberPayouts
      .filter(p => recentWeekIds.has(p.week_id))
      .forEach(payout => {
        const memberId = payout.member_id
        
        if (!memberMap[memberId]) {
          memberMap[memberId] = {
            memberId,
            name: payout.member_name,
            tier: payout.tier,
            totalPayout: 0,
            totalTheoretical: 0,
            totalTime: 0,
            weeksActive: 0,
            payouts: []
          }
        }
        
        memberMap[memberId].totalPayout += payout.payout || 0
        memberMap[memberId].totalTheoretical += payout.theoretical_payout || 0
        memberMap[memberId].totalTime += payout.time_spent || 0
        memberMap[memberId].weeksActive++
        memberMap[memberId].payouts.push(payout)
        
        // Update tier to most recent
        if (payout.tier) {
          memberMap[memberId].tier = payout.tier
        }
      })
    
    // Convert to array and calculate averages
    return Object.values(memberMap)
      .map(m => ({
        ...m,
        avgPayout: m.weeksActive > 0 ? m.totalPayout / m.weeksActive : 0,
        avgTheoretical: m.weeksActive > 0 ? m.totalTheoretical / m.weeksActive : 0,
        recentPayout: m.payouts[0]?.payout || 0
      }))
      .sort((a, b) => {
        if (sortBy === 'total') return b.totalPayout - a.totalPayout
        if (sortBy === 'recent') return b.recentPayout - a.recentPayout
        return b.avgPayout - a.avgPayout
      })
  }, [memberPayouts, payoutWeeks, period, sortBy])

  // Summary stats
  const summaryStats = useMemo(() => {
    const totalAllTime = memberPayouts.reduce((sum, p) => sum + (p.payout || 0), 0)
    const weeksToShow = period === 'all' ? payoutWeeks.length : parseInt(period)
    const periodWeeks = payoutWeeks.slice(0, weeksToShow)
    const periodTotal = periodWeeks.reduce((sum, w) => sum + (w.member_payout_total || 0), 0)
    
    return {
      totalWeeks: payoutWeeks.length,
      totalAllTime,
      periodTotal,
      activeMembers: aggregatedPayouts.length
    }
  }, [payoutWeeks, memberPayouts, aggregatedPayouts, period])

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
      {/* Summary Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="card">
          <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {summaryStats.totalWeeks}
          </div>
          <div className="text-sm text-gray-600 dark:text-gray-400 uppercase tracking-wide mt-1">
            Weeks Tracked
          </div>
        </div>
        <div className="card">
          <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {formatCurrencyShort(summaryStats.totalAllTime)}
          </div>
          <div className="text-sm text-gray-600 dark:text-gray-400 uppercase tracking-wide mt-1">
            Total Distributed
          </div>
        </div>
        <div className="card">
          <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {formatCurrencyShort(summaryStats.periodTotal)}
          </div>
          <div className="text-sm text-gray-600 dark:text-gray-400 uppercase tracking-wide mt-1">
            Period Total
          </div>
        </div>
        <div className="card">
          <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {summaryStats.activeMembers}
          </div>
          <div className="text-sm text-gray-600 dark:text-gray-400 uppercase tracking-wide mt-1">
            Active Members
          </div>
        </div>
      </div>

      {/* Compare Weeks Toggle */}
      {payoutWeeks.length >= 2 && (
        <div className="flex justify-end">
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
            {compareMode ? 'Exit Compare Mode' : 'Compare Weeks'}
          </button>
        </div>
      )}

      {/* Compare Weeks Section */}
      {compareMode && (
        <div className="card">
          <h3 className="text-lg font-semibold mb-4">Compare Weeks</h3>
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

      {/* My Payouts Section */}
      {myPayouts.length > 0 && (
        <div className="card border-2 border-blue-200 dark:border-blue-700">
          <h2 className="text-xl font-semibold mb-4">My Payouts</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
            <div>
              <div className="text-sm text-gray-600 dark:text-gray-400">Total Earned</div>
              <div className="text-2xl font-bold text-blue-600">
                {formatCurrencyShort(myPayouts.reduce((sum, p) => sum + (p.payout || 0), 0))}
              </div>
            </div>
            <div>
              <div className="text-sm text-gray-600 dark:text-gray-400">Weeks Active</div>
              <div className="text-2xl font-bold">{myPayouts.length}</div>
            </div>
            <div>
              <div className="text-sm text-gray-600 dark:text-gray-400">Average/Week</div>
              <div className="text-2xl font-bold">
                {formatCurrencyShort(myPayouts.reduce((sum, p) => sum + (p.payout || 0), 0) / myPayouts.length)}
              </div>
            </div>
            <div>
              <div className="text-sm text-gray-600 dark:text-gray-400">Last Payout</div>
              <div className="text-2xl font-bold text-green-600">
                {formatCurrencyShort(myPayouts[0]?.payout || 0)}
              </div>
            </div>
          </div>
          
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-gray-200 dark:border-slate-700">
                <tr className="text-left">
                  <th className="py-2 px-2 text-xs font-semibold">Week</th>
                  <th className="py-2 px-2 text-xs font-semibold">Tier</th>
                  <th className="py-2 px-2 text-xs font-semibold">Time</th>
                  <th className="py-2 px-2 text-xs font-semibold">Tickets</th>
                  <th className="py-2 px-2 text-xs font-semibold">Payout</th>
                  {isLeadership && <th className="py-2 px-2 text-xs font-semibold">Theoretical</th>}
                  {isLeadership && <th className="py-2 px-2 text-xs font-semibold">Difference</th>}
                  <th className="py-2 px-2 text-xs font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {myPayouts.slice(0, 10).map((payout) => {
                  const diff = (payout.payout || 0) - (payout.theoretical_payout || 0)
                  return (
                    <tr key={`${payout.week_id}-${payout.member_id}`} className="border-b border-gray-100 dark:border-slate-800">
                      <td className="py-2 px-2 text-xs">{payout.week_start} - {payout.week_end}</td>
                      <td className="py-2 px-2"><TierBadge tier={payout.tier} /></td>
                      <td className="py-2 px-2 text-xs">{formatTimeHours(payout.time_spent || 0)}</td>
                      <td className="py-2 px-2 text-xs">
                        {payout.adjusted_tickets?.toFixed(1) || payout.base_tickets || 0}
                      </td>
                      <td className="py-2 px-2 text-xs font-semibold text-blue-600">
                        {formatCurrency(payout.payout || 0)}
                      </td>
                      {isLeadership && (
                        <td className="py-2 px-2 text-xs text-gray-600 dark:text-gray-400">
                          {formatCurrency(payout.theoretical_payout || 0)}
                        </td>
                      )}
                      {isLeadership && (
                        <td className="py-2 px-2 text-xs">
                          <span className={diff >= 0 ? 'text-green-600' : 'text-red-600'}>
                            {diff >= 0 ? '+' : ''}{formatCurrency(diff)}
                          </span>
                        </td>
                      )}
                      <td className="py-2 px-2 text-xs">
                        <button
                          onClick={() => loadMemberCrimes(payout.member_id, payout.week_start, payout.week_end)}
                          className="text-blue-600 hover:underline"
                        >
                          View Crimes
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="card">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <h2 className="text-xl font-semibold">Payout History</h2>
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
            <select 
              value={sortBy} 
              onChange={(e) => setSortBy(e.target.value)} 
              className="input"
            >
              <option value="total">Sort by Total</option>
              <option value="recent">Sort by Recent</option>
              <option value="avg">Sort by Average</option>
            </select>
          </div>
        </div>
      </div>

      {/* Week-by-Week View */}
      <div className="card">
        <h3 className="font-semibold mb-4">Weekly Breakdown</h3>
        <div className="space-y-2">
          {payoutWeeks.slice(0, parseInt(period) || 20).map((week) => (
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
          members={weekMembers}
          loading={loadingWeekDetails}
          onClose={() => setSelectedWeek(null)}
          onMemberClick={(memberId, weekStart, weekEnd) => loadMemberCrimes(memberId, weekStart, weekEnd)}
          isLeadership={isLeadership}
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

      {/* All Members Leaderboard */}
      <div className="card">
        <h3 className="font-semibold mb-4">Member Leaderboard (Period)</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b-2 border-gray-200 dark:border-slate-700">
              <tr className="text-left">
                <th className="py-2 px-2 text-xs font-semibold">#</th>
                <th className="py-2 px-2 text-xs font-semibold">Member</th>
                <th className="py-2 px-2 text-xs font-semibold">Tier</th>
                <th className="py-2 px-2 text-xs font-semibold">Weeks</th>
                <th className="py-2 px-2 text-xs font-semibold">Total Payout</th>
                <th className="py-2 px-2 text-xs font-semibold">Avg/Week</th>
                {isLeadership && <th className="py-2 px-2 text-xs font-semibold">Theoretical</th>}
                {isLeadership && <th className="py-2 px-2 text-xs font-semibold">Diff</th>}
              </tr>
            </thead>
            <tbody>
              {aggregatedPayouts.slice(0, 20).map((member, idx) => {
                const diff = member.totalPayout - member.totalTheoretical
                const isCurrentUser = member.memberId === user?.id?.toString()
                return (
                  <tr 
                    key={member.memberId} 
                    className={`border-b border-gray-100 dark:border-slate-800 ${
                      isCurrentUser ? 'bg-blue-50 dark:bg-blue-900/20' : ''
                    }`}
                  >
                    <td className="py-2 px-2 text-xs font-semibold">{idx + 1}</td>
                    <td className="py-2 px-2 text-xs font-medium">
                      {member.name}
                      {isCurrentUser && <span className="ml-1 text-blue-600">(You)</span>}
                    </td>
                    <td className="py-2 px-2"><TierBadge tier={member.tier} /></td>
                    <td className="py-2 px-2 text-xs">{member.weeksActive}</td>
                    <td className="py-2 px-2 text-xs font-semibold text-blue-600">
                      {formatCurrencyShort(member.totalPayout)}
                    </td>
                    <td className="py-2 px-2 text-xs">{formatCurrencyShort(member.avgPayout)}</td>
                    {isLeadership && (
                      <td className="py-2 px-2 text-xs text-gray-600">
                        {formatCurrencyShort(member.totalTheoretical)}
                      </td>
                    )}
                    {isLeadership && (
                      <td className="py-2 px-2 text-xs">
                        <span className={diff >= 0 ? 'text-green-600' : 'text-red-600'}>
                          {diff >= 0 ? '+' : ''}{formatCurrencyShort(diff)}
                        </span>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function TierBadge({ tier }) {
  const colors = {1:'bg-tier-1',2:'bg-tier-2',3:'bg-tier-3',4:'bg-tier-4',5:'bg-tier-5',6:'bg-tier-6'}
  return <span className={`inline-block px-2 py-1 rounded text-white font-semibold text-xs ${colors[tier]}`}>T{tier}</span>
}

function WeekDetailsModal({ weekId, members, loading, onClose, onMemberClick, isLeadership }) {
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

  return (
    <div className="modal-overlay">
      <div className="modal-dialog sm:max-w-4xl">
        <div className="flex-shrink-0 p-4 border-b border-gray-200 dark:border-slate-700 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold">Week Details</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {weekStart} - {weekEnd} | {members.length} members
            </p>
          </div>
          <button onClick={onClose} className="p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          <table className="w-full text-sm">
            <thead className="border-b-2 border-gray-200 dark:border-slate-700 sticky top-0 bg-white dark:bg-slate-800">
              <tr className="text-left">
                <th className="py-2 px-2 text-xs font-semibold">Member</th>
                <th className="py-2 px-2 text-xs font-semibold">Tier</th>
                <th className="py-2 px-2 text-xs font-semibold">Time</th>
                <th className="py-2 px-2 text-xs font-semibold">Tickets</th>
                <th className="py-2 px-2 text-xs font-semibold">Penalty</th>
                <th className="py-2 px-2 text-xs font-semibold">Share %</th>
                <th className="py-2 px-2 text-xs font-semibold">Payout</th>
                {isLeadership && <th className="py-2 px-2 text-xs font-semibold">Theoretical</th>}
                <th className="py-2 px-2 text-xs font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.member_id} className="border-b border-gray-100 dark:border-slate-800">
                  <td className="py-2 px-2 text-xs font-medium">{m.member_name}</td>
                  <td className="py-2 px-2"><TierBadge tier={m.tier} /></td>
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
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
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
                    <td className="py-2 px-2 text-xs">{(crime.member_cpr || 0).toFixed(1)}%</td>
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
  // Build a map of all members across both weeks
  const allMembers = new Map()

  for (const m of weekA) {
    allMembers.set(m.member_id, {
      name: m.member_name,
      a: m,
      b: null,
    })
  }
  for (const m of weekB) {
    if (allMembers.has(m.member_id)) {
      allMembers.get(m.member_id).b = m
    } else {
      allMembers.set(m.member_id, {
        name: m.member_name,
        a: null,
        b: m,
      })
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