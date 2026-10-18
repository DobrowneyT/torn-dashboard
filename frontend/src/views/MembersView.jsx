import { useState, useEffect, useMemo } from 'react'
import { useViewState } from '../contexts/ViewStateContext'
import { useFactionConfig } from '../contexts/FactionConfigContext'
import { apiGet, apiPost } from '../utils/apiClient'
import { filterItemsForMember } from '../utils/payoutDataLoader'
import { formatCurrency } from '../utils/payoutCalculations'
import { X } from 'lucide-react'
import { config } from '../config'
import InfoTooltip from '../components/InfoTooltip'
import TruncatedText from '../components/TruncatedText'
import SortableTh, { useTableSort } from '../components/SortableTh.jsx'
import { sortRows } from '../utils/tableSort.js'

/**
 * Column configs for the four tables in this file (#837, epic #803).
 *
 * ⚠️ Three of them had NO sorting at all — the per-member crime history, the
 * weekly payout history and the loaned-items list. They are the tables somebody
 * opens to answer "when did this happen" and "how much", and neither question
 * could be reordered.
 */
/**
 * The roster itself. Three columns, two of which sort — Actions deliberately
 * does not.
 *
 * ⚠️ `id` was coerced with `parseInt(aVal) || 0`, which collapses a real zero
 * and a missing id into the same value. It is a plain number column now.
 */
export const ROSTER_COLUMNS = [
  { key: 'name',   kind: 'text',   accessor: (m) => m.name },
  { key: 'id',     kind: 'number', accessor: (m) => m.id },
  { key: 'tier',   kind: 'number', accessor: (m) => m.tier },
  { key: 'avgCpr', kind: 'number', accessor: (m) => m.avgCpr },
]

export const MEMBER_CRIME_COLUMNS = [
  { key: 'crime',    label: 'Crime',    kind: 'text',   accessor: (c) => c.name },
  { key: 'level',    label: 'Level',    kind: 'number', accessor: (c) => c.difficulty },
  { key: 'status',   label: 'Status',   kind: 'text',   accessor: (c) => c.status },
  { key: 'position', label: 'Position', kind: 'text',   accessor: (c) => c.position },
  { key: 'cpr',      label: 'CPR',      kind: 'number', accessor: (c) => c.cpr },
  // ⚠️ Sorts on what the cell SHOWS: a failed crime renders "-" but may still
  // carry rewards_money, and would otherwise outrank a successful one.
  { key: 'reward',   label: 'Reward',   kind: 'number', accessor: (c) => (c.status === 'Successful' ? c.rewards_money : 0) },
  // ⚠️ NUMBER, not date — this renders `new Date(executed_at * 1000)`, so the
  // value is epoch seconds and parseDbTime would reject it.
  { key: 'executed', label: 'Executed', kind: 'number', accessor: (c) => c.executed_at },
]

export const MEMBER_PAYOUT_COLUMNS = [
  // ⚠️ The Week cell renders a date RANGE; sorting it as text would order by
  // the rendered string. `week_start` is the value that means "which week".
  { key: 'week',        label: 'Week',        kind: 'number', accessor: (p) => p.week_start },
  { key: 'tier',        label: 'Tier',        kind: 'number', accessor: (p) => p.tier },
  { key: 'crimes',      label: 'Crimes',      kind: 'number', accessor: (p) => p.crimes_count },
  { key: 'time',        label: 'Time',        kind: 'number', accessor: (p) => p.time_spent },
  { key: 'payout',      label: 'Payout',      kind: 'number', accessor: (p) => p.payout },
  { key: 'theoretical', label: 'Theoretical', kind: 'number', accessor: (p) => p.theoretical_payout },
  // ⚠️ Can be negative. No `|| 0` coercion anywhere near this one — that is
  // what collapses a real negative into zero.
  { key: 'diff',        label: 'Diff',        kind: 'number', accessor: (p) => (p.payout ?? 0) - (p.theoretical_payout ?? 0) },
]

/** The order the loaned-items list opened in before it was sortable. */
const CATEGORY_ORDER = { armor: 0, weapons: 1, temporary: 2, utilities: 3, medical: 4, drugs: 5, caches: 6, cesium: 7 }

export const LOANED_ITEM_COLUMNS = [
  { key: 'item',   label: 'Item',         kind: 'text',   accessor: (i) => i.item_name || i.name },
  // ⚠️ Sorts by the CATEGORY ORDER, not alphabetically. Armour before weapons
  // before temporaries is how the list has always read; alphabetical would put
  // caches first and scatter the gear somebody is looking for.
  { key: 'type',   label: 'Type',         kind: 'number', accessor: (i) => CATEGORY_ORDER[i.category] ?? 99 },
  { key: 'qty',    label: 'Qty Loaned',   kind: 'number', accessor: (i) => i.loaned_to_member || 1 },
  { key: 'value',  label: 'Market Value', kind: 'number', accessor: (i) => i.market_value },
  { key: 'total',  label: 'Total Value',  kind: 'number', accessor: (i) => (i.market_value || 0) * (i.loaned_to_member || 1) },
]
export default function MembersView({ isLeadership }) {
  const [persistedState, setPersistedState] = useViewState('members')
  // Tiered factions get the tier badge/filter/distribution; non-tiered
  // (flat-weighted / equal) factions get a CPR column instead (#251).
  const { usesTiers } = useFactionConfig()

  const [searchTerm, setSearchTerm] = useState(persistedState.searchTerm || '')
  const [tierFilter, setTierFilter] = useState(persistedState.tierFilter || 'all')
  const [sortConfig, setSortConfig] = useState(
    persistedState.sortConfig || { key: 'tier', direction: 'desc' }
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
  const [showCpr, setShowCpr] = useState(false)
  const [memberCprData, setMemberCprData] = useState([])
  const [expandedTier, setExpandedTier] = useState(null)

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

      // The API pre-joins CPR averages server-side.
      const { members: rows } = await apiGet('/api/members')
      const formattedMembers = rows.map(m => ({
        id: m.member_id,
        name: m.member_name,
        tier: m.tier,
        hasOverride: m.tier_override !== null,
        lastScraped: m.last_scraped,
        avgCpr: m.avg_cpr,
        roleCount: m.role_count
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
    setSyncing(true)
    setSyncMessage(null)

    try {
      // Triggers the members-sync scraper job server-side (leadership-gated) —
      // the same job the scheduler runs, no raw key in the browser.
      const { run } = await apiPost('/api/sync/members', {})
      if (run?.status === 'success') {
        setSyncMessage({ type: 'success', text: `Synced current faction members${run.rows != null ? ` — ${run.rows} rows` : ''}.` })
        await fetchMembers()
      } else {
        setSyncMessage({ type: 'error', text: run?.error || 'Member sync failed' })
      }
    } catch (error) {
      setSyncMessage({ type: 'error', text: error.message })
    } finally {
      setSyncing(false)
    }
  }

  const tierDistribution = useMemo(() => {
    const dist = {}
    members.forEach(m => {
      const tier = m.tier ?? 0
      if (!dist[tier]) dist[tier] = []
      dist[tier].push(m)
    })
    return dist
  }, [members])

  const filteredMembers = useMemo(() => {
    let filtered = [...members]

    if (searchTerm) {
      filtered = filtered.filter(m =>
        m.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        m.id.toString().includes(searchTerm)
      )
    }

    if (usesTiers && tierFilter !== 'all') {
      filtered = filtered.filter(m => m.tier === parseInt(tierFilter))
    }

    // In non-tiered mode the tier column becomes CPR, so a 'tier' sort is
    // meaningless — sort by average CPR instead.
    // ⚠️ In non-tiered mode the tier column becomes CPR, so a 'tier' sort is
    // meaningless — sort by average CPR instead. This remap is not incidental.
    const sortKey = (!usesTiers && sortConfig.key === 'tier') ? 'avgCpr' : sortConfig.key
    return sortRows(filtered, ROSTER_COLUMNS, sortKey, sortConfig.direction,
                    { tieBreak: 'name' })
  }, [members, searchTerm, tierFilter, sortConfig, usesTiers])

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
    setShowCpr(false)
    setLoadingDetails(true)

    try {
      // Server merges the member's slot into each crime row.
      const { crimes } = await apiGet(`/api/members/${memberId}/crimes`)
      setMemberCrimes(crimes.map(crime => ({
        ...crime,
        position: crime.member_position,
        cpr: crime.member_cpr,
        joined_at: crime.member_joined_at
      })))
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
    setShowCpr(false)
    setLoadingDetails(true)

    try {
      const { payouts } = await apiGet(`/api/members/${memberId}/payouts`)
      setMemberPayouts(payouts)
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
    setShowCpr(false)
    setLoadingDetails(true)

    try {
      const { items } = await apiGet('/api/inventory/loaned')
      setMemberLoanedItems(filterItemsForMember(items, memberId))
    } catch (error) {
      console.error('Error loading loaned items:', error)
      setMemberLoanedItems([])
    } finally {
      setLoadingDetails(false)
    }
  }

  async function handleViewCpr(memberId, memberName) {
    setSelectedMember({ id: memberId, name: memberName })
    setShowCpr(true)
    setShowCrimes(false)
    setShowPayouts(false)
    setShowLoanedItems(false)
    setLoadingDetails(true)

    try {
      const { cpr } = await apiGet(`/api/members/${memberId}/cpr`)
      setMemberCprData(cpr)
    } catch (error) {
      console.error('Error loading CPR data:', error)
      setMemberCprData([])
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
      {usesTiers && !loading && members.length > 0 && (
        <div className="card mb-4">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Tier Distribution</h3>
          <div className="flex flex-wrap gap-2">
            {[0, 1, 2, 3, 4, 5, 6].map(tier => {
              const tierMembers = tierDistribution[tier] || []
              if (tierMembers.length === 0) return null
              const isExpanded = expandedTier === tier
              const tierColorClass = tier === 0 ? 'bg-tier-review' : `bg-tier-${tier}`
              return (
                <button
                  key={tier}
                  onClick={() => setExpandedTier(isExpanded ? null : tier)}
                  className={`px-4 py-2 rounded-lg text-white font-semibold text-sm cursor-pointer hover:opacity-90 transition-opacity flex items-center gap-2 ${tierColorClass}`}
                >
                  <span>{tier === 0 ? 'Review' : `T${tier}`}</span>
                  <span className="text-lg font-bold leading-none">{tierMembers.length}</span>
                  <span className="text-xs opacity-75">{isExpanded ? '▲' : '▼'}</span>
                </button>
              )
            })}
          </div>

          {expandedTier !== null && tierDistribution[expandedTier] && (
            <div className="mt-3 p-3 bg-gray-50 dark:bg-slate-700/50 rounded-lg">
              <div className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2">
                {expandedTier === 0 ? 'Needs Manual Review' : `Tier ${expandedTier}`} — {tierDistribution[expandedTier].length} members
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {[...tierDistribution[expandedTier]]
                  .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
                  .map(m => (
                    <a
                      key={m.id}
                      href={`https://www.torn.com/profiles.php?XID=${m.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
                    >
                      {m.name} [{m.id}]
                    </a>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="card">
        <div className="mb-4 flex flex-col sm:flex-row gap-2 sm:gap-4">
          <input
            type="text"
            placeholder="Search by name or ID..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="flex-1 px-4 py-2 border border-gray-300 dark:border-slate-600 rounded-lg focus:ring-2 focus:ring-blue-500 dark:bg-slate-700 dark:text-white"
          />

          {usesTiers && (
            <select
              value={tierFilter}
              onChange={(e) => setTierFilter(e.target.value)}
              className="px-4 py-2 border border-gray-300 dark:border-slate-600 rounded-lg focus:ring-2 focus:ring-blue-500 dark:bg-slate-700 dark:text-white"
            >
              <option value="all">All Tiers</option>
              <option value="0">Tier 0 – Review</option>
              <option value="1">Tier 1</option>
              <option value="2">Tier 2</option>
              <option value="3">Tier 3</option>
              <option value="4">Tier 4</option>
              <option value="5">Tier 5</option>
              <option value="6">Tier 6</option>
            </select>
          )}

          {isLeadership && (
            <button
              onClick={handleSyncMembers}
              disabled={syncing}
              className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm whitespace-nowrap"
            >
              {syncing ? 'Fetching…' : 'Fetch Members'}
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
                  onClick={() => handleSort(usesTiers ? 'tier' : 'avgCpr')}
                >
                  <div className="flex items-center gap-2">
                    {usesTiers ? 'Tier' : 'CPR'}
                    {sortConfig.key === (usesTiers ? 'tier' : 'avgCpr') && (
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
                      <button
                        onClick={() => handleViewCpr(member.id, member.name)}
                        aria-label="View CPR data"
                        className="cursor-pointer hover:opacity-80 transition-opacity"
                      >
                        {usesTiers
                          ? <TierBadge tier={member.tier} override={member.hasOverride} />
                          : <CprBadge />}
                      </button>
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
          isLeadership={isLeadership}
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

      {/* CPR Modal */}
      {showCpr && (
        <CprModal
          member={selectedMember}
          cprData={memberCprData}
          loading={loadingDetails}
          onClose={() => setShowCpr(false)}
        />
      )}
    </>
  )
}

// Non-tiered factions (#251) get a plain "CPR" badge here instead of a tier.
// Clicking still opens the per-crime CPR drill-down.
function CprBadge() {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-blue-600 text-white font-semibold text-xs">
      CPR
    </span>
  )
}

function TierBadge({ tier, override }) {
  const colors = {
    0: 'bg-tier-review',
    1: 'bg-tier-1',
    2: 'bg-tier-2',
    3: 'bg-tier-3',
    4: 'bg-tier-4',
    5: 'bg-tier-5',
    6: 'bg-tier-6'
  }
  const label = tier === 0 ? 'Review' : `T${tier}`

  return (
    <span className={`inline-flex items-center gap-1 px-2 py-1 rounded text-white font-semibold text-xs ${colors[tier] ?? 'bg-tier-review'}`}>
      {label}
      {override && (
        <InfoTooltip wrap label={<span>*</span>}>Tier override</InfoTooltip>
      )}
    </span>
  )
}

function CrimesModal({ member, crimes, loading, onClose }) {
  // ⚠️ Newest first: this table answers "what did they just do".
  const { sorted: sortedCrimes, sortCol, sortDir, onSort } =
    useTableSort(crimes ?? [], MEMBER_CRIME_COLUMNS, {
      initialCol: 'executed', initialDir: 'desc', tieBreak: 'crime',
    })

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
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal-dialog sm:max-w-4xl">
        <div className="flex-shrink-0 p-4 border-b border-gray-200 dark:border-slate-700 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold">Crimes - {member.name}</h3>
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
            <p className="text-center text-gray-500 py-8">No crimes found</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b-2 border-gray-200 dark:border-slate-700 sticky top-0 bg-white dark:bg-slate-800">
                <tr className="text-left">
                  {MEMBER_CRIME_COLUMNS.map(c => (
                    <SortableTh key={c.key} col={c} sortCol={sortCol} sortDir={sortDir}
                                onSort={onSort} label={c.label}
                                className="py-2 px-2 text-xs font-semibold">{c.label}</SortableTh>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedCrimes.map((crime) => (
                  <tr key={crime.crime_id} className="border-b border-gray-100 dark:border-slate-800">
                    <td className="py-2 px-2 text-xs font-medium">{crime.name}</td>
                    <td className="py-2 px-2 text-xs">{crime.difficulty}</td>
                    <td className="py-2 px-2 text-xs">
                      <StatusBadge status={crime.status} />
                    </td>
                    <td className="py-2 px-2 text-xs">{crime.position}</td>
                    <td className="py-2 px-2 text-xs">{Math.round(crime.cpr || 0)}</td>
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

function PayoutsModal({ member, payouts, loading, onClose, isLeadership }) {
  // ⚠️ Most recent week first, which is how this list already read.
  const { sorted: sortedPayouts, sortCol, sortDir, onSort } =
    useTableSort(payouts ?? [], MEMBER_PAYOUT_COLUMNS, {
      initialCol: 'week', initialDir: 'desc', tieBreak: 'week',
    })

  if (loading) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-white dark:bg-slate-800 rounded-lg p-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        </div>
      </div>
    )
  }

  const totalPayout = payouts.reduce((sum, p) => sum + (p.payout || 0), 0)
  const totalTheoretical = payouts.reduce((sum, p) => sum + (p.theoretical_payout || 0), 0)

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal-dialog sm:max-w-4xl">
        <div className="flex-shrink-0 p-4 border-b border-gray-200 dark:border-slate-700 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold">Payouts - {member.name}</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {payouts.length} payout weeks | Total: {formatCurrency(totalPayout)}
            </p>
          </div>
          <button onClick={onClose} className="p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {payouts.length === 0 ? (
            <p className="text-center text-gray-500 py-8">No payouts found</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b-2 border-gray-200 dark:border-slate-700 sticky top-0 bg-white dark:bg-slate-800">
                <tr className="text-left">
                  {MEMBER_PAYOUT_COLUMNS
                    // ⚠️ Theoretical and Diff are leadership-only; the header
                    // set has to follow the same rule as the cells or the
                    // columns shift under a non-leader.
                    .filter(c => isLeadership || (c.key !== 'theoretical' && c.key !== 'diff'))
                    .map(c => (
                      <SortableTh key={c.key} col={c} sortCol={sortCol} sortDir={sortDir}
                                  onSort={onSort} label={c.label}
                                  className="py-2 px-2 text-xs font-semibold">{c.label}</SortableTh>
                    ))}
                </tr>
              </thead>
              <tbody>
                {sortedPayouts.map((payout) => {
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
                      {isLeadership && (
                        <td className="py-2 px-2 text-xs text-gray-600">
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
                    </tr>
                  )
                })}
              </tbody>
              <tfoot className="border-t-2 border-gray-300 dark:border-slate-600">
                <tr className="font-bold">
                  <td colSpan="4" className="py-2 px-2 text-right text-xs">TOTAL:</td>
                  <td className="py-2 px-2 text-xs text-blue-600">{formatCurrency(totalPayout)}</td>
                  {isLeadership && (
                    <td className="py-2 px-2 text-xs text-gray-600">{formatCurrency(totalTheoretical)}</td>
                  )}
                  {isLeadership && (
                    <td className="py-2 px-2 text-xs">
                      <span className={(totalPayout - totalTheoretical) >= 0 ? 'text-green-600' : 'text-red-600'}>
                        {(totalPayout - totalTheoretical) >= 0 ? '+' : ''}{formatCurrency(totalPayout - totalTheoretical)}
                      </span>
                    </td>
                  )}
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
  // ⚠️ Called BEFORE the early return below. A hook after a conditional
  // return changes the hook count when the condition flips, and React throws
  // "Rendered more hooks than during the previous render".
  // ⚠️ Opens in category order then name — exactly as it did before it was
  // sortable. `type` carries the category order as its sort value, so that
  // default is reachable again after sorting by something else.
  const { sorted, sortCol, sortDir, onSort } = useTableSort(items ?? [], LOANED_ITEM_COLUMNS, {
    initialCol: 'type', initialDir: 'asc', tieBreak: 'item',
  })

  if (loading) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-white dark:bg-slate-800 rounded-lg p-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        </div>
      </div>
    )
  }

  const totalValue = sorted.reduce((sum, item) => sum + ((item.market_value || 0) * (item.loaned_to_member || 1)), 0)

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal-dialog sm:max-w-3xl">
        <div className="flex-shrink-0 p-4 border-b border-gray-200 dark:border-slate-700 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold">Items Loaned - {member.name}</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {sorted.length} item{sorted.length !== 1 ? 's' : ''} loaned
              {totalValue > 0 && ` | Total value: ${formatCurrency(totalValue)}`}
            </p>
          </div>
          <button onClick={onClose} className="p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {sorted.length === 0 ? (
            <p className="text-center text-gray-500 py-8">No items currently loaned to this member</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b-2 border-gray-200 dark:border-slate-700 sticky top-0 bg-white dark:bg-slate-800">
                <tr className="text-left">
                  {LOANED_ITEM_COLUMNS.map(c => (
                    <SortableTh key={c.key} col={c} sortCol={sortCol} sortDir={sortDir}
                                onSort={onSort} label={c.label}
                                className="py-2 px-2 text-xs font-semibold">{c.label}</SortableTh>
                  ))}
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

function CprModal({ member, cprData, loading, onClose }) {
  if (loading) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-white dark:bg-slate-800 rounded-lg p-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        </div>
      </div>
    )
  }

  // CPR requirements lookup from config (crime -> position -> threshold)
  const cprReqs = config.cprRequirements

  // Group rows by crime name, showing all positions individually
  const byCrime = {}
  for (const row of cprData) {
    const name = row.crime_name
    if (!byCrime[name]) byCrime[name] = { difficulty: row.difficulty, positions: [] }
    byCrime[name].positions.push(row)
  }
  // Sort crimes by difficulty descending, then by name
  const crimeNames = Object.keys(byCrime).sort((a, b) => {
    const diff = (byCrime[b].difficulty || 0) - (byCrime[a].difficulty || 0)
    return diff !== 0 ? diff : a.localeCompare(b)
  })

  const totalRoles = crimeNames.reduce((sum, name) => sum + byCrime[name].positions.length, 0)
  const uniqueCrimes = crimeNames.length
  const allValues = crimeNames.flatMap(name => byCrime[name].positions.map(r => parseFloat(r.cpr_value)))
  const avgCpr = allValues.length > 0
    ? Math.round(allValues.reduce((s, v) => s + v, 0) / allValues.length)
    : null

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal-dialog sm:max-w-lg">
        <div className="flex-shrink-0 p-4 border-b border-gray-200 dark:border-slate-700 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold">{member.name} — CPR Data</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {totalRoles} roles across {uniqueCrimes} crime{uniqueCrimes !== 1 ? 's' : ''}
              {avgCpr !== null && ` · Avg ${avgCpr}`}
            </p>
          </div>
          <button onClick={onClose} className="p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {crimeNames.length === 0 ? (
            <p className="text-center text-gray-500 dark:text-gray-400 py-8">No CPR data available</p>
          ) : (
            <div className="divide-y divide-gray-100 dark:divide-slate-700">
              {crimeNames.map(crimeName => {
                const { difficulty, positions } = byCrime[crimeName]
                const sortedPositions = [...positions].sort((a, b) => a.position_label.localeCompare(b.position_label))
                const crimeAvg = Math.round(sortedPositions.reduce((s, r) => s + parseFloat(r.cpr_value), 0) / sortedPositions.length)
                return (
                  <div key={crimeName}>
                    <div className="px-4 py-2 bg-gray-50 dark:bg-slate-700/50 flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="inline-flex items-center justify-center px-1.5 py-0.5 rounded text-xs font-bold bg-gray-200 dark:bg-slate-600 text-gray-700 dark:text-gray-300 flex-shrink-0">
                          Lv{difficulty}
                        </span>
                        <span className="text-xs font-bold text-gray-700 dark:text-gray-300 truncate">
                          {crimeName}
                        </span>
                      </div>
                      <span className="text-xs text-gray-500 dark:text-gray-400 flex-shrink-0">
                        avg {crimeAvg} · {sortedPositions.length} role{sortedPositions.length !== 1 ? 's' : ''}
                      </span>
                    </div>
                    <div className="px-4 py-1">
                      {sortedPositions.map(row => {
                        const val = parseFloat(row.cpr_value)
                        const barWidth = Math.min(val, 100)
                        const threshold = cprReqs[crimeName]?.positions?.[row.position_label]
                        const barColor = threshold !== undefined
                          ? (val >= threshold ? 'bg-green-500' : val >= threshold * 0.75 ? 'bg-yellow-500' : val >= threshold * 0.5 ? 'bg-orange-500' : 'bg-red-500')
                          : (val >= 75 ? 'bg-green-500' : val >= 50 ? 'bg-yellow-500' : val >= 25 ? 'bg-orange-500' : 'bg-red-500')
                        return (
                          <div key={row.position_label} className="flex items-center gap-3 py-1.5">
                            <TruncatedText text={row.position_label} className="text-xs text-gray-700 dark:text-gray-300 w-32 shrink-0" />
                            <div className="flex-1 bg-gray-100 dark:bg-slate-600 rounded-full h-2">
                              <div
                                className={`h-2 rounded-full ${barColor}`}
                                style={{ width: `${barWidth}%` }}
                              />
                            </div>
                            <span className="text-xs font-mono font-semibold text-gray-800 dark:text-gray-200 w-8 text-right shrink-0">
                              {Math.round(val)}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
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
