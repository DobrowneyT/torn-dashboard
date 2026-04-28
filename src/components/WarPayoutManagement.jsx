import { useState, useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { loadWars, loadWarsCount, loadWarContributions, loadFactionAttacksByWindow, loadWarPayouts, loadRecentWarPayouts, loadFactionsByIds } from '../utils/warDataLoader'
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

function HitReportPanel({ attacks, factionLookup, factionFilter, setFactionFilter, sortCol, sortDir, onSort }) {
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
    return [...ids].sort((a, b) => {
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
              <th className="px-2 py-2 font-semibold border-b border-l border-gray-200 dark:border-slate-700 sticky top-0 z-20 bg-emerald-50 dark:bg-emerald-900/30 text-emerald-800 dark:text-emerald-300 text-center" colSpan={outgoingCols.length}>
                Outgoing
              </th>
              <th className="px-2 py-2 font-semibold border-b border-l border-gray-200 dark:border-slate-700 sticky top-0 z-20 bg-amber-50 dark:bg-amber-900/30 text-amber-800 dark:text-amber-300 text-center" colSpan={incomingCols.length}>
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
                {outgoingCols.map((c, i) => {
                  const [side, key] = c.key.split('.')
                  const v = r[side][key]
                  return (
                    <td key={c.key} className={`px-2 py-1.5 text-right ${v === 0 ? 'text-gray-400 dark:text-gray-600' : 'text-gray-700 dark:text-gray-300'} ${i === 0 ? 'border-l border-gray-200 dark:border-slate-700' : ''}`}>
                      {v}
                    </td>
                  )
                })}
                {incomingCols.map((c, i) => {
                  const [side, key] = c.key.split('.')
                  const v = r[side][key]
                  return (
                    <td key={c.key} className={`px-2 py-1.5 text-right ${v === 0 ? 'text-gray-400 dark:text-gray-600' : 'text-gray-700 dark:text-gray-300'} ${i === 0 ? 'border-l border-gray-200 dark:border-slate-700' : ''}`}>
                      {v}
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

  // Payout settings
  const [warType, setWarType] = useState('real')
  const [factionCutPercent, setFactionCutPercent] = useState(20)
  const [totalReward, setTotalReward] = useState(0)
  // Termed settings
  const [minScoreThreshold, setMinScoreThreshold] = useState(50)
  const [termedMode, setTermedMode] = useState('flat')       // 'flat' | 'scaling'
  const [memberShares, setMemberShares] = useState({})        // { memberId: shareCount }
  const [cutoffHours, setCutoffHours] = useState(24)
  const [notes, setNotes] = useState('')
  // Real war formula settings
  const [warHitMult, setWarHitMult]   = useState(1.25)
  const [assistMult, setAssistMult]   = useState(0.50)
  const [lossMult, setLossMult]       = useState(0.50)
  const [mugMult, setMugMult]         = useState(-1.00)
  const [partWeight, setPartWeight]   = useState(50)   // integer 0–100; contrib = 100 - partWeight
  const [regularHitMult, setRegularHitMult] = useState(0.00)
  const [mercCost, setMercCost]         = useState(0)
  const [reviverCost, setReviverCost]   = useState(0)
  const [factionTopUp, setFactionTopUp] = useState(0)
  // Per-member multiplier overrides
  const [memberMultiplierOverrides, setMemberMultiplierOverrides] = useState({})

  // Race mode settings
  const [raceTargetScore, setRaceTargetScore] = useState(0)
  const [raceCutoffMode, setRaceCutoffMode] = useState('auto') // 'auto' | 'manual'
  const [raceManualCutoff, setRaceManualCutoff] = useState('')
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
  const [activeTab, setActiveTab] = useState('payout')           // 'payout' | 'hits'
  const [factionLookup, setFactionLookup] = useState(new Map())  // id → { id, name, tag }
  const [factionFilter, setFactionFilter] = useState(null)       // Set<id> | null (null = all)
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

    setWarType(war.is_termed ? 'termed' : 'real')
    setTotalReward(0)
    setNotes('')
    setMercCost(0)
    setReviverCost(0)
    setFactionTopUp(0)
    setTermedMode('flat')
    setMemberShares({})
    setCutoffHours(24)
    setMemberMultiplierOverrides({})
    setRaceTargetScore(0)
    setRaceCutoffMode('auto')
    setRaceManualCutoff('')
    setRaceCutoffTimestamp(null)
    setRacePostCutoffMode('flat')
    setRacePreCutoffPercent(50)

    setActiveTab('payout')
    setFactionFilter(null)
    setFactionLookup(new Map())

    setLoadingWarData(true)
    try {
      const [contribs, warAttacks] = await Promise.all([
        loadWarContributions(war.id),
        loadFactionAttacksByWindow(war.start_at, war.end_at),
      ])
      const ourContribs = contribs.filter(c => c.faction_id === OUR_FACTION_ID)
      setContributions(ourContribs)
      setAttacks(warAttacks)

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

  function computeResults(filter) {
    if (!selectedWar || contributions.length === 0) return null

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
      cutoffHours:     Number(cutoffHours) || 24,
    }

    if (warType === 'termed') {
      return calculateTermedWarPayouts(contributions, settings)
    }

    const filteredAttacks = applyFactionFilterToAttacks(attacks, filter)

    if (warType === 'race') {
      return calculateRaceWarPayouts(contributions, filteredAttacks, {
        ...settings,
        raceCutoffTimestamp: Number(raceCutoffTimestamp) || 0,
        racePreCutoffPercent: Number(racePreCutoffPercent),
        racePostCutoffMode,
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
  // the user has calculated at least once (real wars only — termed ignores attacks).
  useEffect(() => {
    if (!hasCalculated) return
    if (warType !== 'real' && warType !== 'race') return
    const results = computeResults(factionFilter)
    if (results) setPayoutResults(results)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [factionFilter])

  // Auto-recalculate when shares change in flat mode
  useEffect(() => {
    if (!hasCalculated) return
    if (warType !== 'termed' || termedMode !== 'flat') return
    const results = computeResults(factionFilter)
    if (results) setPayoutResults(results)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberShares])

  // Auto-recalculate when per-member multiplier overrides change (real/race mode)
  useEffect(() => {
    if (!hasCalculated) return
    if (warType === 'termed') return
    const results = computeResults(factionFilter)
    if (results) setPayoutResults(results)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberMultiplierOverrides])

  function getEffectiveMembers() {
    if (!payoutResults) return []
    return payoutResults.members.map(m => ({
      ...m,
      isEligible: eligibilityOverrides[m.memberId] !== undefined
        ? eligibilityOverrides[m.memberId]
        : m.isEligible,
    }))
  }

  async function handleSave() {
    if (!selectedWar || !payoutResults || !user?.apiKey) {
      setSaveError(!user?.apiKey ? 'Missing API key — please log in again.' : 'Nothing to save.')
      return
    }

    setIsSaving(true)
    setSaveError(null)

    const payoutData = {
      war_id: selectedWar.id,
      war_type: warType,
      faction_cut_percent: Number(factionCutPercent),
      total_reward: Number(totalReward) || 0,
      min_score_threshold: Number(minScoreThreshold),
      termed_mode: warType === 'termed' ? termedMode : (warType === 'race' ? racePostCutoffMode : null),
      merc_cost:      Number(mercCost) || 0,
      reviver_cost:   Number(reviverCost) || 0,
      faction_top_up: Number(factionTopUp) || 0,
      war_hit_multiplier:     Number(warHitMult),
      assist_multiplier:      Number(assistMult),
      loss_multiplier:        Number(lossMult),
      mug_multiplier:         Number(mugMult),
      regular_hit_multiplier: Number(regularHitMult),
      participation_weight:   Number(partWeight),
      // Race fields
      race_target_score:       warType === 'race' ? (Number(raceTargetScore) || null) : null,
      race_cutoff_mode:        warType === 'race' ? raceCutoffMode : null,
      race_cutoff_timestamp:   warType === 'race' ? (Number(raceCutoffTimestamp) || null) : null,
      race_post_cutoff_mode:   warType === 'race' ? racePostCutoffMode : null,
      race_pre_cutoff_percent: warType === 'race' ? Number(racePreCutoffPercent) : null,
      notes: notes || null,
    }

    const effectiveMembers = getEffectiveMembers()
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
    }))

    try {
      const newIsTermed = warType === 'termed' || warType === 'race'
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

  async function handleGenerateBatchURL() {
    if (!hasCalculated) return

    if (!savedPayoutId) {
      await handleSave()
      if (saveError) return
    }

    const effectiveMembers = getEffectiveMembers()
    const url = generateWarBatchPayoutURL(effectiveMembers)
    setBatchURL(url)
    setShowBatchURL(true)
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
        case 'postCutoffScore':  return dir * ((a.postCutoffScore ?? 0) - (b.postCutoffScore ?? 0))
        case 'preCutoffPayout':  return dir * ((a.preCutoffPayout ?? 0) - (b.preCutoffPayout ?? 0))
        case 'postCutoffPayout': return dir * ((a.postCutoffPayout ?? 0) - (b.postCutoffPayout ?? 0))
        case 'payout':           return dir * (a.payoutAmount - b.payoutAmount)
        case 'eligible':         return dir * ((a.isEligible ? 1 : 0) - (b.isEligible ? 1 : 0))
        default:                 return dir * (a.payoutAmount - b.payoutAmount)
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
                War Type
              </label>
              <div className="flex gap-2">
                <button
                  onClick={() => setWarType('real')}
                  className={`flex-1 py-1.5 text-sm rounded border transition-colors ${
                    warType === 'real'
                      ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400'
                      : 'border-gray-300 dark:border-slate-600 text-gray-600 dark:text-gray-400'
                  }`}
                >
                  Real
                </button>
                <button
                  onClick={() => setWarType('termed')}
                  className={`flex-1 py-1.5 text-sm rounded border transition-colors ${
                    warType === 'termed'
                      ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-400'
                      : 'border-gray-300 dark:border-slate-600 text-gray-600 dark:text-gray-400'
                  }`}
                >
                  Termed
                </button>
                <button
                  onClick={() => setWarType('race')}
                  className={`flex-1 py-1.5 text-sm rounded border transition-colors ${
                    warType === 'race'
                      ? 'border-amber-500 bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400'
                      : 'border-gray-300 dark:border-slate-600 text-gray-600 dark:text-gray-400'
                  }`}
                >
                  Race
                </button>
              </div>
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
                        { label: 'Regular ×',    value: regularHitMult, set: setRegularHitMult, step: '0.05' },
                        { label: 'Assist ×',     value: assistMult,    set: setAssistMult,    step: '0.05' },
                        { label: 'Loss ×',       value: lossMult,      set: setLossMult,      step: '0.05' },
                        { label: 'Mug ×',        value: mugMult,       set: setMugMult,       step: '0.05' },
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
                            onChange={e => set(Number(e.target.value) || 0)}
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
                      onClick={() => setRaceCutoffMode('manual')}
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
                        Cutoff detected: {new Date(raceCutoffTimestamp * 1000).toLocaleString()} (TCT)
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
                      Manual Cutoff (Unix timestamp)
                    </label>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={raceManualCutoff}
                      onChange={e => {
                        setRaceManualCutoff(e.target.value)
                        setRaceCutoffTimestamp(Number(e.target.value) || null)
                      }}
                      placeholder="Unix timestamp"
                      className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-gray-900 dark:text-white"
                    />
                    {raceCutoffTimestamp && (
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                        {new Date(raceCutoffTimestamp * 1000).toLocaleString()} (TCT)
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
                    min="0" max="100" step="5"
                    value={racePreCutoffPercent}
                    onChange={e => setRacePreCutoffPercent(Number(e.target.value))}
                    className="w-full h-1.5 rounded-lg appearance-none cursor-pointer bg-gradient-to-r from-blue-400 to-purple-400"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                    Post-Cutoff Mode
                  </label>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setRacePostCutoffMode('flat')}
                      className={`flex-1 py-1.5 text-sm rounded border transition-colors ${
                        racePostCutoffMode === 'flat'
                          ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-400'
                          : 'border-gray-300 dark:border-slate-600 text-gray-600 dark:text-gray-400'
                      }`}
                    >
                      Flat Shares
                    </button>
                    <button
                      onClick={() => setRacePostCutoffMode('scaling')}
                      className={`flex-1 py-1.5 text-sm rounded border transition-colors ${
                        racePostCutoffMode === 'scaling'
                          ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-400'
                          : 'border-gray-300 dark:border-slate-600 text-gray-600 dark:text-gray-400'
                      }`}
                    >
                      Scaling
                    </button>
                  </div>
                </div>

                {racePostCutoffMode === 'scaling' && (
                  <>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                        Score Threshold (for post-cutoff scaling)
                      </label>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={minScoreThreshold}
                        onChange={e => setMinScoreThreshold(e.target.value)}
                        className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-gray-900 dark:text-white"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                        Cutoff Hours (for post-cutoff scaling window)
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

          {activeTab === 'hits' && (
            <HitReportPanel
              attacks={attacks}
              factionLookup={factionLookup}
              factionFilter={factionFilter}
              setFactionFilter={setFactionFilter}
              sortCol={hitSortCol}
              sortDir={hitSortDir}
              onSort={(col) => {
                if (hitSortCol === col) setHitSortDir(d => d === 'asc' ? 'desc' : 'asc')
                else { setHitSortCol(col); setHitSortDir('desc') }
              }}
            />
          )}

          {activeTab === 'payout' && !hasCalculated && (
            <div className="px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
              Click <span className="font-medium">Calculate Payouts</span> above to generate the payout sheet.
            </div>
          )}

          {activeTab === 'payout' && hasCalculated && payoutResults && (<>
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
                  {payoutResults.totalShares ?? 0}
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
            {(warType === 'real' || warType === 'race') && payoutResults.payPerHit > 0 && (
              <div>
                <span className="text-gray-500 dark:text-gray-400">Pay / War Hit: </span>
                <span className="font-semibold text-blue-700 dark:text-blue-400">
                  {formatCurrency(payoutResults.payPerHit)}
                </span>
                <span className="text-gray-400 ml-1">({payoutResults.totalWarHits} hits)</span>
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
          <div className="overflow-auto max-h-[70vh] relative">
            <table className="w-full text-xs border-separate border-spacing-0">
              <thead>
                <tr className="text-left text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-slate-700">
                  <th className="px-3 py-2 font-semibold border-b border-gray-200 dark:border-slate-700 sticky top-0 z-20 bg-gray-50 dark:bg-slate-700" colSpan={1}>
                    Member
                  </th>
                  {(warType === 'real' || warType === 'race') && (
                    <>
                      <th className="px-3 py-2 font-semibold border-b border-l border-gray-200 dark:border-slate-700 sticky top-0 z-20 bg-gray-50 dark:bg-slate-700" colSpan={viewMode === 'leader' ? 10 : 5}>
                        Participation
                      </th>
                      <th className="px-3 py-2 font-semibold border-b border-l border-gray-200 dark:border-slate-700 sticky top-0 z-20 bg-gray-50 dark:bg-slate-700" colSpan={4}>
                        Contribution
                      </th>
                      <th className="px-3 py-2 font-semibold border-b border-l border-gray-200 dark:border-slate-700 sticky top-0 z-20 bg-gray-50 dark:bg-slate-700" colSpan={warType === 'race' ? 5 : 3}>
                        Pay Out
                      </th>
                    </>
                  )}
                  {warType === 'termed' && termedMode === 'flat' && (
                    <th className="px-3 py-2 font-semibold border-b border-gray-200 dark:border-slate-700 sticky top-0 z-20 bg-gray-50 dark:bg-slate-700" colSpan={4}>
                      Pay Out
                    </th>
                  )}
                  {warType === 'termed' && termedMode === 'scaling' && (
                    <th className="px-3 py-2 font-semibold border-b border-gray-200 dark:border-slate-700 sticky top-0 z-20 bg-gray-50 dark:bg-slate-700" colSpan={5}>
                      Pay Out
                    </th>
                  )}
                </tr>
                <tr className="text-left text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-slate-700 border-b border-gray-200 dark:border-slate-700">
                  <SortHeader col="name" label="Player" className="sticky left-0 top-[32px] z-30 bg-gray-50 dark:bg-slate-700" />
                  {(warType === 'real' || warType === 'race') && (
                    <>
                      <SortHeader col="warHits" label="War" className="text-right border-l border-gray-200 dark:border-slate-700" />
                      {viewMode === 'leader' && <th className="px-1 py-1.5 text-right text-[10px] font-normal sticky top-[32px] z-10 bg-gray-50 dark:bg-slate-700">WH×</th>}
                      <SortHeader col="assists" label="Ast" className="text-right" />
                      {viewMode === 'leader' && <th className="px-1 py-1.5 text-right text-[10px] font-normal sticky top-[32px] z-10 bg-gray-50 dark:bg-slate-700">Ast×</th>}
                      <SortHeader col="losses"  label="Loss" className="text-right" />
                      {viewMode === 'leader' && <th className="px-1 py-1.5 text-right text-[10px] font-normal sticky top-[32px] z-10 bg-gray-50 dark:bg-slate-700">Lss×</th>}
                      <SortHeader col="regularHits" label="Reg" className="text-right" />
                      {viewMode === 'leader' && <th className="px-1 py-1.5 text-right text-[10px] font-normal sticky top-[32px] z-10 bg-gray-50 dark:bg-slate-700">Reg×</th>}
                      <SortHeader col="mugs"    label="Mug"  className="text-right" />
                      {viewMode === 'leader' && <th className="px-1 py-1.5 text-right text-[10px] font-normal sticky top-[32px] z-10 bg-gray-50 dark:bg-slate-700">Mug×</th>}
                      <SortHeader col="partShare" label="Part%" className="text-right border-r border-gray-200 dark:border-slate-700" />
                      {/* Contribution */}
                      <SortHeader col="respect"         label="Respect" className="text-right border-l border-gray-200 dark:border-slate-700" />
                      <SortHeader col="bonusRespect"    label="Bonus"   className="text-right" />
                      <SortHeader col="adjustedRespect" label="Adj."    className="text-right" />
                      <SortHeader col="contribShare"    label="Contrib%" className="text-right border-r border-gray-200 dark:border-slate-700" />
                      {/* Effort / Payout */}
                      <SortHeader col="effort" label="Effort%" className="text-right border-l border-gray-200 dark:border-slate-700" />
                      {warType === 'race' && (
                        <>
                          <SortHeader col="preCutoffPayout"  label="Pre$" className="text-right" />
                          <SortHeader col="postCutoffPayout" label="Post$" className="text-right" />
                        </>
                      )}
                    </>
                  )}
                  {warType === 'termed' && termedMode === 'flat' && (
                    <SortHeader col="shares" label="Shares" className="text-center" />
                  )}
                  {warType === 'termed' && termedMode === 'scaling' && (
                    <>
                      <SortHeader col="preCutoffScore"  label="Pre-Cutoff" className="text-right" />
                      <SortHeader col="postCutoffScore" label="Post-Cutoff" className="text-right" />
                      <SortHeader col="shares"          label="Shares"     className="text-right" />
                    </>
                  )}
                  <SortHeader col="payout"   label="Payout"   className="text-right" />
                  <SortHeader col="eligible" label="Eligible" className="text-center" />
                </tr>
              </thead>
              <tbody>
                {sortedMembers().map(m => {
                  const hasOverride = (key) => memberMultiplierOverrides[m.memberId]?.[key] !== undefined
                  const overrideBorder = 'border border-amber-400 dark:border-amber-500'
                  return (<tr
                    key={m.memberId}
                    className={`border-b border-gray-100 dark:border-slate-700/50 last:border-0 hover:bg-gray-50 dark:hover:bg-slate-700/30 ${
                      !m.isEligible ? 'opacity-40' : ''
                    }`}
                  >
                    <td className="px-3 py-1.5 font-medium text-gray-900 dark:text-white whitespace-nowrap sticky left-0 z-[5] bg-white dark:bg-slate-800">
                      {m.memberName}
                    </td>
                    {(warType === 'real' || warType === 'race') && (
                      <>
                        {/* War Hits + multiplier */}
                        <td className="px-2 py-1 text-right font-medium text-blue-700 dark:text-blue-400 border-l border-gray-200 dark:border-slate-700">{m.warHits ?? 0}</td>
                        {viewMode === 'leader' && (
                          <td className="px-0 py-0.5 text-right">
                            <input type="number" step="0.05"
                              value={m.effWarHitMult ?? warHitMult}
                              onChange={e => {
                                const v = parseFloat(e.target.value)
                                setMemberMultiplierOverrides(prev => {
                                  const cur = { ...prev[m.memberId] }
                                  if (v === Number(warHitMult)) { delete cur.warHitMultiplier } else { cur.warHitMultiplier = v }
                                  return { ...prev, [m.memberId]: Object.keys(cur).length ? cur : undefined }
                                })
                              }}
                              className={`w-12 px-0.5 py-0 text-[10px] text-right rounded bg-white dark:bg-slate-700 text-gray-700 dark:text-gray-300 ${hasOverride('warHitMultiplier') ? overrideBorder : 'border border-gray-200 dark:border-slate-600'}`}
                            />
                          </td>
                        )}
                        {/* Assists + multiplier */}
                        <td className="px-2 py-1 text-right text-gray-600 dark:text-gray-400">{m.assists ?? 0}</td>
                        {viewMode === 'leader' && (
                          <td className="px-0 py-0.5 text-right">
                            <input type="number" step="0.05"
                              value={m.effAssistMult ?? assistMult}
                              onChange={e => {
                                const v = parseFloat(e.target.value)
                                setMemberMultiplierOverrides(prev => {
                                  const cur = { ...prev[m.memberId] }
                                  if (v === Number(assistMult)) { delete cur.assistMultiplier } else { cur.assistMultiplier = v }
                                  return { ...prev, [m.memberId]: Object.keys(cur).length ? cur : undefined }
                                })
                              }}
                              className={`w-12 px-0.5 py-0 text-[10px] text-right rounded bg-white dark:bg-slate-700 text-gray-700 dark:text-gray-300 ${hasOverride('assistMultiplier') ? overrideBorder : 'border border-gray-200 dark:border-slate-600'}`}
                            />
                          </td>
                        )}
                        {/* Losses + multiplier */}
                        <td className="px-2 py-1 text-right text-gray-600 dark:text-gray-400">{m.losses ?? 0}</td>
                        {viewMode === 'leader' && (
                          <td className="px-0 py-0.5 text-right">
                            <input type="number" step="0.05"
                              value={m.effLossMult ?? lossMult}
                              onChange={e => {
                                const v = parseFloat(e.target.value)
                                setMemberMultiplierOverrides(prev => {
                                  const cur = { ...prev[m.memberId] }
                                  if (v === Number(lossMult)) { delete cur.lossMultiplier } else { cur.lossMultiplier = v }
                                  return { ...prev, [m.memberId]: Object.keys(cur).length ? cur : undefined }
                                })
                              }}
                              className={`w-12 px-0.5 py-0 text-[10px] text-right rounded bg-white dark:bg-slate-700 text-gray-700 dark:text-gray-300 ${hasOverride('lossMultiplier') ? overrideBorder : 'border border-gray-200 dark:border-slate-600'}`}
                            />
                          </td>
                        )}
                        {/* Regular Hits + multiplier */}
                        <td className="px-2 py-1 text-right text-gray-600 dark:text-gray-400">{m.regularHits ?? 0}</td>
                        {viewMode === 'leader' && (
                          <td className="px-0 py-0.5 text-right">
                            <input type="number" step="0.05"
                              value={m.effRegularMult ?? regularHitMult}
                              onChange={e => {
                                const v = parseFloat(e.target.value)
                                setMemberMultiplierOverrides(prev => {
                                  const cur = { ...prev[m.memberId] }
                                  if (v === Number(regularHitMult)) { delete cur.regularHitMultiplier } else { cur.regularHitMultiplier = v }
                                  return { ...prev, [m.memberId]: Object.keys(cur).length ? cur : undefined }
                                })
                              }}
                              className={`w-12 px-0.5 py-0 text-[10px] text-right rounded bg-white dark:bg-slate-700 text-gray-700 dark:text-gray-300 ${hasOverride('regularHitMultiplier') ? overrideBorder : 'border border-gray-200 dark:border-slate-600'}`}
                            />
                          </td>
                        )}
                        {/* Mugs + multiplier */}
                        <td className="px-2 py-1 text-right text-red-600 dark:text-red-400">{m.mugs ?? 0}</td>
                        {viewMode === 'leader' && (
                          <td className="px-0 py-0.5 text-right">
                            <input type="number" step="0.05"
                              value={m.effMugMult ?? mugMult}
                              onChange={e => {
                                const v = parseFloat(e.target.value)
                                setMemberMultiplierOverrides(prev => {
                                  const cur = { ...prev[m.memberId] }
                                  if (v === Number(mugMult)) { delete cur.mugMultiplier } else { cur.mugMultiplier = v }
                                  return { ...prev, [m.memberId]: Object.keys(cur).length ? cur : undefined }
                                })
                              }}
                              className={`w-12 px-0.5 py-0 text-[10px] text-right rounded bg-white dark:bg-slate-700 text-gray-700 dark:text-gray-300 ${hasOverride('mugMultiplier') ? overrideBorder : 'border border-gray-200 dark:border-slate-600'}`}
                            />
                          </td>
                        )}
                        {/* Participation % */}
                        <td className="px-2 py-1 text-right font-medium text-gray-700 dark:text-gray-300 border-r border-gray-200 dark:border-slate-700">
                          {((m.participationShare ?? 0) * 100).toFixed(1)}%
                        </td>
                        {/* Contribution */}
                        <td className="px-2 py-1 text-right text-gray-600 dark:text-gray-400 border-l border-gray-200 dark:border-slate-700">
                          {Number(m.respectGained ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </td>
                        <td className="px-2 py-1 text-right text-amber-600 dark:text-amber-400">
                          {(m.bonusRespect ?? 0) > 0 ? `−${m.bonusRespect.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—'}
                        </td>
                        <td className="px-2 py-1 text-right text-gray-600 dark:text-gray-400">
                          {Number(m.adjustedRespect ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </td>
                        <td className="px-2 py-1 text-right font-medium text-gray-700 dark:text-gray-300 border-r border-gray-200 dark:border-slate-700">
                          {((m.contributionShare ?? 0) * 100).toFixed(1)}%
                        </td>
                        {/* Effort / Payout */}
                        <td className="px-2 py-1 text-right font-medium text-gray-700 dark:text-gray-300 border-l border-gray-200 dark:border-slate-700">
                          {((m.effortShare ?? 0) * 100).toFixed(1)}%
                        </td>
                        {warType === 'race' && (
                          <>
                            <td className="px-2 py-1 text-right text-blue-600 dark:text-blue-400">
                              {formatCurrency(m.preCutoffPayout ?? 0)}
                            </td>
                            <td className="px-2 py-1 text-right text-purple-600 dark:text-purple-400">
                              {formatCurrency(m.postCutoffPayout ?? 0)}
                            </td>
                          </>
                        )}
                      </>
                    )}
                    {warType === 'termed' && termedMode === 'flat' && (
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
                    )}
                    {warType === 'termed' && termedMode === 'scaling' && (
                      <>
                        <td className="px-3 py-1.5 text-right text-gray-600 dark:text-gray-400">
                          {(m.preCutoffScore ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </td>
                        <td className="px-3 py-1.5 text-right text-amber-700 dark:text-amber-400">
                          {(m.postCutoffScore ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}
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
                        onChange={e => setEligibilityOverrides(prev => ({
                          ...prev,
                          [m.memberId]: e.target.checked
                        }))}
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
                disabled={isSaving}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors"
              >
                {isSaving ? 'Saving...' : 'Save to Database'}
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
