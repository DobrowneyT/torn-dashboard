import { useState, useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { loadWars, loadWarsCount, loadWarContributions, loadFactionAttacksByWindow, loadWarPayouts } from '../utils/warDataLoader'
import { saveWarPayout, updateWarIsTermed } from '../utils/adminApi'
import {
  calculateCacheValue,
  calculateTermedWarPayouts,
  calculateRealWarPayouts,
  generateWarBatchPayoutURL,
  formatWarDateRange,
  CACHE_ITEM_MAP,
} from '../utils/warPayoutCalculations'

const OUR_FACTION_ID = 10739
const WAR_PAGE_SIZE = 5

const DEFAULT_CACHE_PRICES = {
  price_melee_cache:       0,
  price_armor_cache:       0,
  price_small_arms_cache:  0,
  price_medium_arms_cache: 0,
  price_heavy_arms_cache:  0,
}

const CACHE_LABELS = {
  price_melee_cache:       'Melee Cache',
  price_armor_cache:       'Armor Cache',
  price_small_arms_cache:  'Small Arms Cache',
  price_medium_arms_cache: 'Medium Arms Cache',
  price_heavy_arms_cache:  'Heavy Arms Cache',
}

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
  const [cachePrices, setCachePrices] = useState(DEFAULT_CACHE_PRICES)
  // Termed settings
  const [minScoreThreshold, setMinScoreThreshold] = useState(50)
  const [flatPayoutAmount, setFlatPayoutAmount] = useState(0)
  const [notes, setNotes] = useState('')
  // Real war formula settings
  const [warHitMult, setWarHitMult]   = useState(1.25)
  const [assistMult, setAssistMult]   = useState(0.50)
  const [lossMult, setLossMult]       = useState(0.50)
  const [mugMult, setMugMult]         = useState(-1.00)
  const [partWeight, setPartWeight]   = useState(50)   // integer 0–100; contrib = 100 - partWeight
  const [mercCost, setMercCost]         = useState(0)
  const [reviverCost, setReviverCost]   = useState(0)
  const [factionTopUp, setFactionTopUp] = useState(0)

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
    setCachePrices(DEFAULT_CACHE_PRICES)
    setNotes('')
    setMercCost(0)
    setReviverCost(0)
    setFactionTopUp(0)

    setLoadingWarData(true)
    try {
      const [contribs, warAttacks] = await Promise.all([
        loadWarContributions(war.id),
        loadFactionAttacksByWindow(war.start_at, war.end_at),
      ])
      const ourContribs = contribs.filter(c => c.faction_id === OUR_FACTION_ID)
      setContributions(ourContribs)
      setAttacks(warAttacks)
    } catch (err) {
      console.error('Error loading war data:', err)
    } finally {
      setLoadingWarData(false)
    }
  }

  async function handleLoadHistory() {
    if (!selectedWar) return
    setLoadingHistory(true)
    try {
      const data = await loadWarPayouts(selectedWar.id)
      setHistoricalPayouts(data)
      setShowHistory(true)
    } catch (err) {
      console.error('Error loading history:', err)
    } finally {
      setLoadingHistory(false)
    }
  }

  function handleCalculate() {
    if (!selectedWar || contributions.length === 0) return

    const rewardsItems = selectedWar.rewards_items
      ? (typeof selectedWar.rewards_items === 'string'
          ? JSON.parse(selectedWar.rewards_items)
          : selectedWar.rewards_items)
      : []

    const pw = Math.min(100, Math.max(0, Number(partWeight))) / 100
    const settings = {
      rewardsItems,
      cachePrices,
      factionCutPercent:   Number(factionCutPercent),
      minScoreThreshold:   Number(minScoreThreshold),
      flatPayoutAmount:    Number(flatPayoutAmount),
      warHitMultiplier:    Number(warHitMult),
      assistMultiplier:    Number(assistMult),
      lossMultiplier:      Number(lossMult),
      mugMultiplier:       Number(mugMult),
      participationWeight: pw,
      contributionWeight:  Math.round((1 - pw) * 1000) / 1000,
      mercCost:      Number(mercCost) || 0,
      reviverCost:   Number(reviverCost) || 0,
      factionTopUp:  Number(factionTopUp) || 0,
    }

    let results
    if (warType === 'termed') {
      results = calculateTermedWarPayouts(contributions, settings)
    } else {
      results = calculateRealWarPayouts(contributions, attacks, settings)
    }

    setPayoutResults(results)
    setEligibilityOverrides({})
    setHasCalculated(true)
    setSavedPayoutId(null)
    setShowBatchURL(false)
    setBatchURL('')
    setSaveError(null)
  }

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
      ...cachePrices,
      min_score_threshold: Number(minScoreThreshold),
      flat_payout_amount: Number(flatPayoutAmount),
      notes: notes || null,
    }

    const effectiveMembers = getEffectiveMembers()
    const memberRecords = effectiveMembers.map(m => ({
      member_id: m.memberId,
      member_name: m.memberName,
      score: m.respectGained ?? m.score ?? 0,
      attacks: m.totalHits || m.attacks || 0,
      assist_attacks: m.assists || 0,
      payout_amount: m.payoutAmount,
      is_eligible: m.isEligible,
    }))

    try {
      const newIsTermed = warType === 'termed'
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
        <h2 className="text-xl font-bold text-gray-900 dark:text-white">War Payout Management</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Calculate and save war payouts based on member contributions and cache rewards.
        </p>
      </div>

      {/* Settings panel — full width with embedded war selector */}
      <div className="bg-white dark:bg-slate-800 rounded-lg border border-gray-200 dark:border-slate-700 p-4">
        <h3 className="font-semibold text-gray-900 dark:text-white mb-4">Payout Settings</h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Col 1: war selector + war type + faction cut + cache prices + notes */}
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

            {selectedWar && !loadingWarData && (
              <>
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
                    Cache Prices (per item)
                  </label>
                  <div className="space-y-1.5">
                    {Object.entries(CACHE_LABELS).map(([field, label]) => {
                      const rewards = selectedWar?.rewards_items
                        ? (typeof selectedWar.rewards_items === 'string'
                            ? JSON.parse(selectedWar.rewards_items)
                            : selectedWar.rewards_items)
                        : []
                      const rewardEntry = rewards.find(r => CACHE_ITEM_MAP[r.name] === field)
                      return (
                        <div key={field} className="flex items-center gap-2">
                          <label className="text-xs text-gray-600 dark:text-gray-400 w-24 sm:w-36 flex-shrink-0">
                            {label}
                            {rewardEntry && (
                              <span className="ml-1 text-gray-400 dark:text-gray-500">
                                ×{rewardEntry.quantity}
                              </span>
                            )}
                          </label>
                          <input
                            type="number"
                            min="0"
                            step="1"
                            value={cachePrices[field] || ''}
                            onChange={e => setCachePrices(prev => ({
                              ...prev,
                              [field]: Number(e.target.value) || 0
                            }))}
                            placeholder="0"
                            className="flex-1 px-2 py-1 text-xs border border-gray-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-gray-900 dark:text-white"
                          />
                        </div>
                      )
                    })}
                  </div>
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
              </>
            )}
          </div>

          {/* Col 2: war-type-specific settings */}
          <div className="space-y-3">
            {selectedWar && !loadingWarData && (
              warType === 'termed' ? (
                <>
                  <h4 className="text-xs font-semibold text-purple-700 dark:text-purple-400 uppercase tracking-wider">
                    Termed War Settings
                  </h4>
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
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                      Flat Payout Amount ($)
                    </label>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={flatPayoutAmount}
                      onChange={e => setFlatPayoutAmount(e.target.value)}
                      className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-gray-900 dark:text-white"
                    />
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                      Each eligible member receives this amount.
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <h4 className="text-xs font-semibold text-blue-700 dark:text-blue-400 uppercase tracking-wider">
                    Real War Formula
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
                        { label: 'War Hit ×',  value: warHitMult, set: setWarHitMult, step: '0.05' },
                        { label: 'Assist ×',   value: assistMult, set: setAssistMult, step: '0.05' },
                        { label: 'Loss ×',     value: lossMult,   set: setLossMult,   step: '0.05' },
                        { label: 'Mug ×',      value: mugMult,    set: setMugMult,    step: '0.05' },
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
                      Mercs and revivers are subtracted from the member pool; top-up is added.
                    </p>
                  </div>
                </>
              )
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

      {/* Results */}
      {hasCalculated && payoutResults && (
        <div className="bg-white dark:bg-slate-800 rounded-lg border border-gray-200 dark:border-slate-700 overflow-hidden">
          {/* Summary bar */}
          <div className="px-3 sm:px-4 py-2 sm:py-3 bg-gray-50 dark:bg-slate-700/50 border-b border-gray-200 dark:border-slate-700 flex flex-wrap gap-2 sm:gap-4 text-xs sm:text-sm">
            <div>
              <span className="text-gray-500 dark:text-gray-400">Cache Value: </span>
              <span className="font-semibold text-gray-900 dark:text-white">
                {formatCurrency(payoutResults.cacheValue)}
              </span>
            </div>
            <div>
              <span className="text-gray-500 dark:text-gray-400">Member Pool: </span>
              <span className="font-semibold text-gray-900 dark:text-white">
                {formatCurrency(payoutResults.memberPayoutPool)}
              </span>
            </div>
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
            {payoutResults.overBudgetWarning && (
              <div className="text-amber-600 dark:text-amber-400 font-medium">
                ⚠ Over budget by {formatCurrency(totalPayout - payoutResults.memberPayoutPool)}
              </div>
            )}
          </div>

          {/* Member table */}
          <div className="overflow-auto max-h-[70vh] relative">
            <table className="w-full text-xs border-separate border-spacing-0">
              <thead>
                <tr className="text-left text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-slate-700">
                  <th className="px-3 py-2 font-semibold border-b border-gray-200 dark:border-slate-700 sticky top-0 z-20 bg-gray-50 dark:bg-slate-700" colSpan={warType === 'real' ? 9 : 2}>
                    {warType === 'real' ? 'Hit Report' : 'Member'}
                  </th>
                  {warType === 'real' && (
                    <>
                      <th className="px-3 py-2 font-semibold border-b border-l border-gray-200 dark:border-slate-700 sticky top-0 z-20 bg-gray-50 dark:bg-slate-700" colSpan={4}>
                        Participation Score
                      </th>
                      <th className="px-3 py-2 font-semibold border-b border-l border-gray-200 dark:border-slate-700 sticky top-0 z-20 bg-gray-50 dark:bg-slate-700" colSpan={4}>
                        Contribution Score
                      </th>
                      <th className="px-3 py-2 font-semibold border-b border-l border-gray-200 dark:border-slate-700 sticky top-0 z-20 bg-gray-50 dark:bg-slate-700" colSpan={3}>
                        Pay Out
                      </th>
                    </>
                  )}
                  {warType === 'termed' && (
                    <th className="px-3 py-2 font-semibold border-b border-gray-200 dark:border-slate-700 sticky top-0 z-20 bg-gray-50 dark:bg-slate-700" colSpan={3}>
                      Pay Out
                    </th>
                  )}
                </tr>
                <tr className="text-left text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-slate-700 border-b border-gray-200 dark:border-slate-700">
                  <SortHeader col="name" label="Player" className="sticky left-0 top-[32px] z-30 bg-gray-50 dark:bg-slate-700" />
                  {warType === 'real' && (
                    <>
                      <SortHeader col="leaves"  label="Leaves"  className="text-right" />
                      <SortHeader col="mugs"    label="Mugs"    className="text-right" />
                      <SortHeader col="hosp"    label="Hosp"    className="text-right" />
                      <SortHeader col="warHits" label="War"     className="text-right" />
                      <SortHeader col="won"     label="Won"     className="text-right" />
                      <SortHeader col="assists" label="Assists" className="text-right" />
                      <SortHeader col="losses"  label="Lost"    className="text-right" />
                      <SortHeader col="totalHits" label="Total" className="text-right border-r border-gray-200 dark:border-slate-700" />
                      {/* Participation */}
                      <SortHeader col="warHitScore"  label="War hit" className="text-right border-l border-gray-200 dark:border-slate-700" />
                      <SortHeader col="assistScore"  label="Assist"  className="text-right" />
                      <SortHeader col="lossScore"    label="Loss"    className="text-right" />
                      <SortHeader col="partShare"    label="Score%"  className="text-right border-r border-gray-200 dark:border-slate-700" />
                      {/* Contribution */}
                      <SortHeader col="respect"         label="Respect" className="text-right border-l border-gray-200 dark:border-slate-700" />
                      <SortHeader col="bonusRespect"    label="Bonus"   className="text-right" />
                      <SortHeader col="adjustedRespect" label="Adj."    className="text-right" />
                      <SortHeader col="contribShare"    label="Contrib%" className="text-right border-r border-gray-200 dark:border-slate-700" />
                      {/* Effort */}
                      <SortHeader col="effort" label="Effort%" className="text-right border-l border-gray-200 dark:border-slate-700" />
                    </>
                  )}
                  <SortHeader col="payout"   label="Payout"   className="text-right" />
                  <SortHeader col="eligible" label="Eligible" className="text-center" />
                </tr>
              </thead>
              <tbody>
                {sortedMembers().map(m => (
                  <tr
                    key={m.memberId}
                    className={`border-b border-gray-100 dark:border-slate-700/50 last:border-0 hover:bg-gray-50 dark:hover:bg-slate-700/30 ${
                      !m.isEligible ? 'opacity-40' : ''
                    }`}
                  >
                    <td className="px-3 py-1.5 font-medium text-gray-900 dark:text-white whitespace-nowrap sticky left-0 z-[5] bg-white dark:bg-slate-800">
                      {m.memberName}
                    </td>
                    {warType === 'real' && (
                      <>
                        <td className="px-3 py-1.5 text-right text-gray-600 dark:text-gray-400">{m.leaves ?? 0}</td>
                        <td className="px-3 py-1.5 text-right text-gray-600 dark:text-gray-400">{m.mugs ?? 0}</td>
                        <td className="px-3 py-1.5 text-right text-gray-600 dark:text-gray-400">{m.hosp ?? 0}</td>
                        <td className="px-3 py-1.5 text-right font-medium text-blue-700 dark:text-blue-400">{m.warHits ?? 0}</td>
                        <td className="px-3 py-1.5 text-right text-gray-600 dark:text-gray-400">{m.won ?? 0}</td>
                        <td className="px-3 py-1.5 text-right text-gray-600 dark:text-gray-400">{m.assists ?? 0}</td>
                        <td className="px-3 py-1.5 text-right text-gray-600 dark:text-gray-400">{m.losses ?? 0}</td>
                        <td className="px-3 py-1.5 text-right font-medium text-gray-700 dark:text-gray-300 border-r border-gray-200 dark:border-slate-700">{m.totalHits ?? 0}</td>
                        {/* Participation */}
                        <td className="px-3 py-1.5 text-right text-gray-600 dark:text-gray-400 border-l border-gray-200 dark:border-slate-700">{m.warHitScore?.toFixed(2) ?? '0.00'}</td>
                        <td className="px-3 py-1.5 text-right text-gray-600 dark:text-gray-400">{m.assistScore?.toFixed(2) ?? '0.00'}</td>
                        <td className="px-3 py-1.5 text-right text-gray-600 dark:text-gray-400">{m.lossScore?.toFixed(2) ?? '0.00'}</td>
                        <td className="px-3 py-1.5 text-right font-medium text-gray-700 dark:text-gray-300 border-r border-gray-200 dark:border-slate-700">
                          {(m.participationShare * 100).toFixed(2)}%
                        </td>
                        {/* Contribution */}
                        <td className="px-3 py-1.5 text-right text-gray-600 dark:text-gray-400 border-l border-gray-200 dark:border-slate-700">
                          {Number(m.respectGained).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </td>
                        <td className="px-3 py-1.5 text-right text-amber-600 dark:text-amber-400">
                          {m.bonusRespect > 0 ? `−${m.bonusRespect.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—'}
                        </td>
                        <td className="px-3 py-1.5 text-right text-gray-600 dark:text-gray-400">
                          {Number(m.adjustedRespect).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </td>
                        <td className="px-3 py-1.5 text-right font-medium text-gray-700 dark:text-gray-300 border-r border-gray-200 dark:border-slate-700">
                          {(m.contributionShare * 100).toFixed(2)}%
                        </td>
                        {/* Effort */}
                        <td className="px-3 py-1.5 text-right font-medium text-gray-700 dark:text-gray-300 border-l border-gray-200 dark:border-slate-700">
                          {(m.effortShare * 100).toFixed(2)}%
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
                  </tr>
                ))}
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

            <button
              onClick={handleLoadHistory}
              disabled={loadingHistory}
              className="px-3 py-2 text-sm text-gray-600 dark:text-gray-400 border border-gray-300 dark:border-slate-600 rounded-lg hover:bg-gray-50 dark:hover:bg-slate-700 disabled:opacity-50 transition-colors"
            >
              {loadingHistory ? 'Loading...' : 'View History'}
            </button>

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
        </div>
      )}

      {/* Historical payouts */}
      {showHistory && (
        <div className="bg-white dark:bg-slate-800 rounded-lg border border-gray-200 dark:border-slate-700 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center justify-between">
            <h3 className="font-semibold text-gray-900 dark:text-white">
              Saved Payouts for War #{selectedWar.id}
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
              No saved payouts for this war yet.
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
