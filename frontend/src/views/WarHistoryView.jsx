import { useState, useEffect, useMemo } from 'react'
import { useAuth } from '../contexts/AuthContext'
import {
  loadWars,
  loadWarsCount,
  loadWarContributions,
  loadLiveContributionsFromAttacks,
} from '../utils/warDataLoader'
import { apiPost } from '../utils/apiClient'
import { getFactionId } from '../utils/factionIdentity'

// Renders a sync run record ({ status, rows_written, error, details }) as
// the one-line result message the fetch buttons show.
function runSummary(run, label) {
  if (run.status !== 'success') {
    return { type: 'error', text: `${label} failed: ${run.error ?? 'unknown error'}` }
  }
  return { type: 'success', text: `${label}: ${run.rows_written} rows synced.` }
}
import { formatWarDateRange } from '../utils/warPayoutCalculations'
import { X, RefreshCw, Heart } from 'lucide-react'

const PAGE_SIZE = 50

export default function WarHistoryView({ isLeadership, isAdmin }) {
  const { user } = useAuth()
  // Our faction id, resolved per tenant at runtime (#249) — not a hard-coded id.
  const OUR_FACTION_ID = getFactionId()

  const [wars, setWars] = useState([])
  const [totalWars, setTotalWars] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState(null)

  // Contributions modal
  const [modalWarId, setModalWarId] = useState(null)
  const [contributions, setContributions] = useState({})
  const [loadingContributions, setLoadingContributions] = useState(false)
  // Set of war IDs whose contributions were computed live from faction_attacks
  // rather than fetched from war_member_contributions. Used to show the
  // "Live (bonus-normalized)" badge in the modal so members understand the
  // distinction between in-progress numbers and final Torn-reported totals.
  const [liveContribIds, setLiveContribIds] = useState(() => new Set())

  // Contributions sort
  const [contribSort, setContribSort] = useState({ col: 'score', dir: 'desc' })

  // Toggle termed
  const [updatingWarId, setUpdatingWarId] = useState(null)

  // Table sort
  const [sortCol, setSortCol] = useState('start_at')
  const [sortDir, setSortDir] = useState('desc')

  // Fetch buttons (leadership-only). `fetching` is the action currently
  // running, or null. `fetchMessage` is a small status banner that
  // auto-clears after ~8s.
  const [fetching, setFetching] = useState(null)
  const [fetchMessage, setFetchMessage] = useState(null)

  // Revives fetch — war picker modal state. We let the user pick which war
  // to scrape; the edge function resolves the start/end window from the
  // ranked_wars row (live war → walks up to "now").
  const [revivesPickerOpen, setRevivesPickerOpen] = useState(false)

  async function handleFetchAttacks() {
    if (fetching) return
    setFetching('attacks')
    setFetchMessage(null)
    try {
      const { run } = await apiPost('/api/sync/attacks', {})
      // The attacks scrape doesn't touch ranked_wars scores, so a live war's
      // Our/Their Score would stay stale. Refresh the official faction scores
      // (Torn DOES publish them live) and reload the table so the war list +
      // contributions modal show the current true total. Best-effort: a
      // failure here doesn't undo the attacks fetch.
      let scoreNote = ''
      try {
        await apiPost('/api/sync/wars', {})
        await fetchWars(0, true)
        scoreNote = ' War scores refreshed.'
      } catch (scoreErr) {
        console.warn('war-score refresh after attacks failed:', scoreErr)
      }
      const msg = runSummary(run, 'Attacks')
      setFetchMessage({ ...msg, text: `${msg.text}${scoreNote}` })
    } catch (err) {
      console.error('fetchAttacks failed:', err)
      setFetchMessage({ type: 'error', text: `Failed to fetch attacks: ${err.message}` })
    } finally {
      setFetching(null)
      setTimeout(() => setFetchMessage(null), 10_000)
    }
  }

  async function handleFetchRevives(warId) {
    if (fetching) return
    setRevivesPickerOpen(false)
    setFetching('revives')
    setFetchMessage(null)
    try {
      const { run } = await apiPost(`/api/sync/wars/${warId}/revives`, {})
      setFetchMessage(runSummary(run, `Revives for war ${warId}`))
    } catch (err) {
      console.error('fetchRevives failed:', err)
      setFetchMessage({ type: 'error', text: `Failed to fetch revives: ${err.message}` })
    } finally {
      setFetching(null)
      setTimeout(() => setFetchMessage(null), 10_000)
    }
  }

  async function handleFetchWars() {
    if (fetching) return
    setFetching('wars')
    setFetchMessage(null)
    try {
      const { run } = await apiPost('/api/sync/wars', {})
      const msg = runSummary(run, 'Wars')
      const reports = run.details?.reports_fetched
      setFetchMessage(reports > 0 ? { ...msg, text: `${msg.text.slice(0, -1)} (${reports} new reports).` } : msg)
      // Refresh the visible wars table so new rows appear without a manual reload.
      fetchWars(0, true)
    } catch (err) {
      console.error('fetchWars failed:', err)
      setFetchMessage({ type: 'error', text: `Failed to fetch wars: ${err.message}` })
    } finally {
      setFetching(null)
      setTimeout(() => setFetchMessage(null), 10_000)
    }
  }

  useEffect(() => {
    fetchWars(0, true)
  }, [])

  async function fetchWars(newOffset, replace = false) {
    try {
      if (replace) setLoading(true)
      else setLoadingMore(true)
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

  async function openContributions(warId) {
    setModalWarId(warId)
    if (!contributions[warId]) {
      setLoadingContributions(true)
      try {
        // 1) Try the canonical post-war source first.
        const finalData = await loadWarContributions(warId)
        const war = wars.find(w => w.id === warId)
        const isOngoing = war && (!war.end_at || war.end_at === 0)
        const finalIsEmpty = !finalData || finalData.length === 0

        // 2) For ongoing wars (Torn hasn't reported contributions yet) OR
        //    when the table happens to be empty for some other reason,
        //    derive a live leaderboard from scraped faction_attacks. Score
        //    follows the same bonus-cap-at-10 normalization the termed-war
        //    payout math uses, so what members see here matches how shares
        //    will be computed later.
        if (war && (isOngoing || finalIsEmpty)) {
          try {
            const liveData = await loadLiveContributionsFromAttacks(war)
            setContributions(prev => ({ ...prev, [warId]: liveData }))
            setLiveContribIds(prev => {
              const next = new Set(prev)
              next.add(warId)
              return next
            })
          } catch (liveErr) {
            // Fall back to the (possibly empty) final data if live fails.
            console.error('Error computing live contributions:', liveErr)
            setContributions(prev => ({ ...prev, [warId]: finalData }))
          }
        } else {
          setContributions(prev => ({ ...prev, [warId]: finalData }))
        }
      } catch (err) {
        console.error('Error loading contributions:', err)
      } finally {
        setLoadingContributions(false)
      }
    }
  }

  async function handleToggleTermed(e, war) {
    e.stopPropagation()
    setUpdatingWarId(war.id)
    try {
      await apiPost(`/api/wars/${war.id}/is-termed`, { is_termed: !war.is_termed })
      setWars(prev => prev.map(w => w.id === war.id ? { ...w, is_termed: !w.is_termed } : w))
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

  function handleSort(col) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('desc') }
  }

  const sortedWars = useMemo(() => {
    const d = sortDir === 'asc' ? 1 : -1
    return wars.slice().sort((a, b) => {
      switch (sortCol) {
        case 'start_at': return d * ((a.start_at || 0) - (b.start_at || 0))
        case 'opponent': return d * (a.opponent_name || '').localeCompare(b.opponent_name || '')
        case 'our_score': return d * ((a.our_score || 0) - (b.our_score || 0))
        case 'opponent_score': return d * ((a.opponent_score || 0) - (b.opponent_score || 0))
        case 'result': {
          const rA = getWarResult(a), rB = getWarResult(b)
          return d * rA.localeCompare(rB)
        }
        default: return d * ((a.start_at || 0) - (b.start_at || 0))
      }
    })
  }, [wars, sortCol, sortDir])

  function SortHeader({ col, label, className = '' }) {
    const active = sortCol === col
    return (
      <th
        className={`py-2 px-3 text-xs font-semibold cursor-pointer select-none hover:text-gray-700 dark:hover:text-gray-200 transition-colors sticky top-0 z-20 bg-white dark:bg-slate-800 border-b-2 border-gray-200 dark:border-slate-700 ${className}`}
        onClick={() => handleSort(col)}
      >
        {label}
        <span className="ml-1 text-gray-400">{active ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}</span>
      </th>
    )
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
        <button onClick={() => fetchWars(0, true)} className="mt-2 text-sm text-red-600 dark:text-red-400 underline hover:no-underline">Retry</button>
      </div>
    )
  }

  // Modal war data
  const modalWar = modalWarId ? wars.find(w => w.id === modalWarId) : null
  const modalContribs = modalWarId ? (contributions[modalWarId] || []) : []
  const ourContribs = modalContribs.filter(c => c.faction_id === OUR_FACTION_ID)

  const sortedModalContribs = (() => {
    const d = contribSort.dir === 'asc' ? 1 : -1
    return ourContribs.slice().sort((a, b) => {
      switch (contribSort.col) {
        case 'name': return d * (a.member_name || '').localeCompare(b.member_name || '')
        case 'level': return d * ((a.level || 0) - (b.level || 0))
        case 'score': return d * (Number(a.score) - Number(b.score))
        case 'attacks': return d * ((a.attacks || 0) - (b.attacks || 0))
        default: return d * (Number(a.score) - Number(b.score))
      }
    })
  })()

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
          <div>
            <h2 className="text-xl font-bold text-gray-900 dark:text-white">RW History</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">{totalWars} ranked wars total</p>
          </div>
          {isLeadership && (
            <div className="flex gap-2 items-center">
              <button
                onClick={handleFetchAttacks}
                disabled={!!fetching}
                className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 text-sm"
              >
                {fetching === 'attacks' ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                    Fetching…
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-4 h-4" />
                    Fetch Attacks
                  </>
                )}
              </button>
              <button
                onClick={handleFetchWars}
                disabled={!!fetching}
                className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 text-sm"
              >
                {fetching === 'wars' ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                    Fetching…
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-4 h-4" />
                    Fetch Wars
                  </>
                )}
              </button>
              <button
                onClick={() => setRevivesPickerOpen(true)}
                disabled={!!fetching}
                className="px-4 py-2 bg-rose-600 text-white rounded-lg hover:bg-rose-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 text-sm"
              >
                {fetching === 'revives' ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                    Fetching…
                  </>
                ) : (
                  <>
                    <Heart className="w-4 h-4" />
                    Fetch Revives
                  </>
                )}
              </button>
            </div>
          )}
        </div>

        {/* Revives war-picker modal — leadership picks a war, the edge function
            resolves start/end from ranked_wars and paginates. Live wars walk
            up to "now"; revive_id is the PK so re-running is idempotent. */}
        {revivesPickerOpen && (
          <RevivesPickerModal
            wars={wars}
            onPick={handleFetchRevives}
            onClose={() => setRevivesPickerOpen(false)}
          />
        )}

        {fetchMessage && (
          <div
            className={`mb-4 p-3 rounded-lg text-sm ${
              fetchMessage.type === 'success'
                ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 text-green-700 dark:text-green-400'
                : fetchMessage.type === 'warning'
                  ? 'bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-400'
                  : 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400'
            }`}
          >
            {fetchMessage.text}
          </div>
        )}

        {wars.length === 0 ? (
          <div className="text-center py-12 text-gray-500 dark:text-gray-400">
            No wars found. Run the war scraper to populate data.
          </div>
        ) : (
          <div className="overflow-auto max-h-[70vh] relative">
            <table className="w-full text-sm border-separate border-spacing-0">
              <thead>
                <tr className="text-left">
                  <SortHeader col="opponent" label="Opponent" className="sticky left-0 z-30 bg-white dark:bg-slate-800" />
                  <SortHeader col="our_score" label="Our Score" className="text-right" />
                  <SortHeader col="opponent_score" label="Their Score" className="text-right" />
                  <SortHeader col="result" label="Result" />
                  <SortHeader col="start_at" label="Date" />
                  <th className="py-2 px-3 text-xs font-semibold sticky top-0 z-20 bg-white dark:bg-slate-800 border-b-2 border-gray-200 dark:border-slate-700">Type</th>
                  {isLeadership && (
                    <th className="py-2 px-3 text-xs font-semibold sticky top-0 z-20 bg-white dark:bg-slate-800 border-b-2 border-gray-200 dark:border-slate-700">Actions</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {sortedWars.map((war) => {
                  const result = getWarResult(war)
                  const resultColor = result === 'win' ? 'text-green-600' : result === 'loss' ? 'text-red-500' : 'text-yellow-600'
                  const isUpdating = updatingWarId === war.id

                  return (
                    <tr
                      key={war.id}
                      className="border-b border-gray-200 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-700/50 cursor-pointer"
                      onClick={() => openContributions(war.id)}
                    >
                      <td className="py-2 px-3 text-xs font-medium sticky left-0 z-[5] bg-white dark:bg-slate-800 truncate max-w-[200px]">
                        {war.opponent_name || `Faction #${war.opponent_id}`}
                      </td>
                      <td className="py-2 px-3 text-xs text-right tabular-nums font-mono">
                        <span className={result === 'win' ? 'text-green-600 font-semibold' : ''}>
                          {Math.round(war.our_score || 0).toLocaleString()}
                        </span>
                      </td>
                      <td className="py-2 px-3 text-xs text-right tabular-nums font-mono">
                        <span className={result === 'loss' ? 'text-red-500 font-semibold' : ''}>
                          {Math.round(war.opponent_score || 0).toLocaleString()}
                        </span>
                      </td>
                      <td className="py-2 px-3 text-xs">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                          result === 'win' ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-400' :
                          result === 'loss' ? 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-400' :
                          'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-400'
                        }`}>
                          {result === 'win' ? 'Win' : result === 'loss' ? 'Loss' : 'Ongoing'}
                        </span>
                      </td>
                      <td className="py-2 px-3 text-xs text-gray-600 dark:text-gray-400 whitespace-nowrap">
                        {formatWarDateRange(war.start_at, war.end_at)}
                      </td>
                      <td className="py-2 px-3 text-xs">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                          war.is_termed
                            ? 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-400'
                            : 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-400'
                        }`}>
                          {war.is_termed ? 'Termed' : 'Real'}
                        </span>
                      </td>
                      {isLeadership && (
                        <td className="py-2 px-3 text-xs" onClick={e => e.stopPropagation()}>
                          {result !== 'ongoing' && (
                            <button
                              onClick={(e) => handleToggleTermed(e, war)}
                              disabled={isUpdating}
                              className="text-xs px-2 py-1 rounded border transition-colors disabled:opacity-50 border-gray-300 dark:border-slate-600 hover:bg-gray-100 dark:hover:bg-slate-700"
                            >
                              {isUpdating ? '···' : (war.is_termed ? 'Set Real' : 'Set Termed')}
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Load more */}
        {hasMore && (
          <div className="text-center mt-4">
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

      {/* Contributions Modal */}
      {modalWarId && modalWar && (
        <ContributionsModal
          war={modalWar}
          result={getWarResult(modalWar)}
          contributions={sortedModalContribs}
          loading={loadingContributions}
          isLive={liveContribIds.has(modalWarId)}
          sort={contribSort}
          onSort={(col) => setContribSort(prev => ({
            col,
            dir: prev.col === col ? (prev.dir === 'asc' ? 'desc' : 'asc') : 'desc',
          }))}
          onClose={() => setModalWarId(null)}
        />
      )}
    </div>
  )
}

function ContributionsModal({ war, result, contributions, loading, isLive, sort, onSort, onClose }) {
  const resultLabel = result === 'win' ? 'Win' : result === 'loss' ? 'Loss' : 'Ongoing'
  const resultColor = result === 'win' ? 'text-green-600' : result === 'loss' ? 'text-red-500' : 'text-yellow-600'

  function SortHeader({ col, label, className = '' }) {
    const active = sort.col === col
    return (
      <th
        className={`py-2 px-3 text-xs font-semibold cursor-pointer select-none hover:text-gray-700 dark:hover:text-gray-200 sticky top-0 z-20 bg-white dark:bg-slate-800 border-b-2 border-gray-200 dark:border-slate-700 ${className}`}
        onClick={() => onSort(col)}
      >
        {label}
        <span className="ml-1 text-gray-400">{active ? (sort.dir === 'asc' ? '↑' : '↓') : '↕'}</span>
      </th>
    )
  }

  return (
    <div className="modal-overlay">
      <div className="modal-dialog sm:max-w-2xl">
        <div className="flex-shrink-0 p-4 border-b border-gray-200 dark:border-slate-700 flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-lg font-semibold">War Contributions</h3>
              {isLive && (
                <span
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold tracking-wide uppercase bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300"
                  title="Computed live from scraped attacks (faction_attacks). Bonus chain hits are normalised to 10 score each, matching how termed-war shares get computed. Numbers refresh on the next Fetch Attacks run."
                >
                  Live · bonus-normalized
                </span>
              )}
            </div>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              <span className={`font-medium ${resultColor}`}>{resultLabel}</span>
              {' vs '}
              {war.opponent_name || `Faction #${war.opponent_id}`}
              {' — '}
              {formatWarDateRange(war.start_at, war.end_at)}
            </p>
          </div>
          <button onClick={onClose} className="p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Score summary */}
        <div className="flex-shrink-0 px-4 pt-3 pb-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-gray-50 dark:bg-slate-700/50 rounded-lg p-3 text-center">
              <div className={`text-lg font-bold ${result === 'win' ? 'text-green-600' : ''}`}>
                {Math.round(war.our_score || 0).toLocaleString()}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">Our Score</div>
            </div>
            <div className="bg-gray-50 dark:bg-slate-700/50 rounded-lg p-3 text-center">
              <div className={`text-lg font-bold ${result === 'loss' ? 'text-red-500' : ''}`}>
                {Math.round(war.opponent_score || 0).toLocaleString()}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">Their Score</div>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-auto px-4 pb-4">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 py-8 justify-center">
              <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600"></div>
              Loading contributions...
            </div>
          ) : contributions.length === 0 ? (
            <p className="text-center text-gray-500 dark:text-gray-400 py-8">
              No contribution data available.
            </p>
          ) : (
            <table className="w-full text-sm border-separate border-spacing-0">
              <thead>
                <tr className="text-left">
                  <SortHeader col="name" label="Member" />
                  <SortHeader col="level" label="Level" className="text-right" />
                  <SortHeader col="score" label="Score" className="text-right" />
                  <SortHeader col="attacks" label="Attacks" className="text-right" />
                </tr>
              </thead>
              <tbody>
                {contributions.map(c => (
                  <tr key={c.member_id} className="border-b border-gray-100 dark:border-slate-700/50 last:border-0">
                    <td className="py-1.5 px-3 text-xs font-medium text-gray-900 dark:text-white">{c.member_name}</td>
                    <td className="py-1.5 px-3 text-xs text-right text-gray-600 dark:text-gray-400">{c.level ?? '—'}</td>
                    <td className="py-1.5 px-3 text-xs text-right font-mono text-gray-900 dark:text-white">
                      {/* Live computed scores are aggregated per-attack with
                          decimal respect_gain values, so 2dp keeps the
                          precision visible (e.g., 223.54). Final scores from
                          war_member_contributions are reported by Torn as
                          whole numbers, so keep them rounded to stay tidy. */}
                      {isLive
                        ? Number(c.score).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                        : Math.round(Number(c.score)).toLocaleString()}
                    </td>
                    <td className="py-1.5 px-3 text-xs text-right text-gray-600 dark:text-gray-400">{c.attacks}</td>
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

// Lightweight war picker for the Revives fetch. We re-use the already-loaded
// `wars` list (newest first) — leadership almost always wants a recent war
// for a post-mortem, so paginating into the deep past isn't worth the UX cost.
// LIVE wars (end_at is null) are flagged so leadership knows the fetch will
// walk up to "now" rather than a fixed end timestamp.
function RevivesPickerModal({ wars, onPick, onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl w-full max-w-2xl my-12" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-slate-700">
          <div>
            <h3 className="text-lg font-bold text-gray-900 dark:text-white">Fetch revives — pick a war</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              The window comes from ranked_wars (start_at → end_at, or "now" for live wars).
              Re-running a war that's already been fetched is a no-op.
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto">
          {wars.length === 0 ? (
            <p className="p-6 text-sm text-gray-500 dark:text-gray-400 text-center">
              No wars loaded yet — click <em>Fetch Wars</em> first.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-slate-900/50 sticky top-0">
                <tr>
                  <th className="text-left px-4 py-2 font-medium text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">War</th>
                  <th className="text-left px-4 py-2 font-medium text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Opponent</th>
                  <th className="text-left px-4 py-2 font-medium text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Window</th>
                  <th className="text-right px-4 py-2 font-medium text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Action</th>
                </tr>
              </thead>
              <tbody>
                {wars.map(w => {
                  const isLive = w.end_at == null
                  const opponent = w.opponent_name || `faction ${w.opponent_id}`
                  return (
                    <tr key={w.id} className="border-t border-gray-100 dark:border-slate-700/50">
                      <td className="px-4 py-2 font-mono text-xs text-gray-700 dark:text-gray-300">{w.id}</td>
                      <td className="px-4 py-2 text-gray-900 dark:text-white">
                        {opponent}
                        {isLive && (
                          <span className="ml-2 inline-flex items-center gap-1 px-1.5 py-0.5 bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 rounded text-[10px] font-semibold uppercase">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> Live
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-xs text-gray-600 dark:text-gray-400">
                        {formatWarDateRange(w.start_at, w.end_at)}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <button
                          onClick={() => onPick(w.id)}
                          className="px-3 py-1 bg-rose-600 text-white rounded hover:bg-rose-700 text-xs"
                        >
                          Fetch
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
        <div className="p-3 border-t border-gray-200 dark:border-slate-700 text-right">
          <button
            onClick={onClose}
            className="px-3 py-1.5 bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-gray-300 rounded hover:bg-gray-200 dark:hover:bg-slate-600 text-sm"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
