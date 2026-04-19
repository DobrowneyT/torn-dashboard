import { useState, useEffect, useMemo } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../utils/supabase'
import { loadWars, loadWarsCount, loadWarContributions } from '../utils/warDataLoader'
import { updateWarIsTermed } from '../utils/adminApi'
import { formatWarDateRange } from '../utils/warPayoutCalculations'
import { formatCurrency, formatCurrencyShort } from '../utils/payoutCalculations'

const OUR_FACTION_ID = 10739
const PAGE_SIZE = 10

export default function WarHistoryView({ isLeadership, isAdmin }) {
  const { user } = useAuth()

  const [wars, setWars] = useState([])
  const [totalWars, setTotalWars] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState(null)

  // Expanded row state
  const [expandedWarId, setExpandedWarId] = useState(null)
  const [contributions, setContributions] = useState({})
  const [loadingContributions, setLoadingContributions] = useState({})

  // Contributions table sort
  const [contribSort, setContribSort] = useState({})

  // My RW payout stats
  const [myWarPayouts, setMyWarPayouts] = useState([])

  function getContribSort(warId) {
    return contribSort[warId] || { col: 'score', dir: 'desc' }
  }

  function handleContribSort(warId, col) {
    setContribSort(prev => {
      const cur = prev[warId] || { col: 'score', dir: 'desc' }
      return {
        ...prev,
        [warId]: {
          col,
          dir: cur.col === col ? (cur.dir === 'asc' ? 'desc' : 'asc') : 'desc',
        },
      }
    })
  }

  function sortedContribs(warId, contribs) {
    const { col, dir } = getContribSort(warId)
    const d = dir === 'asc' ? 1 : -1
    return contribs.slice().sort((a, b) => {
      switch (col) {
        case 'name':    return d * (a.member_name || '').localeCompare(b.member_name || '')
        case 'level':   return d * ((a.level || 0) - (b.level || 0))
        case 'score':   return d * (Number(a.score) - Number(b.score))
        case 'attacks': return d * ((a.attacks || 0) - (b.attacks || 0))
        default:        return d * (Number(a.score) - Number(b.score))
      }
    })
  }

  function SortHeaderSmall({ warId, col, label, className = '' }) {
    const { col: activeCol, dir } = getContribSort(warId)
    const active = activeCol === col
    return (
      <th
        className={`pb-1 pr-4 font-medium cursor-pointer select-none hover:text-gray-700 dark:hover:text-gray-200 transition-colors ${className}`}
        onClick={() => handleContribSort(warId, col)}
      >
        {label}
        <span className="ml-1 text-gray-400">
          {active ? (dir === 'asc' ? '↑' : '↓') : '↕'}
        </span>
      </th>
    )
  }

  // Toggle termed/real
  const [updatingWarId, setUpdatingWarId] = useState(null)

  useEffect(() => {
    fetchWars(0, true)
    if (user?.id) loadMyWarPayouts()
  }, [user?.id])

  async function loadMyWarPayouts() {
    try {
      const memberId = user.id.toString()
      const { data } = await supabase
        .from('war_payout_members')
        .select('payout, war_payouts(war_id, created_at, ranked_wars(start_at, end_at, opponent_name, opponent_id))')
        .eq('member_id', memberId)
        .order('war_payout_id', { ascending: false })

      setMyWarPayouts(data || [])
    } catch (err) {
      console.error('Error loading war payouts:', err)
    }
  }

  const myStats = useMemo(() => {
    if (myWarPayouts.length === 0) return null
    const totalEarned = myWarPayouts.reduce((sum, p) => sum + (p.payout || 0), 0)
    return {
      totalEarned,
      warsActive: myWarPayouts.length,
      avgPerWar: totalEarned / myWarPayouts.length,
      lastPayout: myWarPayouts[0]?.payout || 0,
    }
  }, [myWarPayouts])

  async function fetchWars(newOffset, replace = false) {
    try {
      if (replace) {
        setLoading(true)
      } else {
        setLoadingMore(true)
      }
      setError(null)

      const [warsData, count] = await Promise.all([
        loadWars(PAGE_SIZE, newOffset),
        newOffset === 0 ? loadWarsCount() : Promise.resolve(totalWars)
      ])

      setWars(prev => replace ? warsData : [...prev, ...warsData])
      if (newOffset === 0) setTotalWars(count)
      setOffset(newOffset + warsData.length)
    } catch (err) {
      console.error('Error loading wars:', err)
      setError('Failed to load wars. Please try again.')
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }

  async function handleExpandWar(warId) {
    if (expandedWarId === warId) {
      setExpandedWarId(null)
      return
    }
    setExpandedWarId(warId)

    if (!contributions[warId]) {
      setLoadingContributions(prev => ({ ...prev, [warId]: true }))
      try {
        const data = await loadWarContributions(warId)
        setContributions(prev => ({ ...prev, [warId]: data }))
      } catch (err) {
        console.error('Error loading contributions:', err)
      } finally {
        setLoadingContributions(prev => ({ ...prev, [warId]: false }))
      }
    }
  }

  async function handleToggleTermed(e, war) {
    e.stopPropagation()
    if (!user?.apiKey) return

    setUpdatingWarId(war.id)
    try {
      await updateWarIsTermed(war.id, !war.is_termed, user.apiKey)
      setWars(prev => prev.map(w =>
        w.id === war.id ? { ...w, is_termed: !w.is_termed } : w
      ))
    } catch (err) {
      console.error('Error updating war type:', err)
    } finally {
      setUpdatingWarId(null)
    }
  }

  function getWarResult(war) {
    if (!war.end_at || war.end_at === 0) return 'ongoing'
    return war.winner_faction_id === OUR_FACTION_ID ? 'win' : 'loss'
  }

  const hasMore = offset < totalWars

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        <span className="ml-3 text-gray-600 dark:text-gray-400">Loading wars...</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
        <p className="text-red-700 dark:text-red-400">{error}</p>
        <button
          onClick={() => fetchWars(0, true)}
          className="mt-2 text-sm text-red-600 dark:text-red-400 underline hover:no-underline"
        >
          Retry
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* My RW Payout Stats */}
      {myStats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="card">
            <div className="text-2xl font-bold text-blue-600">{formatCurrencyShort(myStats.totalEarned)}</div>
            <div className="text-sm text-gray-600 dark:text-gray-400 uppercase tracking-wide mt-1">Total Earned</div>
          </div>
          <div className="card">
            <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">{myStats.warsActive}</div>
            <div className="text-sm text-gray-600 dark:text-gray-400 uppercase tracking-wide mt-1">Wars Paid</div>
          </div>
          <div className="card">
            <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">{formatCurrencyShort(myStats.avgPerWar)}</div>
            <div className="text-sm text-gray-600 dark:text-gray-400 uppercase tracking-wide mt-1">Avg / War</div>
          </div>
          <div className="card">
            <div className="text-2xl font-bold text-green-600">{formatCurrencyShort(myStats.lastPayout)}</div>
            <div className="text-sm text-gray-600 dark:text-gray-400 uppercase tracking-wide mt-1">Last Payout</div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white">RW History</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {totalWars} ranked wars total
          </p>
        </div>
      </div>

      {wars.length === 0 ? (
        <div className="text-center py-12 text-gray-500 dark:text-gray-400">
          No wars found. Run the war scraper to populate data.
        </div>
      ) : (
        <div className="bg-white dark:bg-slate-800 rounded-lg border border-gray-200 dark:border-slate-700 overflow-hidden">
          {wars.map((war, idx) => {
            const result = getWarResult(war)
            const isExpanded = expandedWarId === war.id
            const warContributions = contributions[war.id] || []
            const ourContribs = warContributions.filter(c => c.faction_id === OUR_FACTION_ID)
              .sort((a, b) => b.score - a.score)
            const isUpdating = updatingWarId === war.id

            return (
              <div
                key={war.id}
                className={`${idx > 0 ? 'border-t border-gray-200 dark:border-slate-700' : ''}`}
              >
                {/* War row */}
                <div
                  className="flex items-center gap-2 sm:gap-3 px-3 sm:px-4 py-2 sm:py-3 cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-700/50 transition-colors"
                  onClick={() => handleExpandWar(war.id)}
                >
                  <span className="text-gray-400 text-xs w-4 flex-shrink-0">
                    {isExpanded ? '▼' : '▶'}
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-gray-900 dark:text-white">
                      {formatWarDateRange(war.start_at, war.end_at)}
                    </div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      War #{war.id}
                    </div>
                  </div>

                  <div className="hidden sm:block text-sm text-gray-700 dark:text-gray-300 min-w-0 flex-1 truncate">
                    vs. {war.opponent_name || `Faction #${war.opponent_id}`}
                  </div>

                  <div className="text-xs sm:text-sm font-mono text-gray-700 dark:text-gray-300 flex-shrink-0">
                    <span className={result === 'win' ? 'text-green-600 dark:text-green-400 font-semibold' : ''}>
                      {war.our_score?.toLocaleString()}
                    </span>
                    <span className="text-gray-400 mx-1">–</span>
                    <span className={result === 'loss' ? 'text-red-600 dark:text-red-400 font-semibold' : ''}>
                      {war.opponent_score?.toLocaleString()}
                    </span>
                  </div>

                  <div className="flex-shrink-0">
                    {result === 'win' && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-400">
                        Win
                      </span>
                    )}
                    {result === 'loss' && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-400">
                        Loss
                      </span>
                    )}
                    {result === 'ongoing' && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-400">
                        Ongoing
                      </span>
                    )}
                  </div>

                  <div className="hidden sm:flex flex-shrink-0">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                      war.is_termed
                        ? 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-400'
                        : 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-400'
                    }`}>
                      {war.is_termed ? 'Termed' : 'Real'}
                    </span>
                  </div>

                  {isLeadership && result !== 'ongoing' && (
                    <button
                      onClick={(e) => handleToggleTermed(e, war)}
                      disabled={isUpdating}
                      className={`flex-shrink-0 text-xs px-2 py-1 rounded border transition-colors disabled:opacity-50 ${
                        war.is_termed
                          ? 'border-purple-400 bg-purple-50 text-purple-700 dark:bg-purple-900/30 dark:border-purple-600 dark:text-purple-400 hover:bg-purple-100 dark:hover:bg-purple-900/50'
                          : 'border-blue-400 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:border-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/50'
                      }`}
                    >
                      {isUpdating ? '···' : (
                        <>
                          <span className="hidden sm:inline">{war.is_termed ? '⇄ Set Real' : '⇄ Set Termed'}</span>
                          <span className="sm:hidden">⇄</span>
                        </>
                      )}
                    </button>
                  )}
                </div>

                {/* Expanded contributions */}
                {isExpanded && (
                  <div className="bg-gray-50 dark:bg-slate-900/50 border-t border-gray-200 dark:border-slate-700 px-2 sm:px-4 py-2 sm:py-3">
                    {loadingContributions[war.id] ? (
                      <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 py-2">
                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600"></div>
                        Loading member contributions...
                      </div>
                    ) : ourContribs.length === 0 ? (
                      <p className="text-sm text-gray-500 dark:text-gray-400 py-2">
                        No contribution data available. Run war scraper to populate.
                      </p>
                    ) : (
                      <div>
                        <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
                          Our Faction — Member Contributions
                        </h4>
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-slate-700">
                                <SortHeaderSmall warId={war.id} col="name" label="Member" />
                                <SortHeaderSmall warId={war.id} col="level" label="Level" className="text-right" />
                                <SortHeaderSmall warId={war.id} col="score" label="Score" className="text-right" />
                                <SortHeaderSmall warId={war.id} col="attacks" label="Attacks" className="text-right last:pr-0" />
                              </tr>
                            </thead>
                            <tbody>
                              {sortedContribs(war.id, ourContribs).map(c => (
                                <tr key={c.member_id} className="border-b border-gray-100 dark:border-slate-700/50 last:border-0">
                                  <td className="py-1 pr-4 text-gray-900 dark:text-white font-medium">
                                    {c.member_name}
                                  </td>
                                  <td className="py-1 pr-4 text-right text-gray-600 dark:text-gray-400">
                                    {c.level}
                                  </td>
                                  <td className="py-1 pr-4 text-right font-mono text-gray-900 dark:text-white">
                                    {Number(c.score).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                                  </td>
                                  <td className="py-1 text-right text-gray-600 dark:text-gray-400">
                                    {c.attacks}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Load more */}
      {hasMore && (
        <div className="text-center">
          <button
            onClick={() => fetchWars(offset)}
            disabled={loadingMore}
            className="px-4 py-2 text-sm text-blue-600 dark:text-blue-400 border border-blue-300 dark:border-blue-700 rounded-lg hover:bg-blue-50 dark:hover:bg-blue-900/20 disabled:opacity-50 transition-colors"
          >
            {loadingMore ? (
              <span className="flex items-center gap-2">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600"></div>
                Loading...
              </span>
            ) : (
              `Load more (${totalWars - offset} remaining)`
            )}
          </button>
        </div>
      )}
    </div>
  )
}
