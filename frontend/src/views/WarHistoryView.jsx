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

// Two decimals, thousands-separated.
//
// ⚠️ Live scores are summed per attack from decimal respect_gain values, so
// 1,606.13 and 1,606.00 are different people's totals. Rounding to whole
// numbers here would make near-identical contributions look identical, which
// is exactly where a payout argument starts.
const fmt2 = (n) =>
  Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// Renders a sync run record ({ status, rows_written, error, details }) as
// the one-line result message the fetch buttons show.
function runSummary(run, label) {
  if (run.status !== 'success') {
    return { type: 'error', text: `${label} failed: ${run.error ?? 'unknown error'}` }
  }
  return { type: 'success', text: `${label}: ${run.rows_written} rows synced.` }
}
import { formatWarDateRange } from '../utils/warPayoutCalculations'
import { X, RefreshCw } from 'lucide-react'
import StacksSnapshotSection from '../components/warroom/StacksSnapshotSection'
import InfoTooltip from '../components/InfoTooltip'
import { sortRows } from '../utils/tableSort.js'

const PAGE_SIZE = 50

/**
 * A war's outcome, derived rather than stored.
 *
 * ⚠️ Lifted to module scope for the column config below. It was declared
 * INSIDE the component, so a module-level accessor referencing it would have
 * thrown the moment anybody sorted by Result — and nothing would have caught
 * that until somebody clicked the header.
 */
function getWarResult(war) {
  if (!war.end_at || war.end_at === 0) return 'ongoing'
  // ⚠️ `getFactionId()` called here rather than closing over the component's
  // `OUR_FACTION_ID`, which is also component-scoped. Lifting a config to
  // module scope drags its dependencies with it, and each one that is missed
  // is a runtime throw nobody sees until the header is clicked.
  return war.winner_faction_id === getFactionId() ? 'win' : 'loss'
}

/**
 * The war list's columns.
 *
 * ⚠️ The scores were coerced with `|| 0`, which makes an ongoing war showing a
 * genuine 0 indistinguishable from one with no score recorded. They are plain
 * numbers now, and an absent score sinks rather than ranking as zero.
 *
 * ⚠️ `result` is DERIVED by `getWarResult`, not a field — a war's result
 * depends on whether it has ended and who scored higher.
 *
 * ⚠️ `is_termed` sorts as a bool so termed and real wars GROUP, which is the
 * only reason to sort that column. It is hand-set on the dashboard, so the
 * grouping is only as good as somebody having remembered to toggle it — the
 * same caveat the score line carries.
 */
export const WAR_LIST_COLUMNS = [
  { key: 'opponent',       kind: 'text',   accessor: (w) => w.opponent_name },
  { key: 'our_score',      kind: 'number', accessor: (w) => w.our_score },
  { key: 'opponent_score', kind: 'number', accessor: (w) => w.opponent_score },
  { key: 'result',         kind: 'text',   accessor: (w) => getWarResult(w) },
  { key: 'start_at',       kind: 'number', accessor: (w) => w.start_at },
  { key: 'is_termed',      kind: 'bool',   accessor: (w) => !!w.is_termed },
]

/**
 * ⚠️ `score` sorts on the NORMALISED value — the bracketed number, not the
 * leading one. It is what payout shares are computed from, so the order matches
 * who is actually near a threshold, which is the reason anybody opens this
 * table.
 */
export const WAR_MEMBER_COLUMNS = [
  { key: 'name',    kind: 'text',   accessor: (m) => m.member_name },
  { key: 'level',   kind: 'number', accessor: (m) => m.level },
  { key: 'score',   kind: 'number', accessor: (m) => Number(m.score) },
  { key: 'attacks', kind: 'number', accessor: (m) => m.attacks },
  { key: 'assists', kind: 'number', accessor: (m) => m.assists },
  { key: 'losses',  kind: 'number', accessor: (m) => m.losses },
]

export default function WarHistoryView({ isLeadership, isAdmin }) {
  const { user, isWarLead } = useAuth()
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
    // ⚠️ **A LIVE war is re-fetched every time this opens.** The cache was
    // unconditional, so once a war's numbers had been loaded they never changed
    // again for the lifetime of the page — the attacks scraper could run every
    // two minutes and the modal would still show what it saw the first time.
    // That reads as "the scraper isn't working", and it cost an evening of
    // looking at the scraper instead of at this line.
    //
    // A FINISHED war is still cached: Torn's report is final, so re-fetching it
    // is a page of rows nobody's numbers depend on.
    const war = wars.find(w => w.id === warId)
    const isLiveWar = war && (!war.end_at || war.end_at === 0)
    if (!contributions[warId] || isLiveWar) {
      setLoadingContributions(true)
      try {
        // 1) Try the canonical post-war source first.
        const finalData = await loadWarContributions(warId)
        const isOngoing = isLiveWar
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

  function handleSort(col) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('desc') }
  }

  const sortedWars = useMemo(() => {
    return sortRows(wars, WAR_LIST_COLUMNS, sortCol, sortDir, { tieBreak: 'start_at' })
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

  const sortedModalContribs = sortRows(
    ourContribs, WAR_MEMBER_COLUMNS, contribSort.col, contribSort.dir, { tieBreak: 'name' })

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
            </div>
          )}
        </div>


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
                  <SortHeader col="is_termed" label="Type" />
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
          // Mirrors the route's own gate (requireRole('warlead','leadership',
          // 'admin') on /api/wars/:id/stacks-snapshot) rather than reusing the
          // page's leadership flag — warleads own the pre-war roll call, and
          // the UI gate had quietly drifted from the API gate it copies.
          // Visitors stay out: the route also carries requireNotVisitor(), so
          // showing them the section would only buy them a 403.
          canSeeStacks={isLeadership || isAdmin || isWarLead}
        />
      )}
    </div>
  )
}

function ContributionsModal({ war, result, contributions, loading, isLive, sort, onSort, onClose, canSeeStacks }) {
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
                <InfoTooltip
                  label="Live · bonus-normalized"
                  decoration="no-underline"
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold tracking-wide uppercase bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300"
                >
                  Computed live from scraped attacks (faction_attacks). Score reads
                  as raw (normalised): the first figure is the respect Torn reports
                  as your war score, the second caps each chain-bonus hit at 10,
                  which is what payout shares are computed from. Assists and losses
                  count war attacks only. Numbers refresh on the next Fetch Attacks run.
                </InfoTooltip>
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
                  {/* ⚠️ The header says what the second number IS. A bare
                      "Score" showing two figures had people reading the
                      bracketed one as a rank or a delta. */}
                  <SortHeader col="score" label={isLive ? 'Score (Normalized)' : 'Score'} className="text-right" />
                  <SortHeader col="attacks" label="Attacks" className="text-right" />
                  {/* Live only: assists and losses are derived from scraped
                      attacks. Torn's post-war report carries neither, so for a
                      finished war there is nothing truthful to put here. */}
                  {isLive && <SortHeader col="assists" label="Assists" className="text-right" />}
                  {isLive && <SortHeader col="losses" label="Losses" className="text-right" />}
                </tr>
              </thead>
              <tbody>
                {contributions.map(c => (
                  <tr key={c.member_id} className="border-b border-gray-100 dark:border-slate-700/50 last:border-0">
                    <td className="py-1.5 px-3 text-xs font-medium text-gray-900 dark:text-white">{c.member_name}</td>
                    <td className="py-1.5 px-3 text-xs text-right text-gray-600 dark:text-gray-400">{c.level ?? '—'}</td>
                    <td className="py-1.5 px-3 text-xs text-right font-mono text-gray-900 dark:text-white">
                      {/* A finished war's score comes from Torn's own report as
                          a whole number, so it stays single and rounded. Only
                          the live figure is ours to decompose. */}
                      {isLive ? (
                        <>
                          {fmt2(c.score_raw ?? c.score)}
                          {' '}
                          {/* ⚠️ Dimmed, not hidden. The bracketed figure is the
                              one that decides payout, so it has to be visible —
                              but the leading number is the one that matches
                              Torn's own war report, which is what a member
                              compares against. */}
                          <span className="text-gray-500 dark:text-gray-400">({fmt2(c.score)})</span>
                        </>
                      ) : Math.round(Number(c.score)).toLocaleString()}
                    </td>
                    <td className="py-1.5 px-3 text-xs text-right text-gray-600 dark:text-gray-400">{c.attacks}</td>
                    {isLive && <td className="py-1.5 px-3 text-xs text-right text-gray-600 dark:text-gray-400">{c.assists ?? 0}</td>}
                    {isLive && <td className="py-1.5 px-3 text-xs text-right text-gray-600 dark:text-gray-400">{c.losses ?? 0}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {canSeeStacks && (
            <StacksSnapshotSection warId={war.id} warLabel={war.opponent_name || war.id} />
          )}
        </div>
      </div>
    </div>
  )
}
