import { useState, useEffect, useMemo } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { loadWars, loadWarsCount, loadWarContributions, loadLiveContributionsFromAttacks, loadFactionAttacksByWindow, loadWarPayouts, loadRecentWarPayouts, loadFactionsByIds } from '../utils/warDataLoader'
import { saveWarPayout, updateWarIsTermed } from '../utils/adminApi'
import {
  calculateTermedWarPayouts,
  calculateRealWarPayouts,
  calculateRaceWarPayouts,
  detectRaceCutoff,
  generateWarBatchPayoutURL,
  formatWarDateRange,
  buildHitReport,
  collectOpposingFactionIds,
  compareContributionSources,
  deriveWarScoresByMember,
} from '../utils/warPayoutCalculations'

const OUR_FACTION_ID = 10739
const WAR_PAGE_SIZE = 5

function formatCurrency(n) {
  if (n === null || n === undefined) return '$0'
  return '$' + Math.floor(n).toLocaleString()
}

function WarDropdown({ wars, totalWars, selectedWar, onSelect, page, onPageChange, loadingWars }) {
  const [open, setOpen] = useState(false)
  const totalPages = Math.ceil(totalWars / WAR_PAGE_SIZE)

  function selectWar(war) {
    onSelect(war)
    setOpen(false)
  }

  function warLabel(war) {
    const isWin = war.winner_faction_id === OUR_FACTION_ID
    const isOngoing = !war.end_at || war.end_at === 0
    const result = isOngoing ? 'Ongoing' : isWin ? 'Win' : 'Loss'
    return `vs. ${war.opponent_name || `#${war.opponent_id}`} — ${formatWarDateRange(war.start_at, war.end_at)} [${result}]`
  }

  return (
    <div className="relative">
      <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
        Select War {totalWars > 0 && <span className="text-gray-400">({totalWars} total)</span>}
      </label>
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-3 py-2 text-sm border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-gray-900 dark:text-white hover:border-blue-400 transition-colors"
      >
        <span className={`truncate ${selectedWar ? 'text-gray-900 dark:text-white' : 'text-gray-400 dark:text-gray-500'}`}>
          {selectedWar ? warLabel(selectedWar) : 'Choose a war...'}
        </span>
        <span className="text-gray-400 ml-2">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="absolute z-20 mt-1 w-full bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-600 rounded-lg shadow-lg overflow-hidden">
          {loadingWars ? (
            <div className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">Loading wars...</div>
          ) : (
            <>
              <div className="divide-y divide-gray-100 dark:divide-slate-700 max-h-72 overflow-y-auto">
                {wars.map(war => {
                  const isWin = war.winner_faction_id === OUR_FACTION_ID
                  const isOngoing = !war.end_at || war.end_at === 0
                  return (
                    <button
                      key={war.id}
                      onClick={() => selectWar(war)}
                      className={`w-full text-left px-3 py-2.5 text-sm hover:bg-gray-50 dark:hover:bg-slate-700/60 transition-colors ${
                        selectedWar?.id === war.id ? 'bg-blue-50 dark:bg-blue-900/20' : ''
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <span className="font-medium text-gray-900 dark:text-white">
                            vs. {war.opponent_name || `#${war.opponent_id}`}
                          </span>
                          <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
                            {formatWarDateRange(war.start_at, war.end_at)}
                          </span>
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          {isOngoing ? (
                            <span className="text-xs px-1.5 py-0.5 rounded bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300">Ongoing</span>
                          ) : isWin ? (
                            <span className="text-xs px-1.5 py-0.5 rounded bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-400">Win</span>
                          ) : (
                            <span className="text-xs px-1.5 py-0.5 rounded bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-400">Loss</span>
                          )}
                          <span className={`text-xs px-1.5 py-0.5 rounded ${war.is_termed ? 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-400' : 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-400'}`}>
                            {war.is_termed ? 'Termed' : 'Real'}
                          </span>
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
              {totalPages > 1 && (
                <div className="flex items-center justify-between px-3 py-2 border-t border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/80">
                  <button
                    onClick={() => onPageChange(page - 1)}
                    disabled={page === 0}
                    className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-slate-600 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-700 disabled:opacity-40 transition-colors"
                  >
                    ← Prev
                  </button>
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    Page {page + 1} / {totalPages}
                  </span>
                  <button
                    onClick={() => onPageChange(page + 1)}
                    disabled={page >= totalPages - 1}
                    className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-slate-600 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-700 disabled:opacity-40 transition-colors"
                  >
                    Next →
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function HitReportPanel({ attacks, factionLookup, factionFilter, setFactionFilter, sortCol, sortDir, onSort, opponentId, cutoff = null }) {
  // Unique opposing faction IDs from the attacks, derived once per attack set
  const opposingIds = (() => {
    const ids = new Set()
    for (const a of attacks) {
      const isIncoming = a.is_incoming === true || a.is_incoming === 'true' || a.is_incoming === 1
      if (isIncoming) {
        if (a.defender_faction_id === OUR_FACTION_ID && a.attacker_faction_id) ids.add(Number(a.attacker_faction_id))
      } else {
        if (a.attacker_faction_id === OUR_FACTION_ID && a.defender_faction_id) ids.add(Number(a.defender_faction_id))
      }
    }
    const oppId = opponentId ? Number(opponentId) : null
    return [...ids].sort((a, b) => {
      if (a === oppId) return -1
      if (b === oppId) return 1
      if (a === OUR_FACTION_ID) return -1
      if (b === OUR_FACTION_ID) return 1
      const na = factionLookup.get(a)?.name || `Faction #${a}`
      const nb = factionLookup.get(b)?.name || `Faction #${b}`
      return na.localeCompare(nb)
    })
  })()

  // Default: all factions selected
  const effectiveFilter = factionFilter ?? new Set(opposingIds)

  function toggleFaction(id) {
    const next = new Set(effectiveFilter)
    if (next.has(id)) next.delete(id); else next.add(id)
    setFactionFilter(next)
  }
  function selectAll()  { setFactionFilter(new Set(opposingIds)) }
  function selectNone() { setFactionFilter(new Set()) }

  const rows = buildHitReport(attacks, effectiveFilter)

  // In race wars, also build a post-cutoff-only report so each cell can show
  // `pre (post)`. preRow/postRow are keyed by memberId for O(1) lookup.
  const postByMember = cutoff
    ? new Map(buildHitReport(attacks.filter(a => (Number(a.started) || 0) > cutoff), effectiveFilter).map(r => [r.memberId, r]))
    : null

  // Sort
  const dir = sortDir === 'asc' ? 1 : -1
  const sortedRows = rows.slice().sort((a, b) => {
    if (sortCol === 'name') return dir * a.memberName.localeCompare(b.memberName)
    const [side, key] = sortCol.split('.')
    const av = a[side]?.[key] ?? 0
    const bv = b[side]?.[key] ?? 0
    return dir * (av - bv)
  })

  function HitSort({ col, label, className = '' }) {
    const active = sortCol === col
    return (
      <th
        onClick={() => onSort(col)}
        className={`px-2 py-1.5 font-medium cursor-pointer select-none hover:text-gray-700 dark:hover:text-gray-200 whitespace-nowrap ${className}`}
      >
        {label}
        <span className="ml-1 text-gray-400 text-xs">{active ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}</span>
      </th>
    )
  }

  const outgoingCols = [
    { key: 'outgoing.leaves',    label: 'Leaves' },
    { key: 'outgoing.mugs',      label: 'Mugs' },
    { key: 'outgoing.hosp',      label: 'Hosp' },
    { key: 'outgoing.warHits',   label: 'War' },
    { key: 'outgoing.assists',   label: 'Assists' },
    { key: 'outgoing.losses',    label: 'Lost' },
    { key: 'outgoing.totalHits', label: 'Total' },
  ]
  const incomingCols = [
    { key: 'incoming.leaves',    label: 'Leaves' },
    { key: 'incoming.mugs',      label: 'Mugs' },
    { key: 'incoming.hosp',      label: 'Hosp' },
    { key: 'incoming.warHits',   label: 'War' },
    { key: 'incoming.assists',   label: 'Assists' },
    { key: 'incoming.losses',    label: 'Lost' },
    { key: 'incoming.totalHits', label: 'Total' },
  ]

  return (
    <div>
      {/* Faction filter */}
      <div className="px-3 sm:px-4 py-3 border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-700/30">
        <div className="flex items-center justify-between gap-2 mb-2">
          <h4 className="text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wider">
            Filter by Opposing Faction ({effectiveFilter.size}/{opposingIds.length})
          </h4>
          <div className="flex gap-2">
            <button onClick={selectAll}  className="text-xs px-2 py-0.5 rounded border border-gray-300 dark:border-slate-600 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-700">All</button>
            <button onClick={selectNone} className="text-xs px-2 py-0.5 rounded border border-gray-300 dark:border-slate-600 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-700">None</button>
          </div>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {opposingIds.length === 0 ? (
            <span className="text-xs text-gray-500 dark:text-gray-400">No opposing factions in this window.</span>
          ) : opposingIds.map(id => {
            const info = factionLookup.get(id)
            const label = info ? `${info.name}${info.tag ? ` [${info.tag}]` : ''}` : `Faction #${id}`
            return (
              <label key={id} className="flex items-center gap-1.5 text-xs text-gray-700 dark:text-gray-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={effectiveFilter.has(id)}
                  onChange={() => toggleFaction(id)}
                  className="rounded border-gray-300 dark:border-slate-600 text-blue-600"
                />
                <span>{label}</span>
              </label>
            )
          })}
        </div>
      </div>

      {/* Hit report table */}
      <div className="overflow-auto max-h-[70vh] relative">
        <table className="w-full text-xs border-separate border-spacing-0">
          <thead>
            <tr className="text-left text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-slate-700">
              <th className="px-2 py-2 font-semibold border-b border-gray-200 dark:border-slate-700 sticky top-0 left-0 z-30 bg-gray-50 dark:bg-slate-700" rowSpan={2}>
                Player
              </th>
              <th className="px-2 py-2 font-semibold border-b border-l border-gray-200 dark:border-slate-700 sticky top-0 z-20 bg-emerald-50 dark:bg-slate-800 text-emerald-800 dark:text-emerald-300 text-center" colSpan={outgoingCols.length}>
                Outgoing
              </th>
              <th className="px-2 py-2 font-semibold border-b border-l border-gray-200 dark:border-slate-700 sticky top-0 z-20 bg-amber-50 dark:bg-slate-800 text-amber-800 dark:text-amber-300 text-center" colSpan={incomingCols.length}>
                Incoming
              </th>
            </tr>
            <tr className="text-left text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-slate-700 border-b border-gray-200 dark:border-slate-700">
              {outgoingCols.map((c, i) => (
                <HitSort
                  key={c.key}
                  col={c.key}
                  label={c.label}
                  className={`text-right sticky top-[32px] z-10 bg-gray-50 dark:bg-slate-700 ${i === 0 ? 'border-l border-gray-200 dark:border-slate-700' : ''}`}
                />
              ))}
              {incomingCols.map((c, i) => (
                <HitSort
                  key={c.key}
                  col={c.key}
                  label={c.label}
                  className={`text-right sticky top-[32px] z-10 bg-gray-50 dark:bg-slate-700 ${i === 0 ? 'border-l border-gray-200 dark:border-slate-700' : ''}`}
                />
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedRows.length === 0 && (
              <tr>
                <td colSpan={1 + incomingCols.length + outgoingCols.length} className="px-3 py-6 text-center text-gray-500 dark:text-gray-400">
                  No attacks matching the current faction filter.
                </td>
              </tr>
            )}
            {sortedRows.map(r => (
              <tr key={r.memberId} className="border-b border-gray-100 dark:border-slate-700/50 hover:bg-gray-50 dark:hover:bg-slate-700/30">
                <td className="px-2 py-1.5 font-medium text-gray-900 dark:text-white whitespace-nowrap sticky left-0 z-[5] bg-white dark:bg-slate-800">
                  {r.memberName}
                </td>
                {[...outgoingCols, ...incomingCols].map((c, i) => {
                  const [side, key] = c.key.split('.')
                  const v = r[side][key]
                  const isFirst = i === 0 || i === outgoingCols.length
                  // Race wars: split into `pre (post)` using the post-cutoff report.
                  const post = postByMember ? (postByMember.get(r.memberId)?.[side]?.[key] ?? 0) : 0
                  const pre = v - post
                  return (
                    <td key={c.key} className={`px-2 py-1.5 text-right ${v === 0 ? 'text-gray-400 dark:text-gray-600' : 'text-gray-700 dark:text-gray-300'} ${isFirst ? 'border-l border-gray-200 dark:border-slate-700' : ''}`}>
                      {cutoff ? <SplitCount pre={pre} post={post} /> : v}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// TCT == UTC. Convert between a unix-seconds timestamp and the value string a
// native <input type="datetime-local"> expects, interpreting the field as TCT.
const tsToTctInput = ts => ts ? new Date(ts * 1000).toISOString().slice(0, 16) : ''
const tctInputToTs = s => s ? Math.floor(Date.parse(s + ':00Z') / 1000) : null

// Render a count as `pre (post)` with the post-cutoff portion in the
// post-cutoff purple. Used for race-war Payout Sheet / Hit Report cells.
function SplitCount({ pre = 0, post = 0, fmt = (n) => n }) {
  return (
    <>
      {fmt(pre)}
      {post > 0 && <span className="text-purple-600 dark:text-purple-400"> ({fmt(post)})</span>}
    </>
  )
}

export default function WarPayoutManagement() {
  const { user } = useAuth()

  // War list state
  const [wars, setWars] = useState([])
  const [totalWars, setTotalWars] = useState(0)
  const [warPage, setWarPage] = useState(0)
  const [loadingWars, setLoadingWars] = useState(true)

  // Selected war state
  const [selectedWar, setSelectedWar] = useState(null)
  const [contributions, setContributions] = useState([])
  const [attacks, setAttacks] = useState([])
  const [loadingWarData, setLoadingWarData] = useState(false)
  // Where the contribution roster came from:
  //   'official' — war_member_contributions (Torn report published, war over)
  //   'live'     — derived from faction_attacks (war still in progress / report
  //                not yet out). Live payouts are preview-only (no DB save).
  const [contributionSource, setContributionSource] = useState('official')
  // Cross-check of attack-derived scores vs the official report (null in live mode).
  const [discrepancy, setDiscrepancy] = useState(null)
  const [showDiscrepancyDetail, setShowDiscrepancyDetail] = useState(false)

  // Payout settings.
  // The payout engine is unified on the Race calculation. `warType` stays 'race'
  // internally so all the race rendering/calc paths apply; `warClass` is the
  // historical Real/Termed tag the user picks (saved as war_type + is_termed).
  const [warType] = useState('race')
  const [warClass, setWarClass] = useState('real')   // 'real' | 'termed'
  const [factionCutPercent, setFactionCutPercent] = useState(20)
  const [totalReward, setTotalReward] = useState(0)
  // Termed settings
  const [minScoreThreshold, setMinScoreThreshold] = useState(50)
  const [termedMode, setTermedMode] = useState('flat')       // 'flat' | 'scaling'
  const [memberShares, setMemberShares] = useState({})        // { memberId: shareCount }
  // Manual per-member overrides for the race POST-cutoff flat-shares window.
  // Same idea as OC ticket tweaks: reducing a member's shares returns their cut
  // to the pool, which the flat-shares split then spreads across everyone else.
  const [postMemberShares, setPostMemberShares] = useState({})
  const [cutoffHours, setCutoffHours] = useState(24)
  const [notes, setNotes] = useState('')
  // Real war formula settings
  const [warHitMult, setWarHitMult]   = useState(1.00)
  const [assistMult, setAssistMult]   = useState(0.50)
  const [lossMult, setLossMult]       = useState(0.50)
  const [mugMult, setMugMult]         = useState(0.00)
  const [partWeight, setPartWeight]   = useState(50)   // integer 0–100; contrib = 100 - partWeight
  const [regularHitMult, setRegularHitMult] = useState(1.00)
  const [mercCost, setMercCost]         = useState('')
  const [reviverCost, setReviverCost]   = useState('')
  const [factionTopUp, setFactionTopUp] = useState('')
  // Per-member multiplier overrides (pre-cutoff / real-war)
  const [memberMultiplierOverrides, setMemberMultiplierOverrides] = useState({})
  // Post-cutoff formula settings (Race only) — own multiplier set, weight, overrides
  const [postWarHitMult, setPostWarHitMult]         = useState(1.00)
  const [postAssistMult, setPostAssistMult]         = useState(0.50)
  const [postLossMult, setPostLossMult]             = useState(0.50)
  const [postMugMult, setPostMugMult]               = useState(0.00)
  const [postRegularHitMult, setPostRegularHitMult] = useState(0.00)  // typically 0 post-cutoff
  const [postPartWeight, setPostPartWeight]         = useState(50)
  const [postMemberMultiplierOverrides, setPostMemberMultiplierOverrides] = useState({})
  // Post-cutoff distribution: 'formula' (multipliers) or 'flat' (equal shares ± scale)
  const [postDistMode, setPostDistMode]       = useState('formula')
  const [postFlatThreshold, setPostFlatThreshold] = useState(50)
  const [postScaleEnabled, setPostScaleEnabled]   = useState(false)
  const [postScaleHours, setPostScaleHours]       = useState(24)

  // Race mode settings
  const [raceTargetScore, setRaceTargetScore] = useState(0)
  const [raceCutoffMode, setRaceCutoffMode] = useState('auto') // 'auto' | 'manual'
  const [raceCutoffTimestamp, setRaceCutoffTimestamp] = useState(null)
  const [racePostCutoffMode, setRacePostCutoffMode] = useState('flat') // 'flat' | 'scaling'
  const [racePreCutoffPercent, setRacePreCutoffPercent] = useState(50)

  // View mode
  const [viewMode, setViewMode] = useState('leader') // 'leader' | 'member'

  // Results state
  const [hasCalculated, setHasCalculated] = useState(false)
  const [payoutResults, setPayoutResults] = useState(null)
  const [eligibilityOverrides, setEligibilityOverrides] = useState({})

  // Save state
  const [isSaving, setIsSaving] = useState(false)
  const [savedPayoutId, setSavedPayoutId] = useState(null)
  const [saveError, setSaveError] = useState(null)

  // Batch URL
  const [showBatchURL, setShowBatchURL] = useState(false)
  const [batchURL, setBatchURL] = useState('')
  const [batchURLCopied, setBatchURLCopied] = useState(false)

  // Historical payouts
  const [historicalPayouts, setHistoricalPayouts] = useState([])
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [showHistory, setShowHistory] = useState(false)

  // Results table sort
  const [sortCol, setSortCol] = useState('payout')
  const [sortDir, setSortDir] = useState('desc')

  // Hit report tab state
  const [activeTab, setActiveTab] = useState('payout')           // 'payout' | 'hits' | 'hits-pre' | 'hits-post'
  const [factionLookup, setFactionLookup] = useState(new Map())  // id → { id, name, tag }
  const [factionFilter, setFactionFilter] = useState(null)       // real/termed: Set<id> | null (null = all)
  // Race: independent pre/post-cutoff filters that each drive their window's payout.
  const [factionFilterPre, setFactionFilterPre] = useState(null)
  const [factionFilterPost, setFactionFilterPost] = useState(null)
  const [hitSortCol, setHitSortCol] = useState('name')
  const [hitSortDir, setHitSortDir] = useState('asc')

  // Load wars whenever page changes
  useEffect(() => {
    fetchWarsPage(warPage)
  }, [warPage])

  async function fetchWarsPage(page) {
    try {
      setLoadingWars(true)
      const offset = page * WAR_PAGE_SIZE
      const [warsData, count] = await Promise.all([
        loadWars(WAR_PAGE_SIZE, offset),
        page === 0 ? loadWarsCount() : Promise.resolve(totalWars)
      ])
      setWars(warsData)
      if (page === 0) setTotalWars(count)
    } catch (err) {
      console.error('Error loading wars:', err)
    } finally {
      setLoadingWars(false)
    }
  }

  function handlePageChange(newPage) {
    setWarPage(newPage)
  }

  // Apply a sensible starting configuration for a Real or Termed classification.
  // The engine is the unified Race calc, so:
  //   • Real   = cutoff at war end → every attack is "pre", whole pool paid by
  //              the real-war formula (post window unused).
  //   • Termed = cutoff at war start (0) → every attack is "post", whole pool
  //              paid by the post window (default flat shares).
  // The user can still customise (e.g. set a mid-war cutoff + pre/post split to
  // make it an actual race) — this only sets the defaults + the historical tag.
  function applyClassPreset(cls, war) {
    setWarClass(cls)
    if (cls === 'termed') {
      setRaceCutoffTimestamp(0)
      setRacePreCutoffPercent(0)
      setPostDistMode('flat')
    } else {
      // Completed war → cutoff at war end (keeps the real-war preset 100%
      // pre-cutoff: every attack is before the cutoff). Ongoing war (no end_at)
      // → default the Manual Cutoff to the war's START, so leaders setting up a
      // race have a sensible in-window anchor to drag forward (rather than
      // "now"). They then set the pre/post split for the actual race.
      setRaceCutoffTimestamp(war?.end_at || war?.start_at || Math.floor(Date.now() / 1000))
      setRacePreCutoffPercent(100)
      setPostDistMode('formula')
    }
  }

  async function handleSelectWar(war) {
    setSelectedWar(war)
    setHasCalculated(false)
    setPayoutResults(null)
    setEligibilityOverrides({})
    setShowBatchURL(false)
    setBatchURL('')
    setSavedPayoutId(null)
    setSaveError(null)
    setShowHistory(false)
    setHistoricalPayouts([])

    setTotalReward(0)
    setNotes('')
    setMercCost('')
    setReviverCost('')
    setFactionTopUp('')
    setTermedMode('flat')
    setMemberShares({})
    setPostMemberShares({})
    setCutoffHours(24)
    setMemberMultiplierOverrides({})
    setPostWarHitMult(1.00)
    setPostAssistMult(0.50)
    setPostLossMult(0.50)
    setPostMugMult(0.00)
    setPostRegularHitMult(0.00)
    setPostPartWeight(50)
    setPostMemberMultiplierOverrides({})
    setPostFlatThreshold(50)
    setPostScaleEnabled(false)
    setPostScaleHours(24)
    setRaceTargetScore(0)
    setRaceCutoffMode('manual')
    setRacePostCutoffMode('flat')
    // Classification + its preset (cutoff / pre-split / post mode) from the war's flag.
    applyClassPreset(war.is_termed ? 'termed' : 'real', war)

    setActiveTab('payout')
    setFactionFilter(null)
    setFactionFilterPre(null)
    setFactionFilterPost(null)
    setFactionLookup(new Map())
    setContributionSource('official')
    setDiscrepancy(null)
    setShowDiscrepancyDetail(false)

    setLoadingWarData(true)
    try {
      const [contribs, warAttacks] = await Promise.all([
        loadWarContributions(war.id),
        loadFactionAttacksByWindow(war.start_at, war.end_at),
      ])
      const ourContribs = contribs.filter(c => c.faction_id === OUR_FACTION_ID)
      setAttacks(warAttacks)

      if (ourContribs.length === 0) {
        // No official report yet (war still in progress, or Torn hasn't published
        // it). Build the roster from scraped attacks so the payout engine — which
        // already derives all scoring from attacks — can run a live preview. Save
        // stays disabled until the official report lands.
        const liveContribs = await loadLiveContributionsFromAttacks(war)
        setContributions(liveContribs.filter(c => c.faction_id === OUR_FACTION_ID))
        setContributionSource('live')
        setDiscrepancy(null)
      } else {
        // Official report present → reconciled mode. Cross-check our attack-derived
        // scores against it so leaders are warned about scraper gaps.
        setContributions(ourContribs)
        setContributionSource('official')
        setDiscrepancy(compareContributionSources(ourContribs, warAttacks))
      }

      // Resolve opposing faction names for the Hit Report filter
      const opposingIds = collectOpposingFactionIds(warAttacks)
      if (opposingIds.size > 0) {
        try {
          const lookup = await loadFactionsByIds(opposingIds)
          setFactionLookup(lookup)
        } catch (lookupErr) {
          console.warn('Faction lookup failed:', lookupErr)
        }
      }
    } catch (err) {
      console.error('Error loading war data:', err)
    } finally {
      setLoadingWarData(false)
    }
  }

  async function handleLoadHistory() {
    setLoadingHistory(true)
    try {
      const data = await loadRecentWarPayouts(20)
      setHistoricalPayouts(data)
      setShowHistory(s => !s)
    } catch (err) {
      console.error('Error loading history:', err)
    } finally {
      setLoadingHistory(false)
    }
  }

  // Filter outgoing attacks by the opposing-faction filter (defender_faction_id).
  // Incoming attacks are not used in payout calc but we keep them for completeness.
  function applyFactionFilterToAttacks(list, filter) {
    if (!filter || filter === null) return list
    return list.filter(a => {
      const isIncoming = a.is_incoming === true || a.is_incoming === 'true' || a.is_incoming === 1
      if (isIncoming) return filter.has(Number(a.attacker_faction_id) || 0)
      return filter.has(Number(a.defender_faction_id) || 0)
    })
  }

  function computeResults(filter, overrides = eligibilityOverrides, preFilter = factionFilterPre, postFilter = factionFilterPost) {
    if (!selectedWar || contributions.length === 0) return null

    const ineligibleMembers = new Set(
      Object.entries(overrides)
        .filter(([, v]) => v === false)
        .map(([k]) => Number(k))
    )
    const forceEligibleMembers = new Set(
      Object.entries(overrides)
        .filter(([, v]) => v === true)
        .map(([k]) => Number(k))
    )

    const pw = Math.min(100, Math.max(0, Number(partWeight))) / 100
    const settings = {
      totalReward:         Number(totalReward) || 0,
      factionCutPercent:   Number(factionCutPercent),
      minScoreThreshold:   Number(minScoreThreshold),
      warHitMultiplier:    Number(warHitMult),
      assistMultiplier:    Number(assistMult),
      lossMultiplier:      Number(lossMult),
      mugMultiplier:       Number(mugMult),
      regularHitMultiplier: Number(regularHitMult),
      memberMultiplierOverrides,
      participationWeight: pw,
      contributionWeight:  Math.round((1 - pw) * 1000) / 1000,
      mercCost:      Number(mercCost) || 0,
      reviverCost:   Number(reviverCost) || 0,
      factionTopUp:  Number(factionTopUp) || 0,
      // Termed mode settings
      termedMode,
      memberShares,
      attacks,
      warStartAt:      selectedWar.start_at || 0,
      cutoffHours:     cutoffHours === '' ? 24 : Number(cutoffHours),
      ineligibleMembers,
      forceEligibleMembers,
    }

    if (warType === 'termed') {
      return calculateTermedWarPayouts(contributions, settings)
    }

    const filteredAttacks = applyFactionFilterToAttacks(attacks, filter)

    if (warType === 'race') {
      const ppw = Math.min(100, Math.max(0, Number(postPartWeight))) / 100
      const cutoffTs = Number(raceCutoffTimestamp) || 0
      // Filter each window independently, then recombine. The calc re-splits at
      // the same cutoff, so each window keeps its own faction filter.
      const preWin  = applyFactionFilterToAttacks(attacks.filter(a => (Number(a.started) || 0) <= cutoffTs), preFilter)
      const postWin = applyFactionFilterToAttacks(attacks.filter(a => (Number(a.started) || 0) >  cutoffTs), postFilter)
      return calculateRaceWarPayouts(contributions, [...preWin, ...postWin], {
        ...settings,
        raceCutoffTimestamp: cutoffTs,
        racePreCutoffPercent: Number(racePreCutoffPercent),
        // Post-cutoff formula (independent multiplier set + weight + overrides)
        postWarHitMultiplier:     Number(postWarHitMult),
        postAssistMultiplier:     Number(postAssistMult),
        postLossMultiplier:       Number(postLossMult),
        postMugMultiplier:        Number(postMugMult),
        postRegularHitMultiplier: Number(postRegularHitMult),
        postParticipationWeight:  ppw,
        postContributionWeight:   Math.round((1 - ppw) * 1000) / 1000,
        postMemberMultiplierOverrides,
        // Post-cutoff distribution mode
        postDistMode,
        postFlatThreshold: Number(postFlatThreshold) || 0,
        postScaleEnabled,
        postScaleHours: Number(postScaleHours) || 0,
        // Manual per-member share overrides for the flat post-cutoff window.
        postMemberShares,
        warStartAt: selectedWar.start_at || 0,
      })
    }

    return calculateRealWarPayouts(contributions, filteredAttacks, settings)
  }

  function handleCalculate() {
    const results = computeResults(factionFilter)
    if (!results) return

    setPayoutResults(results)
    setEligibilityOverrides({})
    setHasCalculated(true)
    setSavedPayoutId(null)
    setShowBatchURL(false)
    setBatchURL('')
    setSaveError(null)
  }

  // Keep the payout sheet in sync with the Hit Report's faction filter once
  // the user has calculated at least once (real wars only — race uses the
  // independent pre/post filters below; termed ignores attacks).
  useEffect(() => {
    if (!hasCalculated) return
    if (warType !== 'real') return
    const results = computeResults(factionFilter)
    if (results) setPayoutResults(results)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [factionFilter])

  // Race: recalc when either window's faction filter changes (each drives its own pool).
  useEffect(() => {
    if (!hasCalculated || warType !== 'race') return
    const results = computeResults(factionFilter, eligibilityOverrides, factionFilterPre, factionFilterPost)
    if (results) setPayoutResults(results)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [factionFilterPre, factionFilterPost])

  // Auto-recalculate when shares change in flat mode
  useEffect(() => {
    if (!hasCalculated) return
    if (warType !== 'termed' || termedMode !== 'flat') return
    const results = computeResults(factionFilter)
    if (results) setPayoutResults(results)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberShares])

  // Auto-recalculate when a post-cutoff flat share is manually edited (race).
  // Reducing one member's shares re-splits the post pool across the rest.
  useEffect(() => {
    if (!hasCalculated || warType !== 'race') return
    const results = computeResults(factionFilter, eligibilityOverrides, factionFilterPre, factionFilterPost)
    if (results) setPayoutResults(results)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [postMemberShares])

  // Auto-recalculate when per-member multiplier overrides change (real/race mode);
  // race has a separate post-cutoff override map.
  useEffect(() => {
    if (!hasCalculated) return
    if (warType === 'termed') return
    const results = computeResults(factionFilter)
    if (results) setPayoutResults(results)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberMultiplierOverrides, postMemberMultiplierOverrides])

  // Auto-recalculate when eligibility overrides change (all war modes)
  useEffect(() => {
    if (!hasCalculated) return
    const results = computeResults(factionFilter)
    if (results) setPayoutResults(results)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligibilityOverrides])

  function getEffectiveMembers() {
    if (!payoutResults) return []
    return payoutResults.members
  }

  async function handleSave() {
    if (!selectedWar || !payoutResults || !user?.apiKey) {
      setSaveError(!user?.apiKey ? 'Missing API key — please log in again.' : 'Nothing to save.')
      return
    }
    if (contributionSource === 'live') {
      setSaveError('Saving is disabled for live estimates — wait for Torn to publish the official war report, then recalculate and save.')
      return
    }

    setIsSaving(true)
    setSaveError(null)

    const effectiveMembers = getEffectiveMembers()
    const totalPayout = effectiveMembers.reduce((s, m) => s + (m.isEligible ? (m.payoutAmount || 0) : 0), 0)

    const payoutData = {
      war_id: selectedWar.id,
      war_type: warClass,
      faction_cut_percent: Number(factionCutPercent),
      total_reward: Number(totalReward) || 0,
      total_payout: Math.floor(totalPayout),
      member_count: effectiveMembers.length,
      min_score_threshold: Number(minScoreThreshold),
      termed_mode: postDistMode,
      merc_cost:      Number(mercCost) || 0,
      reviver_cost:   Number(reviverCost) || 0,
      faction_top_up: Number(factionTopUp) || 0,
      war_hit_multiplier:     Number(warHitMult),
      assist_multiplier:      Number(assistMult),
      loss_multiplier:        Number(lossMult),
      mug_multiplier:         Number(mugMult),
      regular_hit_multiplier: Number(regularHitMult),
      participation_weight:   Number(partWeight),
      // Unified engine fields (always saved — every payout is race-engine now)
      race_target_score:       Number(raceTargetScore) || null,
      race_cutoff_mode:        raceCutoffMode,
      race_cutoff_timestamp:   Number(raceCutoffTimestamp) || null,
      race_post_cutoff_mode:   racePostCutoffMode,
      race_pre_cutoff_percent: Number(racePreCutoffPercent),
      post_war_hit_multiplier:     Number(postWarHitMult),
      post_assist_multiplier:      Number(postAssistMult),
      post_loss_multiplier:        Number(postLossMult),
      post_mug_multiplier:         Number(postMugMult),
      post_regular_hit_multiplier: Number(postRegularHitMult),
      post_participation_weight:   Number(postPartWeight),
      post_dist_mode:      postDistMode,
      post_flat_threshold: Number(postFlatThreshold) || 0,
      post_scale_enabled:  postScaleEnabled,
      post_scale_hours:    Number(postScaleHours) || 0,
      notes: notes || null,
    }
    // For race wars, persist the per-window breakdown so the member view can
    // reconstruct the "80 (16)" split and the two hit-report tabs.
    const raceBreakdown = (m) => {
      if (warType !== 'race') return null
      const win = (w, payout) => w ? {
        leaves: w.leaves, mugs: w.mugs, hosp: w.hosp, warHits: w.warHits,
        regularHits: w.regularHits, won: w.won, assists: w.assists, losses: w.losses,
        totalHits: w.totalHits,
        participationScore: w.participationScore, participationShare: w.participationShare,
        respectGained: w.respectGained, bonusRespect: w.bonusRespect,
        adjustedRespect: w.adjustedRespect, contributionShare: w.contributionShare,
        // Flat-distribution fields (present when post mode is 'flat')
        score: w.score, shares: w.shares,
        payout,
      } : null
      return { pre: win(m.pre, m.preCutoffPayout), post: win(m.post, m.postCutoffPayout) }
    }
    const memberRecords = effectiveMembers.map(m => ({
      member_id: m.memberId,
      member_name: m.memberName,
      score: m.respectGained ?? m.score ?? 0,
      attacks: m.totalHits || m.attacks || 0,
      assist_attacks: m.assists || 0,
      war_hits: m.warHits || 0,
      regular_hits: m.regularHits || 0,
      mugs: m.mugs || 0,
      losses: m.losses || 0,
      payout_amount: m.payoutAmount,
      is_eligible: m.isEligible,
      multiplier_overrides: memberMultiplierOverrides[m.memberId] || null,
      race_breakdown: raceBreakdown(m),
    }))

    try {
      // is_termed mirrors the Real/Termed classification the user picked.
      const newIsTermed = warClass === 'termed'
      if (Boolean(selectedWar.is_termed) !== newIsTermed) {
        await updateWarIsTermed(selectedWar.id, newIsTermed, user.apiKey)
        setSelectedWar(prev => prev ? { ...prev, is_termed: newIsTermed } : prev)
        setWars(prev => prev.map(w => w.id === selectedWar.id ? { ...w, is_termed: newIsTermed } : w))
      }

      const result = await saveWarPayout(payoutData, memberRecords, user.apiKey)
      setSavedPayoutId(result.payoutId)
    } catch (err) {
      console.error('Error saving war payout:', err)
      setSaveError(err.message || 'Failed to save payout')
    } finally {
      setIsSaving(false)
    }
  }

  // Matches the OC PayoutManagement flow: copy first, then ask about saving.
  // 1) Generate the URL.
  // 2) Copy it to the clipboard immediately (the user usually wants the URL
  //    in hand within one click; the on-screen copy button is a fallback).
  // 3) Surface the URL panel so the user can still copy it manually.
  // 4) If this payout hasn't been persisted yet, ask whether to save.
  //    A "no" answer leaves the URL available for use without a DB row.
  async function handleGenerateBatchURL() {
    if (!hasCalculated) return

    const effectiveMembers = getEffectiveMembers()
    const url = generateWarBatchPayoutURL(effectiveMembers)
    if (!url) {
      setSaveError('No valid payouts to generate URL')
      return
    }
    setBatchURL(url)
    setShowBatchURL(true)

    // Best-effort copy. Some browsers reject clipboard writes without a
    // recent user gesture; the on-screen Copy URL button covers that case.
    try {
      await navigator.clipboard.writeText(url)
      setBatchURLCopied(true)
      setTimeout(() => setBatchURLCopied(false), 2000)
    } catch (e) {
      console.warn('Auto-copy failed; user can use the Copy URL button:', e)
    }

    // Live estimates are preview-only — the URL is provisional and we don't
    // offer to persist a DB row until the official report lands.
    if (!savedPayoutId && contributionSource !== 'live') {
      if (window.confirm('Batch URL copied! Would you like to save this payout to the database?')) {
        await handleSave()
      }
    }
  }

  async function handleCopyURL() {
    if (!batchURL) return
    try {
      await navigator.clipboard.writeText(batchURL)
      setBatchURLCopied(true)
      setTimeout(() => setBatchURLCopied(false), 2000)
    } catch {
      // Fallback: select text
    }
  }

  const effectiveMembers = getEffectiveMembers()
  const totalPayout = effectiveMembers.reduce((s, m) => s + (m.isEligible ? m.payoutAmount : 0), 0)
  const eligibleCount = effectiveMembers.filter(m => m.isEligible).length

  // Total of our attack-derived war scores (raw respect, matches the official
  // war-report total). Used for the live sanity line vs ranked_wars.our_score.
  const derivedScoreTotal = useMemo(() => {
    let t = 0
    for (const v of deriveWarScoresByMember(attacks).values()) t += v
    return Math.round(t)
  }, [attacks])

  // Race wars: pay-per-hit and hit counts split across the cutoff, so leaders can
  // see the pre- vs post-cutoff rate. Uses each member's pre/post hit buckets and
  // the respective pre/post pool from the calc.
  const raceHitSplit = (() => {
    if (warType !== 'race' || !payoutResults) return null
    const preHits  = effectiveMembers.reduce((s, m) => s + (m.pre?.totalHits || 0), 0)
    const postHits = effectiveMembers.reduce((s, m) => s + (m.post?.totalHits || 0), 0)
    return {
      preHits,
      postHits,
      prePayPerHit:  preHits  > 0 ? Math.floor((payoutResults.preCutoffPool  ?? 0) / preHits)  : 0,
      postPayPerHit: postHits > 0 ? Math.floor((payoutResults.postCutoffPool ?? 0) / postHits) : 0,
    }
  })()

  function handleSortCol(col) {
    if (sortCol === col) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortCol(col)
      setSortDir('desc')
    }
  }

  function sortedMembers() {
    const dir = sortDir === 'asc' ? 1 : -1
    return effectiveMembers.slice().sort((a, b) => {
      switch (sortCol) {
        case 'name':         return dir * a.memberName.localeCompare(b.memberName)
        case 'leaves':       return dir * ((a.leaves ?? 0) - (b.leaves ?? 0))
        case 'mugs':         return dir * ((a.mugs ?? 0) - (b.mugs ?? 0))
        case 'hosp':         return dir * ((a.hosp ?? 0) - (b.hosp ?? 0))
        case 'warHits':      return dir * ((a.warHits ?? 0) - (b.warHits ?? 0))
        case 'won':          return dir * ((a.won ?? 0) - (b.won ?? 0))
        case 'assists':      return dir * ((a.assists ?? 0) - (b.assists ?? 0))
        case 'losses':       return dir * ((a.losses ?? 0) - (b.losses ?? 0))
        case 'totalHits':    return dir * ((a.totalHits ?? 0) - (b.totalHits ?? 0))
        case 'warHitScore':      return dir * ((a.warHitScore ?? 0) - (b.warHitScore ?? 0))
        case 'assistScore':      return dir * ((a.assistScore ?? 0) - (b.assistScore ?? 0))
        case 'lossScore':        return dir * ((a.lossScore ?? 0) - (b.lossScore ?? 0))
        case 'partScore':        return dir * ((a.participationScore ?? 0) - (b.participationScore ?? 0))
        case 'partShare':        return dir * ((a.participationShare ?? 0) - (b.participationShare ?? 0))
        case 'respect':          return dir * ((a.respectGained ?? a.score ?? 0) - (b.respectGained ?? b.score ?? 0))
        case 'bonusRespect':     return dir * ((a.bonusRespect ?? 0) - (b.bonusRespect ?? 0))
        case 'adjustedRespect':  return dir * ((a.adjustedRespect ?? 0) - (b.adjustedRespect ?? 0))
        case 'contribShare':     return dir * ((a.contributionShare ?? 0) - (b.contributionShare ?? 0))
        case 'effort':           return dir * ((a.effortShare ?? 0) - (b.effortShare ?? 0))
        case 'shares':           return dir * ((a.shares ?? 0) - (b.shares ?? 0))
        case 'regularHits':      return dir * ((a.regularHits ?? 0) - (b.regularHits ?? 0))
        case 'regularHitScore':  return dir * ((a.regularHitScore ?? 0) - (b.regularHitScore ?? 0))
        case 'preCutoffScore':   return dir * ((a.preCutoffScore ?? 0) - (b.preCutoffScore ?? 0))
        case 'score':            return dir * ((a.score ?? 0) - (b.score ?? 0))
        case 'bonusReduction':   return dir * ((a.bonusReduction ?? 0) - (b.bonusReduction ?? 0))
        case 'postCutoffScore':  return dir * ((a.postCutoffScore ?? 0) - (b.postCutoffScore ?? 0))
        case 'preCutoffPayout':  return dir * ((a.preCutoffPayout ?? 0) - (b.preCutoffPayout ?? 0))
        case 'postCutoffPayout': return dir * ((a.postCutoffPayout ?? 0) - (b.postCutoffPayout ?? 0))
        case 'payout':           return dir * (a.payoutAmount - b.payoutAmount)
        case 'eligible':         return dir * ((a.isEligible ? 1 : 0) - (b.isEligible ? 1 : 0))
        default:
          // Race dual-block columns use dotted keys like "pre.warHits" / "post.participationScore".
          if (sortCol.includes('.')) {
            const [w, k] = sortCol.split('.')
            return dir * ((a[w]?.[k] ?? 0) - (b[w]?.[k] ?? 0))
          }
          return dir * (a.payoutAmount - b.payoutAmount)
      }
    })
  }

  function SortHeader({ col, label, className = '' }) {
    const active = sortCol === col
    const hasStickyLeft = className.includes('left-0')
    const stickyTop = hasStickyLeft
      ? '' // explicit sticky already set in className
      : 'sticky top-[32px] z-10 bg-gray-50 dark:bg-slate-700'
    return (
      <th
        className={`px-3 py-1.5 font-medium cursor-pointer select-none hover:text-gray-700 dark:hover:text-gray-200 transition-colors ${stickyTop} ${className}`}
        onClick={() => handleSortCol(col)}
      >
        {label}
        <span className="ml-1 text-gray-400 text-xs">
          {active ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
        </span>
      </th>
    )
  }

  // ── Race dual-block payout-sheet helpers ────────────────────────────────
  // For race wars the Hit Report / Participation / Contribution sections are
  // duplicated into a Pre-Cutoff block and a Post-Cutoff block, each reading
  // from m.pre / m.post and each editing its own per-member multiplier overrides.
  const racePartColSpan = viewMode === 'leader' ? 12 : 7

  function raceGroupHeaders(label, flat = false) {
    const th = (cls, span, text) => (
      <th className={`px-2 py-2 font-semibold border-b border-l border-gray-200 dark:border-slate-700 sticky top-0 z-20 text-center ${cls}`} colSpan={span}>{text}</th>
    )
    if (flat) {
      return (
        <>
          {th('bg-blue-50 dark:bg-slate-800 text-blue-800 dark:text-blue-300', 8, `${label} · Hit Report`)}
          {th('bg-purple-50 dark:bg-slate-800 text-purple-800 dark:text-purple-300', 2, `${label} · Flat Shares`)}
        </>
      )
    }
    return (
      <>
        {th('bg-blue-50 dark:bg-slate-800 text-blue-800 dark:text-blue-300', 8, `${label} · Hit Report`)}
        {th('bg-emerald-50 dark:bg-slate-800 text-emerald-800 dark:text-emerald-300', racePartColSpan, `${label} · Participation`)}
        {th('bg-amber-50 dark:bg-slate-800 text-amber-800 dark:text-amber-300', 4, `${label} · Contribution`)}
      </>
    )
  }

  function raceColHeaders(winKey, flat = false) {
    const c = (k) => `${winKey}.${k}`
    const mh = () => viewMode === 'leader'
      ? <th className="px-1 py-1.5 text-right text-[10px] font-normal sticky top-[32px] z-10 bg-gray-50 dark:bg-slate-700 text-gray-400">×</th>
      : null
    const hitReport = (
      <>
        <SortHeader col={c('leaves')}    label="Leaves" className="text-right border-l border-gray-200 dark:border-slate-700" />
        <SortHeader col={c('mugs')}      label="Mugs"   className="text-right" />
        <SortHeader col={c('hosp')}      label="Hosp"   className="text-right" />
        <SortHeader col={c('warHits')}   label="War"    className="text-right" />
        <SortHeader col={c('won')}       label="Won"    className="text-right" />
        <SortHeader col={c('assists')}   label="Assists" className="text-right" />
        <SortHeader col={c('losses')}    label="Lost"   className="text-right" />
        <SortHeader col={c('totalHits')} label="Total"  className="text-right border-r border-gray-200 dark:border-slate-700" />
      </>
    )
    if (flat) {
      return (
        <>
          {hitReport}
          <SortHeader col={c('score')}  label="Score"  className="text-right border-l border-gray-200 dark:border-slate-700" />
          <SortHeader col={c('shares')} label="Shares" className="text-right border-r border-gray-200 dark:border-slate-700" />
        </>
      )
    }
    return (
      <>
        {hitReport}
        <SortHeader col={c('warHitScore')} label="War hit" title="War wins excluding war mugs" className="text-right border-l border-gray-200 dark:border-slate-700" />
        {mh()}
        <SortHeader col={c('assistScore')} label="Assist" title="War assists only" className="text-right" />
        {mh()}
        <SortHeader col={c('lossScore')} label="Loss" title="War losses only" className="text-right" />
        {mh()}
        <SortHeader col={c('mugScore')} label="War Mug" title="Mugs that happened during war hits" className="text-right" />
        {mh()}
        <SortHeader col={c('regularHitScore')} label="Outside" title="All non-war wins (leaves + mugs + hosp combined)" className="text-right" />
        {mh()}
        <SortHeader col={c('participationScore')} label="Total" className="text-right" />
        <SortHeader col={c('participationShare')} label="Part%" className="text-right border-r border-gray-200 dark:border-slate-700" />
        <SortHeader col={c('respectGained')}   label="Respect" className="text-right border-l border-gray-200 dark:border-slate-700" />
        <SortHeader col={c('bonusRespect')}    label="Bonus"   className="text-right" />
        <SortHeader col={c('adjustedRespect')} label="Adj."    className="text-right" />
        <SortHeader col={c('contributionShare')} label="Contrib%" className="text-right border-r border-gray-200 dark:border-slate-700" />
      </>
    )
  }

  function raceWindowCells(m, winKey, globalMults, overrides, setOverrides, flat = false) {
    const w = m[winKey] || {}
    const hasOverride = (key) => overrides[m.memberId]?.[key] !== undefined
    const overrideCls = 'border border-amber-400 dark:border-amber-500'
    const normalCls = 'border border-gray-200 dark:border-slate-600'
    const multInput = (effKey, settingKey, globalVal) => (
      <td className="px-0 py-0.5 text-right" key={`${winKey}-${settingKey}`}>
        <input type="number" step="0.05"
          value={w[effKey] ?? globalVal}
          onChange={e => {
            const v = parseFloat(e.target.value)
            setOverrides(prev => {
              const cur = { ...(prev[m.memberId] || {}) }
              if (v === Number(globalVal)) { delete cur[settingKey] } else { cur[settingKey] = v }
              return { ...prev, [m.memberId]: Object.keys(cur).length ? cur : undefined }
            })
          }}
          className={`w-12 px-0.5 py-0 text-[10px] text-right rounded bg-white dark:bg-slate-700 text-gray-700 dark:text-gray-300 ${hasOverride(settingKey) ? overrideCls : normalCls}`}
        />
      </td>
    )
    const num = (v) => Number(v ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })
    return (
      <>
        {/* Hit Report */}
        <td className="px-2 py-1 text-right text-gray-600 dark:text-gray-400 border-l border-gray-200 dark:border-slate-700">{w.leaves ?? 0}</td>
        <td className="px-2 py-1 text-right text-gray-600 dark:text-gray-400">{w.mugs ?? 0}</td>
        <td className="px-2 py-1 text-right text-gray-600 dark:text-gray-400">{w.hosp ?? 0}</td>
        <td className="px-2 py-1 text-right font-medium text-blue-700 dark:text-blue-400">{w.warHits ?? 0}</td>
        <td className="px-2 py-1 text-right text-gray-600 dark:text-gray-400">{w.won ?? 0}</td>
        <td className="px-2 py-1 text-right text-gray-600 dark:text-gray-400">{w.assists ?? 0}</td>
        <td className="px-2 py-1 text-right text-gray-600 dark:text-gray-400">{w.losses ?? 0}</td>
        <td className="px-2 py-1 text-right font-medium text-gray-700 dark:text-gray-300 border-r border-gray-200 dark:border-slate-700">{w.totalHits ?? 0}</td>
        {flat ? (
          <>
            {/* Flat shares: windowed score + editable shares. Leaders can tweak
                a member's shares (penalty / bonus); the split re-spreads the
                post pool across everyone else. Amber border = manual override. */}
            <td className="px-2 py-1 text-right text-gray-600 dark:text-gray-400 border-l border-gray-200 dark:border-slate-700">{num(w.score)}</td>
            <td className="px-1 py-0.5 text-right border-r border-gray-200 dark:border-slate-700">
              {viewMode === 'leader' ? (
                <input
                  type="number" min="0" step="0.5"
                  value={postMemberShares[m.memberId] ?? Number((w.shares ?? 0).toFixed(2))}
                  onChange={e => {
                    const val = Math.max(0, Number(e.target.value) || 0)
                    setPostMemberShares(prev => ({ ...prev, [m.memberId]: val }))
                  }}
                  className={`w-14 px-1 py-0.5 text-xs text-right rounded bg-white dark:bg-slate-700 font-medium text-purple-700 dark:text-purple-400 ${w.sharesOverridden ? 'border border-amber-400 dark:border-amber-500' : 'border border-gray-300 dark:border-slate-600'}`}
                />
              ) : (
                <span className="font-medium text-purple-700 dark:text-purple-400">{(w.shares ?? 0).toFixed(2)}</span>
              )}
            </td>
          </>
        ) : (
        <>
        {/* Participation — non-overlapping categories.
            War Hit = warHits − warMugs (war wins ex-mugs)
            War Mug = warMugs (war wins that are mugs)
            Assist  / Loss = war-only
            Outside = regularHits (all non-war wins, type-agnostic) */}
        <td className="px-2 py-1 text-right text-gray-600 dark:text-gray-400 border-l border-gray-200 dark:border-slate-700"
            title={`${w.warNonMugHits ?? Math.max(0, (w.warHits ?? 0) - (w.warMugs ?? 0))} war hits × ${(w.effWarHitMult ?? globalMults.warHit) ?? 0}`}>{(w.warHitScore ?? 0).toFixed(2)}</td>
        {viewMode === 'leader' && multInput('effWarHitMult', 'warHitMultiplier', globalMults.warHit)}
        <td className="px-2 py-1 text-right text-gray-600 dark:text-gray-400"
            title={`${w.warAssists ?? 0} war assists × ${(w.effAssistMult ?? globalMults.assist) ?? 0}`}>{(w.assistScore ?? 0).toFixed(2)}</td>
        {viewMode === 'leader' && multInput('effAssistMult', 'assistMultiplier', globalMults.assist)}
        <td className="px-2 py-1 text-right text-gray-600 dark:text-gray-400"
            title={`${w.warLosses ?? 0} war losses × ${(w.effLossMult ?? globalMults.loss) ?? 0}`}>{(w.lossScore ?? 0).toFixed(2)}</td>
        {viewMode === 'leader' && multInput('effLossMult', 'lossMultiplier', globalMults.loss)}
        <td className="px-2 py-1 text-right text-red-600 dark:text-red-400"
            title={`${w.warMugs ?? 0} war mugs × ${(w.effMugMult ?? globalMults.mug) ?? 0}`}>{(w.mugScore ?? 0).toFixed(2)}</td>
        {viewMode === 'leader' && multInput('effMugMult', 'mugMultiplier', globalMults.mug)}
        <td className="px-2 py-1 text-right text-gray-600 dark:text-gray-400"
            title={`${w.regularHits ?? 0} outside hits × ${(w.effRegularMult ?? globalMults.regular) ?? 0}`}>{(w.regularHitScore ?? 0).toFixed(2)}</td>
        {viewMode === 'leader' && multInput('effRegularMult', 'regularHitMultiplier', globalMults.regular)}
        <td className="px-2 py-1 text-right font-medium text-gray-700 dark:text-gray-300">{(w.participationScore ?? 0).toFixed(2)}</td>
        <td className="px-2 py-1 text-right font-medium text-gray-700 dark:text-gray-300 border-r border-gray-200 dark:border-slate-700">{((w.participationShare ?? 0) * 100).toFixed(2)}%</td>
        {/* Contribution */}
        <td className="px-2 py-1 text-right text-gray-600 dark:text-gray-400 border-l border-gray-200 dark:border-slate-700">{num(w.respectGained)}</td>
        <td className="px-2 py-1 text-right text-amber-600 dark:text-amber-400">{(w.bonusRespect ?? 0) > 0 ? `−${num(w.bonusRespect)}` : ''}</td>
        <td className="px-2 py-1 text-right text-gray-600 dark:text-gray-400">{num(w.adjustedRespect)}</td>
        <td className="px-2 py-1 text-right font-medium text-gray-700 dark:text-gray-300 border-r border-gray-200 dark:border-slate-700">{((w.contributionShare ?? 0) * 100).toFixed(2)}%</td>
        </>
        )}
      </>
    )
  }

  const preMults  = { warHit: warHitMult, assist: assistMult, loss: lossMult, mug: mugMult, regular: regularHitMult }
  const postMults = { warHit: postWarHitMult, assist: postAssistMult, loss: postLossMult, mug: postMugMult, regular: postRegularHitMult }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-gray-900 dark:text-white">RW Payout Management</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Calculate and save ranked war payouts based on member contributions and cache rewards.
        </p>
      </div>

      {/* Settings panel — full width with embedded war selector */}
      <div className="bg-white dark:bg-slate-800 rounded-lg border border-gray-200 dark:border-slate-700 p-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-gray-900 dark:text-white">Payout Settings</h3>
          <div className="flex items-center gap-2">
            <button
              onClick={handleLoadHistory}
              disabled={loadingHistory}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                showHistory
                  ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-400'
                  : 'border-gray-300 dark:border-slate-600 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-slate-700'
              }`}
            >
              {loadingHistory ? 'Loading...' : 'View History'}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Col 1: war selector + war type + faction cut + total reward + notes */}
          <div className="space-y-3">
            <WarDropdown
              wars={wars}
              totalWars={totalWars}
              selectedWar={selectedWar}
              onSelect={handleSelectWar}
              page={warPage}
              onPageChange={handlePageChange}
              loadingWars={loadingWars}
            />

            {loadingWarData && (
              <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-blue-600"></div>
                Loading war data...
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                Classification
              </label>
              <div className="flex gap-2">
                <button
                  onClick={() => applyClassPreset('real', selectedWar)}
                  className={`flex-1 py-1.5 text-sm rounded border transition-colors ${
                    warClass === 'real'
                      ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400'
                      : 'border-gray-300 dark:border-slate-600 text-gray-600 dark:text-gray-400'
                  }`}
                >
                  Real
                </button>
                <button
                  onClick={() => applyClassPreset('termed', selectedWar)}
                  className={`flex-1 py-1.5 text-sm rounded border transition-colors ${
                    warClass === 'termed'
                      ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-400'
                      : 'border-gray-300 dark:border-slate-600 text-gray-600 dark:text-gray-400'
                  }`}
                >
                  Termed
                </button>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Historical tag + a starting preset. All payouts use the unified
                pre/post engine below — set a mid-war cutoff &amp; pool split to run a race.
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                Faction Cut (%)
              </label>
              <input
                type="number"
                min="0"
                max="100"
                step="1"
                value={factionCutPercent}
                onChange={e => setFactionCutPercent(e.target.value)}
                className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-gray-900 dark:text-white"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                Total Reward ($)
              </label>
              <input
                type="number"
                min="0"
                step="1"
                value={totalReward || ''}
                onChange={e => setTotalReward(Number(e.target.value) || 0)}
                placeholder="0"
                className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-gray-900 dark:text-white"
              />
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                Total value of all war rewards (caches, items, etc.)
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                Notes
              </label>
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                rows={2}
                placeholder="Optional notes for this payout..."
                className="w-full px-2 py-1.5 text-xs border border-gray-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-gray-900 dark:text-white resize-none"
              />
            </div>
          </div>

          {/* Col 2: war-type-specific settings */}
          <div className="space-y-3">
            {warType === 'termed' ? (
                <>
                  <h4 className="text-xs font-semibold text-purple-700 dark:text-purple-400 uppercase tracking-wider">
                    Termed War Settings
                  </h4>

                  {/* Mode toggle */}
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                      Payout Mode
                    </label>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setTermedMode('flat')}
                        className={`flex-1 py-1.5 text-sm rounded border transition-colors ${
                          termedMode === 'flat'
                            ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-400'
                            : 'border-gray-300 dark:border-slate-600 text-gray-600 dark:text-gray-400'
                        }`}
                      >
                        Flat Shares
                      </button>
                      <button
                        onClick={() => setTermedMode('scaling')}
                        className={`flex-1 py-1.5 text-sm rounded border transition-colors ${
                          termedMode === 'scaling'
                            ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-400'
                            : 'border-gray-300 dark:border-slate-600 text-gray-600 dark:text-gray-400'
                        }`}
                      >
                        Scaling
                      </button>
                    </div>
                  </div>

                  {/* Min score threshold — shared by both modes */}
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                      Minimum Score Threshold
                    </label>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={minScoreThreshold}
                      onChange={e => setMinScoreThreshold(e.target.value)}
                      className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-gray-900 dark:text-white"
                    />
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                      Members must score at least this much to be paid.
                    </p>
                  </div>

                  {/* Flat mode hint */}
                  {termedMode === 'flat' && (
                    <p className="text-xs text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-slate-700/40 px-3 py-2 rounded">
                      Pool is split by shares. Eligible members default to 1 share — set to 2 for double pay, 0 to exclude. Adjust shares in the results table after calculating.
                    </p>
                  )}

                  {/* Scaling mode settings */}
                  {termedMode === 'scaling' && (
                    <>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                          Cutoff Hours (from war start)
                        </label>
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={cutoffHours}
                          onChange={e => setCutoffHours(Number(e.target.value) || 0)}
                          className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-gray-900 dark:text-white"
                        />
                      </div>
                      <p className="text-xs text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-slate-700/40 px-3 py-2 rounded">
                        Members earn 1 base share if they reach the score threshold before the cutoff.
                        After the cutoff, every additional threshold-worth of respect earns 1 more share
                        (fractional shares allowed). Pool is split by total shares.
                      </p>
                    </>
                  )}
                </>
              ) : null}

            {(warType === 'real' || warType === 'race') && (
                <>
                  <h4 className="text-xs font-semibold text-blue-700 dark:text-blue-400 uppercase tracking-wider">
                    {warType === 'race' ? 'Race War Formula (Pre-Cutoff)' : 'Real War Formula'}
                  </h4>

                  {/* Weight slider */}
                  <div>
                    <div className="flex justify-between text-xs text-gray-600 dark:text-gray-400 mb-1">
                      <span className="font-medium">Participation / Contribution</span>
                      <span className="text-gray-400">{partWeight}% / {100 - partWeight}%</span>
                    </div>
                    <input
                      type="range"
                      min="0" max="100" step="1"
                      value={partWeight}
                      onChange={e => setPartWeight(Number(e.target.value))}
                      className="w-full h-1.5 rounded-lg appearance-none cursor-pointer bg-gradient-to-r from-blue-400 to-emerald-400"
                    />
                    <div className="flex gap-2 mt-1.5">
                      <div className="flex-1">
                        <label className="text-xs text-blue-600 dark:text-blue-400">Participation %</label>
                        <input
                          type="number" min="0" max="100" step="1"
                          value={partWeight}
                          onChange={e => setPartWeight(Math.min(100, Math.max(0, Number(e.target.value))))}
                          className="w-full px-2 py-1 text-xs border border-gray-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-gray-900 dark:text-white"
                        />
                      </div>
                      <div className="flex-1">
                        <label className="text-xs text-emerald-600 dark:text-emerald-400">Contribution %</label>
                        <input
                          type="number" min="0" max="100" step="1"
                          value={100 - partWeight}
                          onChange={e => setPartWeight(Math.min(100, Math.max(0, 100 - Number(e.target.value))))}
                          className="w-full px-2 py-1 text-xs border border-gray-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-gray-900 dark:text-white"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Attack multipliers */}
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">
                      Participation Multipliers
                    </label>
                    <div className="space-y-1.5">
                      {[
                        { label: 'War Hit ×',    value: warHitMult,    set: setWarHitMult,    step: '0.05' },
                        { label: 'Assist ×',     value: assistMult,    set: setAssistMult,    step: '0.05' },
                        { label: 'Loss ×',       value: lossMult,      set: setLossMult,      step: '0.05' },
                        { label: 'War Mug ×',    value: mugMult,       set: setMugMult,       step: '0.05' },
                        { label: 'Outside ×',    value: regularHitMult, set: setRegularHitMult, step: '0.05' },
                      ].map(({ label, value, set, step }) => (
                        <div key={label} className="flex items-center gap-2">
                          <span className="text-xs text-gray-600 dark:text-gray-400 w-16 sm:w-20 flex-shrink-0">{label}</span>
                          <input
                            type="number"
                            step={step}
                            value={value}
                            onChange={e => set(e.target.value)}
                            className="w-full px-2 py-1 text-xs border border-gray-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-gray-900 dark:text-white"
                          />
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Pool adjustments */}
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">
                      Pool Adjustments ($)
                    </label>
                    <div className="space-y-1.5">
                      {[
                        { label: 'Mercenaries', value: mercCost,     set: setMercCost,     sign: '−' },
                        { label: 'Revivers',    value: reviverCost,  set: setReviverCost,  sign: '−' },
                        { label: 'Faction Top-up', value: factionTopUp, set: setFactionTopUp, sign: '+' },
                      ].map(({ label, value, set, sign }) => (
                        <div key={label} className="flex items-center gap-2">
                          <span className="text-xs text-gray-600 dark:text-gray-400 w-24 sm:w-32 flex-shrink-0">
                            <span className={sign === '−' ? 'text-red-500' : 'text-green-600'}>{sign}</span> {label}
                          </span>
                          <input
                            type="number"
                            min="0"
                            step="1"
                            value={value}
                            onChange={e => set(e.target.value)}
                            placeholder="0"
                            className="w-full px-2 py-1 text-xs border border-gray-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-gray-900 dark:text-white"
                          />
                        </div>
                      ))}
                    </div>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      Mercs and revivers are subtracted before faction cut; top-up is added after.
                    </p>
                  </div>
                </>
            )}

            {/* Race-specific settings */}
            {warType === 'race' && (
              <>
                <h4 className="text-xs font-semibold text-amber-700 dark:text-amber-400 uppercase tracking-wider mt-4">
                  Race Settings
                </h4>

                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                    Target Score
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={raceTargetScore || ''}
                    onChange={e => setRaceTargetScore(Number(e.target.value) || 0)}
                    placeholder="e.g. 500"
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-gray-900 dark:text-white"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                    Cutoff Mode
                  </label>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setRaceCutoffMode('auto')}
                      className={`flex-1 py-1.5 text-sm rounded border transition-colors ${
                        raceCutoffMode === 'auto'
                          ? 'border-amber-500 bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400'
                          : 'border-gray-300 dark:border-slate-600 text-gray-600 dark:text-gray-400'
                      }`}
                    >
                      Auto-detect
                    </button>
                    <button
                      onClick={() => {
                        setRaceCutoffMode('manual')
                        // Snap an unset/far-future sentinel (e.g. year-5138 from an
                        // old saved payout) to the war's start; keep any real
                        // detected/typed value.
                        setRaceCutoffTimestamp(ts =>
                          (!ts || ts > 4102444800) ? (selectedWar?.start_at || Math.floor(Date.now() / 1000)) : ts
                        )
                      }}
                      className={`flex-1 py-1.5 text-sm rounded border transition-colors ${
                        raceCutoffMode === 'manual'
                          ? 'border-amber-500 bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400'
                          : 'border-gray-300 dark:border-slate-600 text-gray-600 dark:text-gray-400'
                      }`}
                    >
                      Manual TCT
                    </button>
                  </div>
                </div>

                {raceCutoffMode === 'auto' && selectedWar && attacks.length > 0 && (
                  <div>
                    <button
                      onClick={() => {
                        const ts = detectRaceCutoff(attacks, Number(raceTargetScore) || 0)
                        setRaceCutoffTimestamp(ts)
                      }}
                      disabled={!raceTargetScore}
                      className="w-full py-1.5 text-sm bg-amber-600 hover:bg-amber-700 text-white rounded-lg disabled:opacity-50 transition-colors"
                    >
                      Detect Cutoff
                    </button>
                    {raceCutoffTimestamp && (
                      <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">
                        Cutoff detected: {new Date(raceCutoffTimestamp * 1000).toISOString().slice(0, 16).replace('T', ' ')} TCT
                      </p>
                    )}
                    {raceCutoffTimestamp === null && raceTargetScore > 0 && (
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                        Neither faction reached {raceTargetScore} in available attacks.
                      </p>
                    )}
                  </div>
                )}

                {raceCutoffMode === 'manual' && (
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                      Manual Cutoff (TCT)
                    </label>
                    <input
                      type="datetime-local"
                      value={tsToTctInput(raceCutoffTimestamp)}
                      onChange={e => setRaceCutoffTimestamp(tctInputToTs(e.target.value))}
                      className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-gray-900 dark:text-white"
                    />
                    {raceCutoffTimestamp && (
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                        {new Date(raceCutoffTimestamp * 1000).toISOString().slice(0, 16).replace('T', ' ')} TCT
                      </p>
                    )}
                  </div>
                )}

                <div>
                  <div className="flex justify-between text-xs text-gray-600 dark:text-gray-400 mb-1">
                    <span className="font-medium">Pre / Post Cutoff Pool Split</span>
                    <span className="text-gray-400">{racePreCutoffPercent}% / {100 - racePreCutoffPercent}%</span>
                  </div>
                  <input
                    type="range"
                    min="0" max="100" step="1"
                    value={racePreCutoffPercent}
                    onChange={e => setRacePreCutoffPercent(Number(e.target.value))}
                    className="w-full h-1.5 rounded-lg appearance-none cursor-pointer bg-gradient-to-r from-blue-400 to-purple-400"
                  />
                  <div className="flex gap-2 mt-1.5">
                    <div className="flex-1">
                      <label className="text-xs text-blue-600 dark:text-blue-400">Pre %</label>
                      <input
                        type="number" min="0" max="100" step="1"
                        value={racePreCutoffPercent}
                        onChange={e => setRacePreCutoffPercent(Math.min(100, Math.max(0, Number(e.target.value) || 0)))}
                        className="w-full px-2 py-1 text-xs border border-gray-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-gray-900 dark:text-white"
                      />
                    </div>
                    <div className="flex-1">
                      <label className="text-xs text-purple-600 dark:text-purple-400">Post %</label>
                      <input
                        type="number" min="0" max="100" step="1"
                        value={100 - racePreCutoffPercent}
                        onChange={e => setRacePreCutoffPercent(100 - Math.min(100, Math.max(0, Number(e.target.value) || 0)))}
                        className="w-full px-2 py-1 text-xs border border-gray-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-gray-900 dark:text-white"
                      />
                    </div>
                  </div>
                </div>

                {/* Post-Cutoff distribution — Formula or Flat shares */}
                <h4 className="text-xs font-semibold text-purple-700 dark:text-purple-400 uppercase tracking-wider mt-4">
                  Post-Cutoff Distribution
                </h4>
                <div className="flex gap-2">
                  <button
                    onClick={() => setPostDistMode('formula')}
                    className={`flex-1 py-1.5 text-sm rounded border transition-colors ${
                      postDistMode === 'formula'
                        ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-400'
                        : 'border-gray-300 dark:border-slate-600 text-gray-600 dark:text-gray-400'
                    }`}
                  >
                    Formula
                  </button>
                  <button
                    onClick={() => setPostDistMode('flat')}
                    className={`flex-1 py-1.5 text-sm rounded border transition-colors ${
                      postDistMode === 'flat'
                        ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-400'
                        : 'border-gray-300 dark:border-slate-600 text-gray-600 dark:text-gray-400'
                    }`}
                  >
                    Flat Shares
                  </button>
                </div>

                {postDistMode === 'formula' && (
                  <>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      Same real-war formula as pre-cutoff, with its own multipliers — e.g. set Outside ×
                      to 0 so non-war hits aren't paid after the cutoff.
                    </p>
                    <div>
                      <div className="flex justify-between text-xs text-gray-600 dark:text-gray-400 mb-1">
                        <span className="font-medium">Participation / Contribution</span>
                        <span className="text-gray-400">{postPartWeight}% / {100 - postPartWeight}%</span>
                      </div>
                      <input
                        type="range" min="0" max="100" step="1"
                        value={postPartWeight}
                        onChange={e => setPostPartWeight(Number(e.target.value))}
                        className="w-full h-1.5 rounded-lg appearance-none cursor-pointer bg-gradient-to-r from-blue-400 to-emerald-400"
                      />
                      <div className="flex gap-2 mt-1.5">
                        <div className="flex-1">
                          <label className="text-xs text-blue-600 dark:text-blue-400">Participation %</label>
                          <input
                            type="number" min="0" max="100" step="1"
                            value={postPartWeight}
                            onChange={e => setPostPartWeight(Math.min(100, Math.max(0, Number(e.target.value) || 0)))}
                            className="w-full px-2 py-1 text-xs border border-gray-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-gray-900 dark:text-white"
                          />
                        </div>
                        <div className="flex-1">
                          <label className="text-xs text-emerald-600 dark:text-emerald-400">Contribution %</label>
                          <input
                            type="number" min="0" max="100" step="1"
                            value={100 - postPartWeight}
                            onChange={e => setPostPartWeight(100 - Math.min(100, Math.max(0, Number(e.target.value) || 0)))}
                            className="w-full px-2 py-1 text-xs border border-gray-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-gray-900 dark:text-white"
                          />
                        </div>
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">
                        Post-Cutoff Multipliers
                      </label>
                      <div className="space-y-1.5">
                        {[
                          { label: 'War Hit ×',  value: postWarHitMult,     set: setPostWarHitMult },
                          { label: 'Assist ×',   value: postAssistMult,     set: setPostAssistMult },
                          { label: 'Loss ×',     value: postLossMult,       set: setPostLossMult },
                          { label: 'War Mug ×',  value: postMugMult,        set: setPostMugMult },
                          { label: 'Outside ×',  value: postRegularHitMult, set: setPostRegularHitMult },
                        ].map(({ label, value, set }) => (
                          <div key={label} className="flex items-center gap-2">
                            <span className="text-xs text-gray-600 dark:text-gray-400 w-16 sm:w-20 flex-shrink-0">{label}</span>
                            <input
                              type="number" step="0.05" value={value}
                              onChange={e => set(e.target.value)}
                              className="w-full px-2 py-1 text-xs border border-gray-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-gray-900 dark:text-white"
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}

                {postDistMode === 'flat' && (
                  <>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                        Minimum Score
                      </label>
                      <input
                        type="number" min="0" step="1"
                        value={postFlatThreshold}
                        onChange={e => setPostFlatThreshold(e.target.value)}
                        className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-gray-900 dark:text-white"
                      />
                    </div>
                    <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={postScaleEnabled}
                        onChange={e => setPostScaleEnabled(e.target.checked)}
                        className="rounded border-gray-300 dark:border-slate-600 text-purple-600"
                      />
                      <span>Scale shares after a set number of hours</span>
                    </label>
                    {postScaleEnabled && (
                      <div>
                        <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                          Hours from war start
                        </label>
                        <input
                          type="number" min="0" step="1"
                          value={postScaleHours}
                          onChange={e => setPostScaleHours(e.target.value)}
                          className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-gray-900 dark:text-white"
                        />
                      </div>
                    )}
                    <p className="text-xs text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-slate-700/40 px-3 py-2 rounded">
                      {postScaleEnabled
                        ? `Members get 1 base share for reaching the minimum score within ${postScaleHours || 0}h of war start, plus a fractional share for every additional “minimum score” worth of respect earned after that. Pool is split by total shares.`
                        : 'Every member who reaches the minimum score gets an equal share of the post-cutoff pool.'}
                    </p>
                  </>
                )}
              </>
            )}
          </div>

        </div>

        {/* Calculate button — full-width row below the settings columns */}
        {selectedWar && !loadingWarData && (
          <div className="mt-4 pt-4 border-t border-gray-200 dark:border-slate-700">
            {contributions.length === 0 ? (
              <p className="text-sm text-amber-600 dark:text-amber-400">
                No contribution data available for this war. Run the war scraper first.
              </p>
            ) : (
              <button
                onClick={handleCalculate}
                className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
              >
                Calculate Payouts ({contributions.length} members)
              </button>
            )}
          </div>
        )}
      </div>

      {/* Results — appears once a war is loaded so the Hit Report is accessible without calculating */}
      {selectedWar && !loadingWarData && attacks.length > 0 && (
        <div className="bg-white dark:bg-slate-800 rounded-lg border border-gray-200 dark:border-slate-700 overflow-hidden">
          {/* Tab switcher */}
          <div className="flex items-center border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-700/40">
            <button
              onClick={() => setActiveTab('payout')}
              className={`px-4 py-2 text-sm font-medium transition-colors ${
                activeTab === 'payout'
                  ? 'text-blue-700 dark:text-blue-400 border-b-2 border-blue-500'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
              }`}
            >
              Payout Sheet
            </button>
            {warType !== 'race' && (
              <button
                onClick={() => setActiveTab('hits')}
                className={`px-4 py-2 text-sm font-medium transition-colors ${
                  activeTab === 'hits'
                    ? 'text-blue-700 dark:text-blue-400 border-b-2 border-blue-500'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
                }`}
              >
                Hit Report
              </button>
            )}
            {warType === 'race' && (
              <>
                <button
                  onClick={() => setActiveTab('hits-pre')}
                  className={`px-4 py-2 text-sm font-medium transition-colors ${
                    activeTab === 'hits-pre'
                      ? 'text-blue-700 dark:text-blue-400 border-b-2 border-blue-500'
                      : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
                  }`}
                >
                  Hit Report (Pre-Cutoff)
                </button>
                <button
                  onClick={() => setActiveTab('hits-post')}
                  className={`px-4 py-2 text-sm font-medium transition-colors ${
                    activeTab === 'hits-post'
                      ? 'text-purple-700 dark:text-purple-400 border-b-2 border-purple-500'
                      : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
                  }`}
                >
                  Hit Report (Post-Cutoff)
                </button>
              </>
            )}
            <div className="ml-auto pr-2">
              <button
                onClick={() => setViewMode(v => v === 'leader' ? 'member' : 'leader')}
                className={`px-2 py-1 text-xs rounded border transition-colors ${
                  viewMode === 'member'
                    ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400'
                    : 'border-gray-300 dark:border-slate-600 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-700'
                }`}
              >
                {viewMode === 'leader' ? 'Leader View' : 'Member View'}
              </button>
            </div>
          </div>

          {(() => {
            const onSort = (col) => {
              if (hitSortCol === col) setHitSortDir(d => d === 'asc' ? 'desc' : 'asc')
              else { setHitSortCol(col); setHitSortDir('desc') }
            }
            const cutoffTs = Number(raceCutoffTimestamp) || 0
            const common = {
              factionLookup, sortCol: hitSortCol, sortDir: hitSortDir, onSort,
              opponentId: selectedWar?.opponent_id,
            }
            if (activeTab === 'hits') {
              return <HitReportPanel attacks={attacks} factionFilter={factionFilter} setFactionFilter={setFactionFilter} {...common} />
            }
            if (activeTab === 'hits-pre') {
              const preWin = attacks.filter(a => (Number(a.started) || 0) <= cutoffTs)
              return <HitReportPanel attacks={preWin} factionFilter={factionFilterPre} setFactionFilter={setFactionFilterPre} {...common} />
            }
            if (activeTab === 'hits-post') {
              const postWin = attacks.filter(a => (Number(a.started) || 0) > cutoffTs)
              return <HitReportPanel attacks={postWin} factionFilter={factionFilterPost} setFactionFilter={setFactionFilterPost} {...common} />
            }
            return null
          })()}

          {activeTab === 'payout' && !hasCalculated && (
            <div className="px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
              Click <span className="font-medium">Calculate Payouts</span> above to generate the payout sheet.
            </div>
          )}

          {activeTab === 'payout' && hasCalculated && payoutResults && (<>
          {/* Contribution-source status banner */}
          {contributionSource === 'live' && (
            <div className="px-3 sm:px-4 py-2.5 border-b border-amber-200 dark:border-amber-700/50 bg-amber-50 dark:bg-amber-900/20 text-xs sm:text-sm text-amber-800 dark:text-amber-300">
              <p className="font-semibold">⚠ Live estimate — war in progress</p>
              <p className="mt-0.5 text-amber-700 dark:text-amber-400">
                Scores are derived from scraped attacks and will be reconciled after Torn publishes the official war report. Saving is disabled until then; the batch URL is provisional.
              </p>
              <p className="mt-1 text-amber-700 dark:text-amber-400">
                Derived war score: <span className="font-semibold">{derivedScoreTotal.toLocaleString()}</span>
                {selectedWar?.our_score > 0 && (
                  <> · Official live score: <span className="font-semibold">{Number(selectedWar.our_score).toLocaleString()}</span></>
                )}
              </p>
            </div>
          )}
          {contributionSource === 'official' && discrepancy && !discrepancy.hasDiscrepancies && (
            <div className="px-3 sm:px-4 py-2 border-b border-green-200 dark:border-green-700/50 bg-green-50 dark:bg-green-900/20 text-xs sm:text-sm text-green-800 dark:text-green-300">
              ✓ Derived scores match the official war report
              {Math.abs(discrepancy.totalDiff) > 0 && <> (Δ totals {discrepancy.totalDiff > 0 ? '+' : ''}{discrepancy.totalDiff.toLocaleString()})</>}.
            </div>
          )}
          {contributionSource === 'official' && discrepancy && discrepancy.hasDiscrepancies && (
            <div className="px-3 sm:px-4 py-2.5 border-b border-red-200 dark:border-red-700/50 bg-red-50 dark:bg-red-900/20 text-xs sm:text-sm text-red-800 dark:text-red-300">
              <div className="flex items-center justify-between gap-2">
                <p className="font-semibold">
                  ⚠ {discrepancy.flaggedRows.length} member{discrepancy.flaggedRows.length === 1 ? '' : 's'} differ from the official war report
                </p>
                <button
                  onClick={() => setShowDiscrepancyDetail(s => !s)}
                  className="flex-shrink-0 text-xs px-2 py-0.5 rounded border border-red-300 dark:border-red-600 text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/40"
                >
                  {showDiscrepancyDetail ? 'Hide' : 'Show'} details
                </button>
              </div>
              <p className="mt-0.5 text-red-700 dark:text-red-400">
                Derived scores come from scraped attacks; a gap usually means missing attack data for this window. Payout math is unaffected (this is a data-quality warning only).
              </p>
              {showDiscrepancyDetail && (
                <div className="mt-2 overflow-auto max-h-60 rounded border border-red-200 dark:border-red-700/50">
                  <table className="w-full text-xs">
                    <thead className="bg-red-100/60 dark:bg-red-900/30 text-red-800 dark:text-red-300 sticky top-0">
                      <tr className="text-right">
                        <th className="px-2 py-1 text-left font-medium">Member</th>
                        <th className="px-2 py-1 font-medium">Derived</th>
                        <th className="px-2 py-1 font-medium">Official</th>
                        <th className="px-2 py-1 font-medium">Δ</th>
                        <th className="px-2 py-1 font-medium">Δ%</th>
                      </tr>
                    </thead>
                    <tbody>
                      {discrepancy.flaggedRows.map(r => (
                        <tr key={r.memberId} className="text-right border-t border-red-100 dark:border-red-800/40">
                          <td className="px-2 py-1 text-left text-gray-800 dark:text-gray-200">{r.memberName}</td>
                          <td className="px-2 py-1 text-gray-700 dark:text-gray-300">{r.derivedScore.toLocaleString()}</td>
                          <td className="px-2 py-1 text-gray-700 dark:text-gray-300">{r.apiScore.toLocaleString()}</td>
                          <td className={`px-2 py-1 font-medium ${r.diff < 0 ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400'}`}>
                            {r.diff > 0 ? '+' : ''}{r.diff.toLocaleString()}
                          </td>
                          <td className="px-2 py-1 text-gray-500 dark:text-gray-400">{(r.pct * 100).toFixed(1)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
          {/* Summary bar */}
          <div className="px-3 sm:px-4 py-2 sm:py-3 bg-gray-50 dark:bg-slate-700/50 border-b border-gray-200 dark:border-slate-700 flex flex-wrap gap-2 sm:gap-4 text-xs sm:text-sm">
            <div>
              <span className="text-gray-500 dark:text-gray-400">Total Reward: </span>
              <span className="font-semibold text-gray-900 dark:text-white">
                {formatCurrency(payoutResults.cacheValue)}
              </span>
            </div>
            {(warType === 'real' || warType === 'race') && (payoutResults.mercCost > 0 || payoutResults.reviverCost > 0) && (
              <div>
                <span className="text-gray-500 dark:text-gray-400">Costs: </span>
                <span className="font-semibold text-red-600 dark:text-red-400">
                  −{formatCurrency(payoutResults.mercCost + payoutResults.reviverCost)}
                </span>
              </div>
            )}
            <div>
              <span className="text-gray-500 dark:text-gray-400">Faction Cut ({factionCutPercent}%): </span>
              <span className="font-semibold text-purple-700 dark:text-purple-400">
                {formatCurrency(payoutResults.factionCutAmount ?? 0)}
              </span>
            </div>
            {(warType === 'real' || warType === 'race') && payoutResults.factionTopUp > 0 && (
              <div>
                <span className="text-gray-500 dark:text-gray-400">Top-up: </span>
                <span className="font-semibold text-green-600 dark:text-green-400">
                  +{formatCurrency(payoutResults.factionTopUp)}
                </span>
              </div>
            )}
            <div>
              <span className="text-gray-500 dark:text-gray-400">Member Pool: </span>
              <span className="font-semibold text-gray-900 dark:text-white">
                {formatCurrency(payoutResults.memberPayoutPool)}
              </span>
            </div>
            {warType === 'termed' && (
              <div>
                <span className="text-gray-500 dark:text-gray-400">Total Shares: </span>
                <span className="font-semibold text-gray-900 dark:text-white">
                  {(payoutResults.totalShares ?? 0).toFixed(2)}
                </span>
              </div>
            )}
            {warType === 'race' && (
              <>
                <div>
                  <span className="text-gray-500 dark:text-gray-400">Pre-cutoff: </span>
                  <span className="font-semibold text-blue-700 dark:text-blue-400">
                    {formatCurrency(payoutResults.preCutoffPool ?? 0)}
                  </span>
                </div>
                <div>
                  <span className="text-gray-500 dark:text-gray-400">Post-cutoff: </span>
                  <span className="font-semibold text-purple-700 dark:text-purple-400">
                    {formatCurrency(payoutResults.postCutoffPool ?? 0)}
                  </span>
                </div>
              </>
            )}
            <div>
              <span className="text-gray-500 dark:text-gray-400">Total Payout: </span>
              <span className="font-semibold text-green-700 dark:text-green-400">
                {formatCurrency(totalPayout)}
              </span>
            </div>
            <div>
              <span className="text-gray-500 dark:text-gray-400">Eligible: </span>
              <span className="font-semibold text-gray-900 dark:text-white">
                {eligibleCount}/{effectiveMembers.length}
              </span>
            </div>
            {warType === 'real' && payoutResults.payPerHit > 0 && (
              <div>
                <span className="text-gray-500 dark:text-gray-400">Pay / War Hit: </span>
                <span className="font-semibold text-blue-700 dark:text-blue-400">
                  {formatCurrency(payoutResults.payPerHit)}
                </span>
                <span className="text-gray-400 ml-1">({payoutResults.totalWarHits} hits)</span>
              </div>
            )}
            {warType === 'race' && raceHitSplit && (raceHitSplit.preHits > 0 || raceHitSplit.postHits > 0) && (
              <div>
                <span className="text-gray-500 dark:text-gray-400">Pay / Hit: </span>
                <span className="font-semibold text-blue-700 dark:text-blue-400">
                  {formatCurrency(raceHitSplit.prePayPerHit)}
                </span>
                {raceHitSplit.postPayPerHit > 0 && (
                  <span className="font-semibold text-purple-600 dark:text-purple-400">
                    {' '}({formatCurrency(raceHitSplit.postPayPerHit)})
                  </span>
                )}
                <span className="text-gray-400 ml-1">
                  (<SplitCount pre={raceHitSplit.preHits} post={raceHitSplit.postHits} /> hits)
                </span>
              </div>
            )}
            {(warType === 'real' || warType === 'race') && factionFilter && factionFilter.size > 0 && (
              <div className="text-blue-600 dark:text-blue-400">
                Filtered by {factionFilter.size} faction{factionFilter.size === 1 ? '' : 's'}
              </div>
            )}
            {payoutResults.overBudgetWarning && (
              <div className="text-amber-600 dark:text-amber-400 font-medium">
                Over budget by {formatCurrency(totalPayout - payoutResults.memberPayoutPool)}
              </div>
            )}
          </div>

          {/* Member table */}
          <div className="overflow-auto max-h-[70vh] relative scrollbar-thin">
            <table className="w-full text-xs border-separate border-spacing-0">
              <thead>
                {/* Row 1: Section group headers */}
                <tr className="text-left text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-slate-700">
                  <th
                    className="px-2 py-2 font-semibold border-b border-gray-200 dark:border-slate-700 sticky top-0 z-20 bg-gray-50 dark:bg-slate-700 cursor-pointer select-none hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
                    rowSpan={2}
                    onClick={() => handleSortCol('name')}
                  >
                    Member
                    <span className="ml-1 text-gray-400 text-xs">{sortCol === 'name' ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}</span>
                  </th>
                  {warType === 'real' && (
                    <>
                      <th className="px-2 py-2 font-semibold border-b border-l border-gray-200 dark:border-slate-700 sticky top-0 z-20 bg-blue-50 dark:bg-slate-800 text-blue-800 dark:text-blue-300 text-center" colSpan={8}>
                        Hit Report
                      </th>
                      <th className="px-2 py-2 font-semibold border-b border-l border-gray-200 dark:border-slate-700 sticky top-0 z-20 bg-emerald-50 dark:bg-slate-800 text-emerald-800 dark:text-emerald-300 text-center" colSpan={viewMode === 'leader' ? 12 : 7}>
                        Participation Score
                      </th>
                      <th className="px-2 py-2 font-semibold border-b border-l border-gray-200 dark:border-slate-700 sticky top-0 z-20 bg-amber-50 dark:bg-slate-800 text-amber-800 dark:text-amber-300 text-center" colSpan={4}>
                        Contribution Score
                      </th>
                      <th className="px-2 py-2 font-semibold border-b border-l border-gray-200 dark:border-slate-700 sticky top-0 z-20 bg-purple-50 dark:bg-slate-800 text-purple-800 dark:text-purple-300 text-center" colSpan={3}>
                        Pay Out
                      </th>
                    </>
                  )}
                  {warType === 'race' && (
                    <>
                      {raceGroupHeaders('Pre-Cutoff')}
                      {raceGroupHeaders('Post-Cutoff', postDistMode === 'flat')}
                      <th className="px-2 py-2 font-semibold border-b border-l border-gray-200 dark:border-slate-700 sticky top-0 z-20 bg-purple-50 dark:bg-slate-800 text-purple-800 dark:text-purple-300 text-center" colSpan={5}>
                        Pay Out
                      </th>
                    </>
                  )}
                  {warType === 'termed' && termedMode === 'flat' && (
                    <th className="px-2 py-2 font-semibold border-b border-gray-200 dark:border-slate-700 sticky top-0 z-20 bg-purple-50 dark:bg-slate-800 text-purple-800 dark:text-purple-300 text-center" colSpan={6}>
                      Pay Out
                    </th>
                  )}
                  {warType === 'termed' && termedMode === 'scaling' && (
                    <th className="px-2 py-2 font-semibold border-b border-gray-200 dark:border-slate-700 sticky top-0 z-20 bg-purple-50 dark:bg-slate-800 text-purple-800 dark:text-purple-300 text-center" colSpan={6}>
                      Pay Out
                    </th>
                  )}
                </tr>
                {/* Row 2: Column headers */}
                <tr className="text-left text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-slate-700 border-b border-gray-200 dark:border-slate-700">
                  {warType === 'real' && (
                    <>
                      {/* Hit Report columns */}
                      <SortHeader col="leaves"    label="Leaves"  className="text-right border-l border-gray-200 dark:border-slate-700" />
                      <SortHeader col="mugs"      label="Mugs"    className="text-right" />
                      <SortHeader col="hosp"      label="Hosp"    className="text-right" />
                      <SortHeader col="warHits"   label="War"     className="text-right" />
                      <SortHeader col="won"        label="Won"     className="text-right" />
                      <SortHeader col="assists"   label="Assists" className="text-right" />
                      <SortHeader col="losses"    label="Lost"    className="text-right" />
                      <SortHeader col="totalHits" label="Total"   className="text-right border-r border-gray-200 dark:border-slate-700" />
                      {/* Participation Score columns */}
                      <SortHeader col="warHitScore"     label="War hit"  title="War wins excluding war mugs" className="text-right border-l border-gray-200 dark:border-slate-700" />
                      {viewMode === 'leader' && <th className="px-1 py-1.5 text-right text-[10px] font-normal sticky top-[32px] z-10 bg-gray-50 dark:bg-slate-700 text-gray-400">×</th>}
                      <SortHeader col="assistScore"     label="Assist"   title="War assists only" className="text-right" />
                      {viewMode === 'leader' && <th className="px-1 py-1.5 text-right text-[10px] font-normal sticky top-[32px] z-10 bg-gray-50 dark:bg-slate-700 text-gray-400">×</th>}
                      <SortHeader col="lossScore"       label="Loss"     title="War losses only" className="text-right" />
                      {viewMode === 'leader' && <th className="px-1 py-1.5 text-right text-[10px] font-normal sticky top-[32px] z-10 bg-gray-50 dark:bg-slate-700 text-gray-400">×</th>}
                      <SortHeader col="mugScore"        label="War Mug"  title="Mugs that happened during war hits" className="text-right" />
                      {viewMode === 'leader' && <th className="px-1 py-1.5 text-right text-[10px] font-normal sticky top-[32px] z-10 bg-gray-50 dark:bg-slate-700 text-gray-400">×</th>}
                      <SortHeader col="regularHitScore" label="Outside"  title="All non-war wins (leaves + mugs + hosp combined)" className="text-right" />
                      {viewMode === 'leader' && <th className="px-1 py-1.5 text-right text-[10px] font-normal sticky top-[32px] z-10 bg-gray-50 dark:bg-slate-700 text-gray-400">×</th>}
                      <SortHeader col="partScore"       label="Total"    className="text-right" />
                      <SortHeader col="partShare"       label="Part%"    className="text-right border-r border-gray-200 dark:border-slate-700" />
                      {/* Contribution Score columns */}
                      <SortHeader col="respect"         label="Respect"  className="text-right border-l border-gray-200 dark:border-slate-700" />
                      <SortHeader col="bonusRespect"    label="Bonus"    className="text-right" />
                      <SortHeader col="adjustedRespect" label="Adj."     className="text-right" />
                      <SortHeader col="contribShare"    label="Contrib%" className="text-right border-r border-gray-200 dark:border-slate-700" />
                      {/* Pay Out columns */}
                      <SortHeader col="effort" label="Effort%" className="text-right border-l border-gray-200 dark:border-slate-700" />
                    </>
                  )}
                  {warType === 'race' && (
                    <>
                      {raceColHeaders('pre')}
                      {raceColHeaders('post', postDistMode === 'flat')}
                      {/* Pay Out columns: Effort, Pre-Cutoff, Post-Cutoff, Payout */}
                      <SortHeader col="effort"           label="Effort%"     className="text-right border-l border-gray-200 dark:border-slate-700" />
                      <SortHeader col="preCutoffPayout"  label="Pre-Cutoff"  className="text-right" />
                      <SortHeader col="postCutoffPayout" label="Post-Cutoff" className="text-right" />
                    </>
                  )}
                  {warType === 'termed' && termedMode === 'flat' && (
                    <>
                      <SortHeader col="score"          label="Score"  className="text-right" />
                      <SortHeader col="bonusReduction" label="Bonus"  className="text-right" />
                      <SortHeader col="shares"         label="Shares" className="text-center" />
                    </>
                  )}
                  {warType === 'termed' && termedMode === 'scaling' && (
                    <>
                      <SortHeader col="preCutoffScore"  label="Pre-Cutoff"  className="text-right" />
                      <SortHeader col="postCutoffScore" label="Post-Cutoff" className="text-right" />
                      <SortHeader col="bonusReduction"  label="Bonus"       className="text-right" />
                      <SortHeader col="shares"          label="Shares"      className="text-right" />
                    </>
                  )}
                  <SortHeader col="payout"   label="Payout"   className="text-right" />
                  <SortHeader col="eligible" label="Eligible" className="text-center" />
                </tr>
              </thead>
              <tbody>
                {sortedMembers().map(m => {
                  const hasOverride = (key) => memberMultiplierOverrides[m.memberId]?.[key] !== undefined
                  const overrideCls = 'border border-amber-400 dark:border-amber-500'
                  const normalCls = 'border border-gray-200 dark:border-slate-600'
                  const multInput = (multKey, settingKey, globalVal) => (
                    <td className="px-0 py-0.5 text-right" key={multKey}>
                      <input type="number" step="0.05"
                        value={m[multKey] ?? globalVal}
                        onChange={e => {
                          const v = parseFloat(e.target.value)
                          setMemberMultiplierOverrides(prev => {
                            const cur = { ...(prev[m.memberId] || {}) }
                            if (v === Number(globalVal)) { delete cur[settingKey] } else { cur[settingKey] = v }
                            return { ...prev, [m.memberId]: Object.keys(cur).length ? cur : undefined }
                          })
                        }}
                        className={`w-12 px-0.5 py-0 text-[10px] text-right rounded bg-white dark:bg-slate-700 text-gray-700 dark:text-gray-300 ${hasOverride(settingKey) ? overrideCls : normalCls}`}
                      />
                    </td>
                  )
                  return (<tr
                    key={m.memberId}
                    className={`border-b border-gray-100 dark:border-slate-700/50 last:border-0 hover:bg-gray-50 dark:hover:bg-slate-700/30 ${
                      !m.isEligible ? 'opacity-40' : ''
                    }`}
                  >
                    <td className="px-2 py-1.5 font-medium text-gray-900 dark:text-white whitespace-nowrap sticky left-0 z-[5] bg-white dark:bg-slate-800">
                      {m.memberName}
                    </td>
                    {warType === 'real' && (
                      <>
                        {/* ── Hit Report ── */}
                        <td className="px-2 py-1 text-right text-gray-600 dark:text-gray-400 border-l border-gray-200 dark:border-slate-700">{m.leaves ?? 0}</td>
                        <td className="px-2 py-1 text-right text-gray-600 dark:text-gray-400">{m.mugs ?? 0}</td>
                        <td className="px-2 py-1 text-right text-gray-600 dark:text-gray-400">{m.hosp ?? 0}</td>
                        <td className="px-2 py-1 text-right font-medium text-blue-700 dark:text-blue-400">{m.warHits ?? 0}</td>
                        <td className="px-2 py-1 text-right text-gray-600 dark:text-gray-400">{m.won ?? 0}</td>
                        <td className="px-2 py-1 text-right text-gray-600 dark:text-gray-400">{m.assists ?? 0}</td>
                        <td className="px-2 py-1 text-right text-gray-600 dark:text-gray-400">{m.losses ?? 0}</td>
                        <td className="px-2 py-1 text-right font-medium text-gray-700 dark:text-gray-300 border-r border-gray-200 dark:border-slate-700">{m.totalHits ?? 0}</td>
                        {/* ── Participation Score — non-overlapping categories ── */}
                        <td className="px-2 py-1 text-right text-gray-600 dark:text-gray-400 border-l border-gray-200 dark:border-slate-700"
                            title={`${m.warNonMugHits ?? Math.max(0, (m.warHits ?? 0) - (m.warMugs ?? 0))} war hits × ${m.effWarHitMult ?? warHitMult}`}>{(m.warHitScore ?? 0).toFixed(2)}</td>
                        {viewMode === 'leader' && multInput('effWarHitMult', 'warHitMultiplier', warHitMult)}
                        <td className="px-2 py-1 text-right text-gray-600 dark:text-gray-400"
                            title={`${m.warAssists ?? 0} war assists × ${m.effAssistMult ?? assistMult}`}>{(m.assistScore ?? 0).toFixed(2)}</td>
                        {viewMode === 'leader' && multInput('effAssistMult', 'assistMultiplier', assistMult)}
                        <td className="px-2 py-1 text-right text-gray-600 dark:text-gray-400"
                            title={`${m.warLosses ?? 0} war losses × ${m.effLossMult ?? lossMult}`}>{(m.lossScore ?? 0).toFixed(2)}</td>
                        {viewMode === 'leader' && multInput('effLossMult', 'lossMultiplier', lossMult)}
                        <td className="px-2 py-1 text-right text-red-600 dark:text-red-400"
                            title={`${m.warMugs ?? 0} war mugs × ${m.effMugMult ?? mugMult}`}>{(m.mugScore ?? 0).toFixed(2)}</td>
                        {viewMode === 'leader' && multInput('effMugMult', 'mugMultiplier', mugMult)}
                        <td className="px-2 py-1 text-right text-gray-600 dark:text-gray-400"
                            title={`${m.regularHits ?? 0} outside hits × ${m.effRegularMult ?? regularHitMult}`}>{(m.regularHitScore ?? 0).toFixed(2)}</td>
                        {viewMode === 'leader' && multInput('effRegularMult', 'regularHitMultiplier', regularHitMult)}
                        <td className="px-2 py-1 text-right font-medium text-gray-700 dark:text-gray-300">{(m.participationScore ?? 0).toFixed(2)}</td>
                        <td className="px-2 py-1 text-right font-medium text-gray-700 dark:text-gray-300 border-r border-gray-200 dark:border-slate-700">
                          {((m.participationShare ?? 0) * 100).toFixed(2)}%
                        </td>
                        {/* ── Contribution Score ── */}
                        <td className="px-2 py-1 text-right text-gray-600 dark:text-gray-400 border-l border-gray-200 dark:border-slate-700">
                          {Number(m.respectGained ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </td>
                        <td className="px-2 py-1 text-right text-amber-600 dark:text-amber-400">
                          {(m.bonusRespect ?? 0) > 0 ? `−${m.bonusRespect.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : ''}
                        </td>
                        <td className="px-2 py-1 text-right text-gray-600 dark:text-gray-400">
                          {Number(m.adjustedRespect ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </td>
                        <td className="px-2 py-1 text-right font-medium text-gray-700 dark:text-gray-300 border-r border-gray-200 dark:border-slate-700">
                          {((m.contributionShare ?? 0) * 100).toFixed(2)}%
                        </td>
                        {/* ── Pay Out ── */}
                        <td className="px-2 py-1 text-right font-medium text-gray-700 dark:text-gray-300 border-l border-gray-200 dark:border-slate-700">
                          {((m.effortShare ?? 0) * 100).toFixed(2)}%
                        </td>
                      </>
                    )}
                    {warType === 'race' && (
                      <>
                        {raceWindowCells(m, 'pre',  preMults,  memberMultiplierOverrides,     setMemberMultiplierOverrides)}
                        {raceWindowCells(m, 'post', postMults, postMemberMultiplierOverrides, setPostMemberMultiplierOverrides, postDistMode === 'flat')}
                        {/* ── Pay Out: Effort, Pre-Cutoff, Post-Cutoff ── */}
                        <td className="px-2 py-1 text-right font-medium text-gray-700 dark:text-gray-300 border-l border-gray-200 dark:border-slate-700">
                          {payoutResults && payoutResults.memberPayoutPool > 0
                            ? ((m.payoutAmount / payoutResults.memberPayoutPool) * 100).toFixed(2)
                            : '0.00'}%
                        </td>
                        <td className="px-2 py-1 text-right text-blue-600 dark:text-blue-400">{formatCurrency(m.preCutoffPayout ?? 0)}</td>
                        <td className="px-2 py-1 text-right text-purple-600 dark:text-purple-400">{formatCurrency(m.postCutoffPayout ?? 0)}</td>
                      </>
                    )}
                    {warType === 'termed' && termedMode === 'flat' && (
                      <>
                        <td className="px-3 py-1.5 text-right text-gray-600 dark:text-gray-400">
                          {Number(m.score ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </td>
                        <td className="px-3 py-1.5 text-right text-amber-600 dark:text-amber-400">
                          {(m.bonusReduction ?? 0) > 0 ? `−${(m.bonusReduction).toLocaleString(undefined, { maximumFractionDigits: 2 })}` : ''}
                        </td>
                        <td className="px-3 py-1.5 text-center">
                          <input
                            type="number"
                            min="0"
                            max="10"
                            step="1"
                            value={memberShares[m.memberId] ?? (m.shares ?? 1)}
                            onChange={e => {
                              const val = Math.max(0, Number(e.target.value) || 0)
                              setMemberShares(prev => ({ ...prev, [m.memberId]: val }))
                            }}
                            className="w-14 px-1 py-0.5 text-xs text-center border border-gray-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-gray-900 dark:text-white"
                          />
                        </td>
                      </>
                    )}
                    {warType === 'termed' && termedMode === 'scaling' && (
                      <>
                        <td className="px-3 py-1.5 text-right text-gray-600 dark:text-gray-400">
                          {(m.preCutoffScore ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </td>
                        <td className="px-3 py-1.5 text-right text-amber-700 dark:text-amber-400">
                          {(m.postCutoffScore ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </td>
                        <td className="px-3 py-1.5 text-right text-amber-600 dark:text-amber-400">
                          {(m.bonusReduction ?? 0) > 0 ? `−${(m.bonusReduction).toLocaleString(undefined, { maximumFractionDigits: 2 })}` : ''}
                        </td>
                        <td className="px-3 py-1.5 text-right font-medium text-gray-700 dark:text-gray-300">
                          {(m.shares ?? 0).toFixed(2)}
                        </td>
                      </>
                    )}
                    <td className="px-3 py-1.5 text-right font-mono font-semibold text-gray-900 dark:text-white whitespace-nowrap">
                      {m.isEligible ? formatCurrency(m.payoutAmount) : '—'}
                    </td>
                    <td className="px-3 py-1.5 text-center">
                      <input
                        type="checkbox"
                        checked={m.isEligible}
                        onChange={e => {
                          setEligibilityOverrides(prev => ({ ...prev, [m.memberId]: e.target.checked }))
                        }}
                        className="rounded border-gray-300 dark:border-slate-600 text-blue-600"
                      />
                    </td>
                  </tr>)
                })}
              </tbody>
            </table>
          </div>

          {/* Actions */}
          <div className="px-3 sm:px-4 py-2 sm:py-3 border-t border-gray-200 dark:border-slate-700 flex flex-wrap gap-2 items-center">
            <button
              onClick={handleGenerateBatchURL}
              disabled={isSaving || eligibleCount === 0}
              className="px-3 sm:px-4 py-2 bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors"
            >
              {isSaving ? 'Saving...' : (
                <>
                  <span className="hidden sm:inline">Generate Batch Payout URL</span>
                  <span className="sm:hidden">Batch URL</span>
                </>
              )}
            </button>

            {savedPayoutId ? (
              <span className="text-sm text-green-600 dark:text-green-400 font-medium">
                ✓ Saved
              </span>
            ) : (
              <button
                onClick={handleSave}
                disabled={isSaving || contributionSource === 'live'}
                title={contributionSource === 'live' ? 'Saving is disabled for live estimates — wait for the official war report.' : undefined}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isSaving ? 'Saving...' : (contributionSource === 'live' ? 'Save disabled (live)' : 'Save to Database')}
              </button>
            )}

            {saveError && (
              <p className="text-sm text-red-600 dark:text-red-400">{saveError}</p>
            )}
          </div>

          {/* Batch URL display */}
          {showBatchURL && batchURL && (
            <div className="px-4 py-3 bg-green-50 dark:bg-green-900/20 border-t border-green-200 dark:border-green-800">
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-sm font-semibold text-green-800 dark:text-green-400">
                  Batch Payout URL ({eligibleCount} members, {formatCurrency(totalPayout)} total)
                </h4>
                <button
                  onClick={handleCopyURL}
                  className="text-xs px-2 py-1 bg-green-600 hover:bg-green-700 text-white rounded transition-colors"
                >
                  {batchURLCopied ? '✓ Copied' : 'Copy'}
                </button>
              </div>
              <div className="bg-white dark:bg-slate-800 rounded border border-green-200 dark:border-green-800 p-2">
                <a
                  href={batchURL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-blue-600 dark:text-blue-400 hover:underline break-all"
                >
                  {batchURL}
                </a>
              </div>
            </div>
          )}

          {showBatchURL && !batchURL && (
            <div className="px-4 py-3 bg-amber-50 dark:bg-amber-900/20 border-t border-amber-200 dark:border-amber-800">
              <p className="text-sm text-amber-700 dark:text-amber-400">
                No eligible members with a payout amount &gt; 0. Adjust settings and recalculate.
              </p>
            </div>
          )}
          </>)}
        </div>
      )}

      {/* Historical payouts */}
      {showHistory && (
        <div className="bg-white dark:bg-slate-800 rounded-lg border border-gray-200 dark:border-slate-700 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center justify-between">
            <h3 className="font-semibold text-gray-900 dark:text-white">
              Recent Saved Payouts
            </h3>
            <button
              onClick={() => setShowHistory(false)}
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-sm"
            >
              ✕
            </button>
          </div>
          {historicalPayouts.length === 0 ? (
            <p className="px-4 py-6 text-sm text-gray-500 dark:text-gray-400 text-center">
              No saved payouts yet.
            </p>
          ) : (
            <div className="divide-y divide-gray-100 dark:divide-slate-700">
              {historicalPayouts.map(payout => {
                const memberCount = payout.war_payout_members?.length || 0
                const eligCount = payout.war_payout_members?.filter(m => m.is_eligible).length || 0
                const total = payout.war_payout_members?.reduce(
                  (s, m) => s + (m.is_eligible ? Number(m.payout_amount) : 0), 0
                ) || 0
                return (
                  <div key={payout.id} className="px-4 py-3">
                    <div className="flex items-center justify-between text-sm">
                      <div>
                        <span className="font-medium text-gray-900 dark:text-white capitalize">
                          {payout.war_type} war
                        </span>
                        <span className="ml-1 text-xs text-gray-400 dark:text-gray-500">
                          (War #{payout.war_id})
                        </span>
                        <span className="ml-2 text-gray-500 dark:text-gray-400">
                          {new Date(payout.created_at).toLocaleDateString()} by {payout.created_by}
                        </span>
                      </div>
                      <div className="text-right">
                        <div className="font-semibold text-green-700 dark:text-green-400">
                          {formatCurrency(total)}
                        </div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          {eligCount}/{memberCount} members
                        </div>
                      </div>
                    </div>
                    {payout.notes && (
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{payout.notes}</p>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
