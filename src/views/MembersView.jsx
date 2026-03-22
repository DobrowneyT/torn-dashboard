import { useState, useEffect, useMemo } from 'react'
import { useViewState } from '../contexts/ViewStateContext'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../utils/supabase'
import { formatCurrency } from '../utils/payoutCalculations'
import { syncMembersFromAPI } from '../utils/syncMembersFromAPI'
import { loadMemberLoanedItems } from '../utils/payoutDataLoader'
export default function MembersView({ isLeadership }) {
  const [persistedState, setPersistedState] = useViewState('members')
  const { user } = useAuth()

  const [searchTerm, setSearchTerm] = useState(persistedState.searchTerm || '')
  const [tierFilter, setTierFilter] = useState(persistedState.tierFilter || 'all')
  const [sortConfig, setSortConfig] = useState(
    persistedState.sortConfig || { key: 'tier', direction: 'asc' }
  )
  const [members, setMembers] = useState([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [syncMessage, setSyncMessage] = useState(null)
  const [selectedMember, setSelectedMember] = useState(null)
  const [memberCrimes, setMemberCrimes] = useState([])
  const [memberPayouts, setMemberPayouts] = useState([])
  const [memberLoanedItems, setMemberLoanedItems] = useState([])
  const [loadingDetails, setLoadingDetails] = useState(false)
  const [showCrimes, setShowCrimes] = useState(false)
  const [showPayouts, setShowPayouts] = useState(false)
  const [showLoanedItems, setShowLoanedItems] = useState(false)

  useEffect(() => {
    setPersistedState({
      searchTerm,
      tierFilter,
      sortConfig
    })
  }, [searchTerm, tierFilter, sortConfig, setPersistedState])

  useEffect(() => {
    fetchMembers()
  }, [])

  async function fetchMembers() {
    try {
      setLoading(true)

      // Get current members with their basic info
      const { data, error } = await supabase
        .from('members')
        .select('member_id, member_name, tier, tier_override, last_scraped')
        .eq('is_current', true)

      if (error) {
        console.error('Supabase error:', error)
        throw error
      }

      // Get CPR averages
      const { data: cprData } = await supabase
        .from('member_cpr')
        .select('member_id, cpr_value')

      // Calculate average CPR per member
      const cprByMember = {}
      cprData?.forEach(record => {
        if (!cprByMember[record.member_id]) {
          cprByMember[record.member_id] = []
        }
        cprByMember[record.member_id].push(record.cpr_value)
      })

      const formattedMembers = (data || []).map(m => ({
        id: m.member_id,
        name: m.member_name,
        tier: m.tier,
        hasOverride: m.tier_override !== null,
        lastScraped: m.last_scraped,
        avgCpr: cprByMember[m.member_id]
          ? cprByMember[m.member_id].reduce((a, b) => a + b, 0) / cprByMember[m.member_id].length
          : 0,
        roleCount: cprByMember[m.member_id]?.length || 0
      }))

      setMembers(formattedMembers)
    } catch (error) {
      console.error('Error fetching members:', error)
      setMembers([])
    } finally {
      setLoading(false)
    }
  }

  async function handleSyncMembers() {
    if (!user?.apiKey) {
      setSyncMessage({ type: 'error', text: 'No API key available. Please log in again.' })
      return
    }

    setSyncing(true)
    setSyncMessage(null)

    try {
      const result = await syncMembersFromAPI(user.apiKey)
      if (result.success) {
        setSyncMessage({ type: 'success', text: `Synced ${result.totalMembers} current faction members.` })
        // Reload members after sync
        await fetchMembers()
      } else {
        setSyncMessage({ type: 'error', text: result.error || 'Sync failed' })
      }
    } catch (error) {
      setSyncMessage({ type: 'error', text: error.message })
    } finally {
      setSyncing(false)
    }
  }

  const filteredMembers = useMemo(() => {
    let filtered = [...members]

    if (searchTerm) {
      filtered = filtered.filter(m =>
        m.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        m.id.toString().includes(searchTerm)
      )
    }

    if (tierFilter !== 'all') {
      filtered = filtered.filter(m => m.tier === parseInt(tierFilter))
    }

    return filtered.sort((a, b) => {
      let aVal = a[sortConfig.key]
      let bVal = b[sortConfig.key]

      if (sortConfig.key === 'name') {
        aVal = (aVal || '').toLowerCase()
        bVal = (bVal || '').toLowerCase()
      } else if (sortConfig.key === 'id') {
        aVal = parseInt(aVal) || 0
        bVal = parseInt(bVal) || 0
      }

      if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1
      if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1
      return 0
    })
  }, [members, searchTerm, tierFilter, sortConfig])

  const handleSort = (key) => {
    setSortConfig(prev => ({
      key,
      direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc'
    }))
  }

  async function handleViewCrimes(memberId, memberName) {
    setSelectedMember({ id: memberId, name: memberName })
    setShowCrimes(true)
    setShowPayouts(false)
    setShowLoanedItems(false)
    setLoadingDetails(true)

    try {
      // Get all crimes this member participated in
      const { data: slots, error } = await supabase
        .from('crime_slots')
        .select('crime_id, position, checkpoint_pass_rate, joined_at')
        .eq('user_id', memberId)
        .order('joined_at', { ascending: false })

      if (error) throw error

      // Get crime details
      const crimeIds = [...new Set(slots?.map(s => s.crime_id) || [])]

      if (crimeIds.length > 0) {
        const { data: crimes, error: crimesError } = await supabase
          .from('crimes')
          .select('crime_id, name, difficulty, status, executed_at, rewards_money')
          .in('crime_id', crimeIds)

        if (crimesError) throw crimesError

        // Combine slot and crime data
        const crimesWithSlots = crimes?.map(crime => {
          const slot = slots.find(s => s.crime_id === crime.crime_id)
          return {
            ...crime,
            position: slot?.position,
            cpr: slot?.checkpoint_pass_rate,
            joined_at: slot?.joined_at
          }
        }) || []

        setMemberCrimes(crimesWithSlots)
      } else {
        setMemberCrimes([])
      }
    } catch (error) {
      console.error('Error loading crimes:', error)
      setMemberCrimes([])
    } finally {
      setLoadingDetails(false)
    }
  }

  async function handleViewPayouts(memberId, memberName) {
    setSelectedMember({ id: memberId, name: memberName })
    setShowPayouts(true)
    setShowCrimes(false)
    setShowLoanedItems(false)
    setLoadingDetails(true)

    try {
      const { data, error } = await supabase
        .from('oc_payout_members')
        .select('week_id, week_start, week_end, tier, payout, theoretical_payout, time_spent, crimes_count')
        .eq('member_id', memberId)
        .order('week_end', { ascending: false })

      if (error) throw error
      setMemberPayouts(data || [])
    } catch (error) {
      console.error('Error loading payouts:', error)
      setMemberPayouts([])
    } finally {
      setLoadingDetails(false)
    }
  }

  async function handleViewLoanedItems(memberId, memberName) {
    setSelectedMember({ id: memberId, name: memberName })
    setShowLoanedItems(true)
    setShowCrimes(false)
    setShowPayouts(false)
    setLoadingDetails(true)

    try {
      const items = await loadMemberLoanedItems(memberId)
      setMemberLoanedItems(items)
    } catch (error) {
      console.error('Error loading loaned items:', error)
      setMemberLoanedItems([])
    } finally {
      setLoadingDetails(false)
    }
  }

  if (loading) {
    return (
      <div className="card">
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mr-3"></div>
          <p className="text-gray-600 dark:text-gray-400">Loading members...</p>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="card">
        <div className="mb-6 flex flex-col sm:flex-row gap-4">
          <input
            type="text"
            placeholder="Search by name or ID..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="flex-1 px-4 py-2 border border-gray-300 dark:border-slate-600 rounded-lg focus:ring-2 focus:ring-blue-500 dark:bg-slate-700 dark:text-white"
          />

          <select
            value={tierFilter}
            onChange={(e) => setTierFilter(e.target.value)}
            className="px-4 py-2 border border-gray-300 dark:border-slate-600 rounded-lg focus:ring-2 focus:ring-blue-500 dark:bg-slate-700 dark:text-white"
          >
            <option value="all">All Tiers</option>
            <option value="1">Tier 1</option>
            <option value="2">Tier 2</option>
            <option value="3">Tier 3</option>
            <option value="4">Tier 4</option>
            <option value="5">Tier 5</option>
            <option value="6">Tier 6</option>
          </select>

          {isLeadership && (
            <button
              onClick={handleSyncMembers}
              disabled={syncing}
              className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm whitespace-nowrap"
            >
              {syncing ? 'Syncing...' : 'Sync Members'}
            </button>
          )}
        </div>

        {syncMessage && (
          <div className={`mb-4 p-3 rounded-lg text-sm ${syncMessage.type === 'success' ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400' : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400'}`}>
            {syncMessage.text}
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="border-b-2 border-gray-200 dark:border-slate-700">
              <tr>
                <th
                  className="text-left py-3 px-4 cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-700"
                  onClick={() => handleSort('name')}
                >
                  <div className="flex items-center gap-2">
                    Member
                    {sortConfig.key === 'name' && (
                      <span>{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </div>
                </th>
                <th
                  className="text-left py-3 px-4 cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-700"
                  onClick={() => handleSort('tier')}
                >
                  <div className="flex items-center gap-2">
                    Tier
                    {sortConfig.key === 'tier' && (
                      <span>{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </div>
                </th>
                <th className="text-left py-3 px-4">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredMembers.length === 0 ? (
                <tr>
                  <td colSpan="3" className="text-center py-8 text-gray-500 dark:text-gray-400">
                    No members found
                  </td>
                </tr>
              ) : (
                filteredMembers.map((member) => (
                  <tr
                    key={member.id}
                    className="border-b border-gray-100 dark:border-slate-800 hover:bg-gray-50 dark:hover:bg-slate-700/50"
                  >
                    <td className="py-3 px-4">
                      <a
                        href={`https://www.torn.com/profiles.php?XID=${member.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
                      >
                        {member.name} [{member.id}]
                      </a>
                    </td>
                    <td className="py-3 px-4">
                      <TierBadge tier={member.tier} override={member.hasOverride} />
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex gap-2 flex-wrap">
                        <button
                          onClick={() => handleViewCrimes(member.id, member.name)}
                          className="text-sm px-2 py-1 bg-blue-100 text-blue-700 rounded hover:bg-blue-200 dark:bg-blue-900 dark:text-blue-300"
                        >
                          Crimes
                        </button>
                        <button
                          onClick={() => handleViewPayouts(member.id, member.name)}
                          className="text-sm px-2 py-1 bg-green-100 text-green-700 rounded hover:bg-green-200 dark:bg-green-900 dark:text-green-300"
                        >
                          OC Payouts
                        </button>
                        <button
                          onClick={() => handleViewLoanedItems(member.id, member.name)}
                          className="text-sm px-2 py-1 bg-purple-100 text-purple-700 rounded hover:bg-purple-200 dark:bg-purple-900 dark:text-purple-300"
                        >
                          Items Loaned
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="mt-4 text-sm text-gray-600 dark:text-gray-400">
          Showing {filteredMembers.length} of {members.length} current faction members
        </div>
      </div>

      {/* Crimes Modal */}
      {showCrimes && (
        <CrimesModal
          member={selectedMember}
          crimes={memberCrimes}
          loading={loadingDetails}
          onClose={() => setShowCrimes(false)}
        />
      )}

      {/* Payouts Modal */}
      {showPayouts && (
        <PayoutsModal
          member={selectedMember}
          payouts={memberPayouts}
          loading={loadingDetails}
          onClose={() => setShowPayouts(false)}
        />
      )}

      {/* Loaned Items Modal */}
      {showLoanedItems && (
        <LoanedItemsModal
          member={selectedMember}
          items={memberLoanedItems}
          loading={loadingDetails}
          onClose={() => setShowLoanedItems(false)}
        />
      )}
    </>
  )
}

function TierBadge({ tier, override }) {
  const colors = {
    1: 'bg-tier-1',
    2: 'bg-tier-2',
    3: 'bg-tier-3',
    4: 'bg-tier-4',
    5: 'bg-tier-5',
    6: 'bg-tier-6'
  }

  return (
    <span className={`inline-flex items-center gap-1 px-2 py-1 rounded text-white font-semibold text-xs ${colors[tier]}`}>
      T{tier}
      {override && <span title="Tier Override">*</span>}
    </span>
  )
}

function CrimesModal({ member, crimes, loading, onClose }) {
  if (loading) {
    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
        <div className="bg-white dark:bg-slate-800 rounded-lg p-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] overflow-hidden">
        <div className="p-4 border-b border-gray-200 dark:border-slate-700 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold">Crimes - {member.name}</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {crimes.length} crimes found
            </p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-4 overflow-y-auto max-h-[calc(90vh-120px)]">
          {crimes.length === 0 ? (
            <p className="text-center text-gray-500 py-8">No crimes found</p>
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
                    <td className="py-2 px-2 text-xs">{crime.position}</td>
                    <td className="py-2 px-2 text-xs">{(crime.cpr || 0).toFixed(1)}%</td>
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

function PayoutsModal({ member, payouts, loading, onClose }) {
  if (loading) {
    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
        <div className="bg-white dark:bg-slate-800 rounded-lg p-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        </div>
      </div>
    )
  }

  const totalPayout = payouts.reduce((sum, p) => sum + (p.payout || 0), 0)
  const totalTheoretical = payouts.reduce((sum, p) => sum + (p.theoretical_payout || 0), 0)

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] overflow-hidden">
        <div className="p-4 border-b border-gray-200 dark:border-slate-700 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold">Payouts - {member.name}</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {payouts.length} payout weeks | Total: {formatCurrency(totalPayout)}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-4 overflow-y-auto max-h-[calc(90vh-120px)]">
          {payouts.length === 0 ? (
            <p className="text-center text-gray-500 py-8">No payouts found</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b-2 border-gray-200 dark:border-slate-700 sticky top-0 bg-white dark:bg-slate-800">
                <tr className="text-left">
                  <th className="py-2 px-2 text-xs font-semibold">Week</th>
                  <th className="py-2 px-2 text-xs font-semibold">Tier</th>
                  <th className="py-2 px-2 text-xs font-semibold">Crimes</th>
                  <th className="py-2 px-2 text-xs font-semibold">Time</th>
                  <th className="py-2 px-2 text-xs font-semibold">Payout</th>
                  <th className="py-2 px-2 text-xs font-semibold">Theoretical</th>
                  <th className="py-2 px-2 text-xs font-semibold">Diff</th>
                </tr>
              </thead>
              <tbody>
                {payouts.map((payout) => {
                  const diff = (payout.payout || 0) - (payout.theoretical_payout || 0)
                  return (
                    <tr key={payout.week_id} className="border-b border-gray-100 dark:border-slate-800">
                      <td className="py-2 px-2 text-xs">
                        {payout.week_start} to {payout.week_end}
                      </td>
                      <td className="py-2 px-2">
                        <TierBadge tier={payout.tier} />
                      </td>
                      <td className="py-2 px-2 text-xs">{payout.crimes_count || 0}</td>
                      <td className="py-2 px-2 text-xs">
                        {((payout.time_spent || 0) / 3600).toFixed(1)}h
                      </td>
                      <td className="py-2 px-2 text-xs font-semibold text-blue-600">
                        {formatCurrency(payout.payout || 0)}
                      </td>
                      <td className="py-2 px-2 text-xs text-gray-600">
                        {formatCurrency(payout.theoretical_payout || 0)}
                      </td>
                      <td className="py-2 px-2 text-xs">
                        <span className={diff >= 0 ? 'text-green-600' : 'text-red-600'}>
                          {diff >= 0 ? '+' : ''}{formatCurrency(diff)}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot className="border-t-2 border-gray-300 dark:border-slate-600">
                <tr className="font-bold">
                  <td colSpan="4" className="py-2 px-2 text-right text-xs">TOTAL:</td>
                  <td className="py-2 px-2 text-xs text-blue-600">{formatCurrency(totalPayout)}</td>
                  <td className="py-2 px-2 text-xs text-gray-600">{formatCurrency(totalTheoretical)}</td>
                  <td className="py-2 px-2 text-xs">
                    <span className={(totalPayout - totalTheoretical) >= 0 ? 'text-green-600' : 'text-red-600'}>
                      {(totalPayout - totalTheoretical) >= 0 ? '+' : ''}{formatCurrency(totalPayout - totalTheoretical)}
                    </span>
                  </td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}

function LoanedItemsModal({ member, items, loading, onClose }) {
  if (loading) {
    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
        <div className="bg-white dark:bg-slate-800 rounded-lg p-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        </div>
      </div>
    )
  }

  const categoryOrder = { armor: 0, weapons: 1, temporary: 2, utilities: 3, medical: 4, drugs: 5, caches: 6, cesium: 7 }

  const sorted = [...items].sort((a, b) => {
    const catA = categoryOrder[a.category] ?? 99
    const catB = categoryOrder[b.category] ?? 99
    if (catA !== catB) return catA - catB
    return (a.item_name || a.name || '').localeCompare(b.item_name || b.name || '')
  })

  const totalValue = sorted.reduce((sum, item) => sum + ((item.market_value || 0) * (item.loaned_to_member || 1)), 0)

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl max-w-3xl w-full max-h-[90vh] overflow-hidden">
        <div className="p-4 border-b border-gray-200 dark:border-slate-700 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold">Items Loaned - {member.name}</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {sorted.length} item{sorted.length !== 1 ? 's' : ''} loaned
              {totalValue > 0 && ` | Total value: ${formatCurrency(totalValue)}`}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-4 overflow-y-auto max-h-[calc(90vh-120px)]">
          {sorted.length === 0 ? (
            <p className="text-center text-gray-500 py-8">No items currently loaned to this member</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b-2 border-gray-200 dark:border-slate-700 sticky top-0 bg-white dark:bg-slate-800">
                <tr className="text-left">
                  <th className="py-2 px-2 text-xs font-semibold">Item</th>
                  <th className="py-2 px-2 text-xs font-semibold">Type</th>
                  <th className="py-2 px-2 text-xs font-semibold">Qty Loaned</th>
                  <th className="py-2 px-2 text-xs font-semibold">Market Value</th>
                  <th className="py-2 px-2 text-xs font-semibold">Total Value</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((item, idx) => (
                  <tr key={item.item_id || idx} className="border-b border-gray-100 dark:border-slate-800">
                    <td className="py-2 px-2 text-xs font-medium">{item.item_name || item.name || `Item ${item.item_id}`}</td>
                    <td className="py-2 px-2 text-xs text-gray-500 capitalize">{item.category || '-'}</td>
                    <td className="py-2 px-2 text-xs">{item.loaned_to_member || 1}</td>
                    <td className="py-2 px-2 text-xs text-gray-600">
                      {formatCurrency(item.market_value || 0)}
                    </td>
                    <td className="py-2 px-2 text-xs font-semibold text-purple-600">
                      {formatCurrency((item.market_value || 0) * (item.loaned_to_member || 1))}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t-2 border-gray-300 dark:border-slate-600">
                <tr className="font-bold">
                  <td colSpan="4" className="py-2 px-2 text-right text-xs">TOTAL:</td>
                  <td className="py-2 px-2 text-xs text-purple-600">{formatCurrency(totalValue)}</td>
                </tr>
              </tfoot>
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
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${colors[status] || 'bg-gray-100 text-gray-800'}`}>
      {status}
    </span>
  )
}
