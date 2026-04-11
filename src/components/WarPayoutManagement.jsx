import { useState, useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { loadWars, loadWarsCount, loadWarContributions, loadFactionAttacksByWindow, loadWarPayouts } from '../utils/warDataLoader'
import { saveWarPayout } from '../utils/adminApi'
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

function WarSelector({ wars, selectedWarId, onSelect, hasMore, loadingMore, onLoadMore }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
        Select War
      </label>
      <div className="space-y-2">
        {wars.map(war => {
          const isWin = war.winner_faction_id === OUR_FACTION_ID
          const isOngoing = !war.end_at || war.end_at === 0
          return (
            <button
              key={war.id}
              onClick={() => onSelect(war)}
              className={`w-full text-left px-3 py-2 rounded-lg border text-sm transition-colors ${
                selectedWarId === war.id
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                  : 'border-gray-200 dark:border-slate-600 hover:bg-gray-50 dark:hover:bg-slate-700/50'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div>
                  <span className="font-medium text-gray-900 dark:text-white">
                    vs. {war.opponent_name || `#${war.opponent_id}`}
                  </span>
                  <span className="ml-2 text-gray-500 dark:text-gray-400 text-xs">
                    {formatWarDateRange(war.start_at, war.end_at)}
                  </span>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  {isOngoing ? (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-400">
                      Ongoing
                    </span>
                  ) : isWin ? (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-400">
                      Win
                    </span>
                  ) : (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-400">
                      Loss
                    </span>
                  )}
                  <span className={`text-xs px-1.5 py-0.5 rounded ${
                    war.is_termed
                      ? 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-400'
                      : 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-400'
                  }`}>
                    {war.is_termed ? 'Termed' : 'Real'}
                  </span>
                </div>
              </div>
            </button>
          )
        })}
        {hasMore && (
          <button
            onClick={onLoadMore}
            disabled={loadingMore}
            className="w-full text-center text-sm text-blue-600 dark:text-blue-400 py-1.5 border border-dashed border-blue-300 dark:border-blue-700 rounded-lg hover:bg-blue-50 dark:hover:bg-blue-900/20 disabled:opacity-50 transition-colors"
          >
            {loadingMore ? 'Loading...' : 'Load more wars'}
          </button>
        )}
      </div>
    </div>
  )
}

export default function WarPayoutManagement() {
  const { user } = useAuth()

  // War list state
  const [wars, setWars] = useState([])
  const [totalWars, setTotalWars] = useState(0)
  const [warOffset, setWarOffset] = useState(0)
  const [loadingWars, setLoadingWars] = useState(true)
  const [loadingMoreWars, setLoadingMoreWars] = useState(false)

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

  // Load wars on mount
  useEffect(() => {
    fetchWars(0, true)
  }, [])

  async function fetchWars(offset, replace = false) {
    try {
      if (replace) setLoadingWars(true)
      else setLoadingMoreWars(true)

      const [warsData, count] = await Promise.all([
        loadWars(WAR_PAGE_SIZE, offset),
        offset === 0 ? loadWarsCount() : Promise.resolve(totalWars)
      ])

      setWars(prev => replace ? warsData : [...prev, ...warsData])
      if (offset === 0) setTotalWars(count)
      setWarOffset(offset + warsData.length)
    } catch (err) {
      console.error('Error loading wars:', err)
    } finally {
      setLoadingWars(false)
      setLoadingMoreWars(false)
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

    // Pre-fill war type from war record
    setWarType(war.is_termed ? 'termed' : 'real')

    // Pre-fill cache prices from reward items (quantities only — prices stay as 0 until user enters them)
    // Just reset to defaults when war changes
    setCachePrices(DEFAULT_CACHE_PRICES)
    setNotes('')

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

    const settings = {
      rewardsItems,
      cachePrices,
      factionCutPercent: Number(factionCutPercent),
      minScoreThreshold: Number(minScoreThreshold),
      flatPayoutAmount: Number(flatPayoutAmount),
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
    if (!selectedWar || !payoutResults || !user?.tornApiKey) return

    setIsSaving(true)
    setSaveError(null)

    const rewardsItems = selectedWar.rewards_items
      ? (typeof selectedWar.rewards_items === 'string'
          ? JSON.parse(selectedWar.rewards_items)
          : selectedWar.rewards_items)
      : []

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
      score: m.score,
      attacks: m.totalHits || m.attacks || 0,
      assist_attacks: m.assists || 0,
      payout_amount: m.payoutAmount,
      is_eligible: m.isEligible,
    }))

    try {
      const result = await saveWarPayout(payoutData, memberRecords, user.tornApiKey)
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

    // If not saved yet, save first
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
  const hasMore = warOffset < totalWars

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-gray-900 dark:text-white">War Payout Management</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Calculate and save war payouts based on member contributions and cache rewards.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left column: war selector */}
        <div className="lg:col-span-1">
          {loadingWars ? (
            <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600"></div>
              Loading wars...
            </div>
          ) : (
            <WarSelector
              wars={wars}
              selectedWarId={selectedWar?.id}
              onSelect={handleSelectWar}
              hasMore={hasMore}
              loadingMore={loadingMoreWars}
              onLoadMore={() => fetchWars(warOffset)}
            />
          )}
        </div>

        {/* Right columns: settings + results */}
        <div className="lg:col-span-2 space-y-4">
          {!selectedWar ? (
            <div className="bg-gray-50 dark:bg-slate-800 rounded-lg border border-dashed border-gray-300 dark:border-slate-600 p-8 text-center text-gray-500 dark:text-gray-400">
              Select a war to configure the payout
            </div>
          ) : loadingWarData ? (
            <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 py-8 justify-center">
              <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600"></div>
              Loading war data...
            </div>
          ) : (
            <>
              {/* Settings panel */}
              <div className="bg-white dark:bg-slate-800 rounded-lg border border-gray-200 dark:border-slate-700 p-4">
                <h3 className="font-semibold text-gray-900 dark:text-white mb-4">Payout Settings</h3>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Left: war type, faction cut, cache prices */}
                  <div className="space-y-3">
                    {/* War type */}
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

                    {/* Faction cut */}
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

                    {/* Cache prices */}
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
                              <label className="text-xs text-gray-600 dark:text-gray-400 w-36 flex-shrink-0">
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

                    {/* Notes */}
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

                  {/* Right: war-type-specific settings */}
                  <div className="space-y-3">
                    {warType === 'termed' ? (
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
                      <div className="text-xs text-gray-500 dark:text-gray-400 space-y-2 pt-1">
                        <h4 className="text-xs font-semibold text-blue-700 dark:text-blue-400 uppercase tracking-wider mb-2">
                          Real War Formula
                        </h4>
                        <p><span className="font-medium text-gray-700 dark:text-gray-300">Participation score</span> — war hits ×1.25, assists ×0.5, losses ×0.5, mugs ×−1.0</p>
                        <p><span className="font-medium text-gray-700 dark:text-gray-300">Contribution score</span> — API respect, minus bonus-chain inflation (chain milestones normalised to 10)</p>
                        <p><span className="font-medium text-gray-700 dark:text-gray-300">Effort share</span> — average of participation % and contribution %</p>
                        <p><span className="font-medium text-gray-700 dark:text-gray-300">Payout</span> — effort share × member pool</p>
                      </div>
                    )}
                  </div>
                </div>

                {/* Calculate button */}
                <div className="mt-4 pt-4 border-t border-gray-200 dark:border-slate-700">
                  {contributions.length === 0 ? (
                    <p className="text-sm text-amber-600 dark:text-amber-400">
                      No contribution data available for this war. Run the war scraper first.
                    </p>
                  ) : (
                    <button
                      onClick={handleCalculate}
                      className="w-full py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
                    >
                      Calculate Payouts ({contributions.length} members)
                    </button>
                  )}
                </div>
              </div>

              {/* Results */}
              {hasCalculated && payoutResults && (
                <div className="bg-white dark:bg-slate-800 rounded-lg border border-gray-200 dark:border-slate-700 overflow-hidden">
                  {/* Summary bar */}
                  <div className="px-4 py-3 bg-gray-50 dark:bg-slate-700/50 border-b border-gray-200 dark:border-slate-700 flex flex-wrap gap-4 text-sm">
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
                    {payoutResults.overBudgetWarning && (
                      <div className="text-amber-600 dark:text-amber-400 font-medium">
                        ⚠ Over budget by {formatCurrency(totalPayout - payoutResults.memberPayoutPool)}
                      </div>
                    )}
                  </div>

                  {/* Member table */}
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-left text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-slate-700/50">
                          {/* Hit report */}
                          <th className="px-3 py-2 font-semibold border-b border-gray-200 dark:border-slate-700" colSpan={warType === 'real' ? 9 : 2}>
                            {warType === 'real' ? 'Hit Report' : 'Member'}
                          </th>
                          {warType === 'real' && (
                            <>
                              <th className="px-3 py-2 font-semibold border-b border-l border-gray-200 dark:border-slate-700" colSpan={4}>
                                Participation Score
                              </th>
                              <th className="px-3 py-2 font-semibold border-b border-l border-gray-200 dark:border-slate-700" colSpan={4}>
                                Contribution Score
                              </th>
                              <th className="px-3 py-2 font-semibold border-b border-l border-gray-200 dark:border-slate-700" colSpan={3}>
                                Pay Out
                              </th>
                            </>
                          )}
                          {warType === 'termed' && (
                            <th className="px-3 py-2 font-semibold border-b border-gray-200 dark:border-slate-700" colSpan={3}>
                              Pay Out
                            </th>
                          )}
                        </tr>
                        <tr className="text-left text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-slate-700/50 border-b border-gray-200 dark:border-slate-700">
                          <th className="px-3 py-1.5 font-medium">Player</th>
                          {warType === 'real' && (
                            <>
                              <th className="px-3 py-1.5 font-medium text-right">Leaves</th>
                              <th className="px-3 py-1.5 font-medium text-right">Mugs</th>
                              <th className="px-3 py-1.5 font-medium text-right">Hosp</th>
                              <th className="px-3 py-1.5 font-medium text-right">War</th>
                              <th className="px-3 py-1.5 font-medium text-right">Won</th>
                              <th className="px-3 py-1.5 font-medium text-right">Assists</th>
                              <th className="px-3 py-1.5 font-medium text-right">Lost</th>
                              <th className="px-3 py-1.5 font-medium text-right border-r border-gray-200 dark:border-slate-700">Total</th>
                              {/* Participation */}
                              <th className="px-3 py-1.5 font-medium text-right border-l border-gray-200 dark:border-slate-700">War hit</th>
                              <th className="px-3 py-1.5 font-medium text-right">Assist</th>
                              <th className="px-3 py-1.5 font-medium text-right">Loss</th>
                              <th className="px-3 py-1.5 font-medium text-right border-r border-gray-200 dark:border-slate-700">Score</th>
                              {/* Contribution */}
                              <th className="px-3 py-1.5 font-medium text-right border-l border-gray-200 dark:border-slate-700">Respect</th>
                              <th className="px-3 py-1.5 font-medium text-right">Bonus</th>
                              <th className="px-3 py-1.5 font-medium text-right">Adj.</th>
                              <th className="px-3 py-1.5 font-medium text-right border-r border-gray-200 dark:border-slate-700">Contrib%</th>
                              {/* Payout */}
                              <th className="px-3 py-1.5 font-medium text-right border-l border-gray-200 dark:border-slate-700">Effort%</th>
                            </>
                          )}
                          <th className="px-3 py-1.5 font-medium text-right">Payout</th>
                          <th className="px-3 py-1.5 font-medium text-center">Eligible</th>
                        </tr>
                      </thead>
                      <tbody>
                        {effectiveMembers
                          .slice()
                          .sort((a, b) => b.payoutAmount - a.payoutAmount)
                          .map(m => (
                            <tr
                              key={m.memberId}
                              className={`border-b border-gray-100 dark:border-slate-700/50 last:border-0 hover:bg-gray-50 dark:hover:bg-slate-700/30 ${
                                !m.isEligible ? 'opacity-40' : ''
                              }`}
                            >
                              <td className="px-3 py-1.5 font-medium text-gray-900 dark:text-white whitespace-nowrap">
                                {m.memberName}
                              </td>
                              {warType === 'real' && (
                                <>
                                  {/* Hit report */}
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
                          ))
                        }
                      </tbody>
                    </table>
                  </div>

                  {/* Actions */}
                  <div className="px-4 py-3 border-t border-gray-200 dark:border-slate-700 flex flex-wrap gap-2 items-center">
                    {/* Generate Batch URL (saves first if needed) */}
                    <button
                      onClick={handleGenerateBatchURL}
                      disabled={isSaving || eligibleCount === 0}
                      className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors"
                    >
                      {isSaving ? 'Saving...' : 'Generate Batch Payout URL'}
                    </button>

                    {/* Save separately */}
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

                    {/* History */}
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
            </>
          )}
        </div>
      </div>
    </div>
  )
}
