import { useState, useMemo, useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../utils/supabase'
import {
  loadCrimesForPayout,
  loadMembers,
  loadPayoutWeeks,
  savePayoutWeek
} from '../utils/payoutDataLoader'
import {
  getCurrentWeekRange,
  getPreviousWeekRange,
  calculatePayouts,
  formatCurrency,
  formatCurrencyShort,
  formatPercent,
  formatTimeHours,
  exportPayoutsToCSV,
  generateBatchPayoutURL,
  parsePayoutCSV,
  getCrimeStats
} from '../utils/payoutCalculations'
import { enrichItemBreakdown } from '../utils/lookupHelpers'

export default function PayoutManagement() {
  const { user } = useAuth()

  // Date range state
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [fromTimestamp, setFromTimestamp] = useState(null)
  const [toTimestamp, setToTimestamp] = useState(null)
  const [factionCutPercent, setFactionCutPercent] = useState(20)

  // Data loading state
  const [crimesData, setCrimesData] = useState(null)
  const [membersData, setMembersData] = useState(null)
  const [loadingData, setLoadingData] = useState(false)
  const [dataError, setDataError] = useState(null)

  // Calculation state
  const [hasCalculated, setHasCalculated] = useState(false)
  const [payoutResults, setPayoutResults] = useState(null)

  // Save state
  const [isSaving, setIsSaving] = useState(false)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [saveError, setSaveError] = useState(null)

  // UI state
  const [showBatchURL, setShowBatchURL] = useState(false)
  const [showCrimeStats, setShowCrimeStats] = useState(false)
  const [sortConfig, setSortConfig] = useState({ key: 'payout', direction: 'desc' })

  // Historical payouts
  const [historicalPayouts, setHistoricalPayouts] = useState([])
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [showHistory, setShowHistory] = useState(false)

  // CSV import
  const [importingCSV, setImportingCSV] = useState(false)

  // Item breakdown state
  const [showItemRewards, setShowItemRewards] = useState(false)
  const [showItemCosts, setShowItemCosts] = useState(false)

  // Initialize with current week
  useEffect(() => {
    const currentWeek = getCurrentWeekRange()
    setFromDate(currentWeek.monday.toISOString().split('T')[0])
    setToDate(currentWeek.sunday.toISOString().split('T')[0])
    setFromTimestamp(currentWeek.mondayTimestamp)
    setToTimestamp(currentWeek.sundayTimestamp)
  }, [])

  // Load historical payouts when tab is shown
  useEffect(() => {
    if (showHistory) {
      loadHistoricalPayouts()
    }
  }, [showHistory])

  async function loadHistoricalPayouts() {
    try {
      setLoadingHistory(true)
      const data = await loadPayoutWeeks(20)
      setHistoricalPayouts(data)
    } catch (err) {
      console.error('Error loading historical payouts:', err)
    } finally {
      setLoadingHistory(false)
    }
  }

  async function loadPayoutData() {
    if (!fromTimestamp || !toTimestamp) return

    try {
      setLoadingData(true)
      setDataError(null)

      // Load crimes and members from Supabase
      const [crimes, members] = await Promise.all([
        loadCrimesForPayout(fromTimestamp, toTimestamp),
        loadMembers()
      ])

      setCrimesData(crimes)
      setMembersData(members)

      console.log('Loaded crimes:', Object.keys(crimes.crimes || {}).length)
      console.log('Loaded members:', Object.keys(members.members || {}).length)

    } catch (err) {
      console.error('Error loading payout data:', err)
      setDataError(err.message)
    } finally {
      setLoadingData(false)
    }
  }

  function handleSetCurrentWeek() {
    const currentWeek = getCurrentWeekRange()
    setFromDate(currentWeek.monday.toISOString().split('T')[0])
    setToDate(currentWeek.sunday.toISOString().split('T')[0])
    setFromTimestamp(currentWeek.mondayTimestamp)
    setToTimestamp(currentWeek.sundayTimestamp)
    setHasCalculated(false)
    setPayoutResults(null)
  }

  function handleSetPreviousWeek() {
    const previousWeek = getPreviousWeekRange()
    setFromDate(previousWeek.monday.toISOString().split('T')[0])
    setToDate(previousWeek.sunday.toISOString().split('T')[0])
    setFromTimestamp(previousWeek.mondayTimestamp)
    setToTimestamp(previousWeek.sundayTimestamp)
    setHasCalculated(false)
    setPayoutResults(null)
  }

  function handleFromDateChange(e) {
    const newDate = e.target.value
    setFromDate(newDate)
    if (newDate) {
      const date = new Date(newDate)
      date.setHours(0, 0, 0, 0)
      setFromTimestamp(Math.floor(date.getTime() / 1000))
    }
    setHasCalculated(false)
    setPayoutResults(null)
  }

  function handleToDateChange(e) {
    const newDate = e.target.value
    setToDate(newDate)
    if (newDate) {
      const date = new Date(newDate)
      date.setHours(23, 59, 59, 999)
      setToTimestamp(Math.floor(date.getTime() / 1000))
    }
    setHasCalculated(false)
    setPayoutResults(null)
  }

  async function handleRunPayout() {
    if (!fromTimestamp || !toTimestamp) {
      alert('Please select both FROM and TO dates')
      return
    }

    if (fromTimestamp >= toTimestamp) {
      alert('FROM date must be before TO date')
      return
    }

    // Load fresh data
    await loadPayoutData()

    if (!crimesData && !membersData) {
      // Data loading failed, error already shown
      return
    }
  }

  // Calculate payouts when data is loaded
  useEffect(() => {
    if (crimesData && membersData && fromTimestamp && toTimestamp) {
      const results = calculatePayouts(
        crimesData,
        membersData,
        fromTimestamp,
        toTimestamp,
        factionCutPercent / 100
      )

      enrichItemBreakdown(results.itemBreakdown).then(enriched => {
        setPayoutResults({ ...results, itemBreakdown: enriched })
        setHasCalculated(true)
      })
    }
  }, [crimesData, membersData, fromTimestamp, toTimestamp, factionCutPercent])

  async function handleSaveWeek() {
    if (!payoutResults || payoutResults.members.length === 0) {
      alert('No payout data to save')
      return
    }

    setIsSaving(true)
    setSaveError(null)
    setSaveSuccess(false)

    try {
      const weekData = {
        week_start: fromDate,
        week_end: toDate,
        week_start_timestamp: fromTimestamp,
        week_end_timestamp: toTimestamp,
        total_money_reward: payoutResults.totalMoneyReward,
        total_item_reward: payoutResults.totalItemReward,
        total_item_cost: payoutResults.totalItemCost,
        net_item_value: payoutResults.netItemValue,
        faction_cut_percent: factionCutPercent,
        faction_cut_amount: payoutResults.factionCut,
        member_payout_total: payoutResults.memberPayoutTotal,
        crimes_processed: payoutResults.crimesProcessed,
        total_time_spent: payoutResults.totalTimeSpent,
        average_time_spent: payoutResults.averageTime,
        total_adjusted_tickets: payoutResults.totalAdjustedTickets
      }

      const memberData = payoutResults.members.map(m => ({
        member_id: m.userId.toString(),
        member_name: m.name,
        tier: m.tier,
        base_tickets: m.baseTickets,
        sit_out_penalty: m.sitOutPenalty,
        adjusted_tickets: m.adjustedTickets,
        time_spent: m.timeSpent,
        time_spent_percent: m.timePercent,
        share_percent: m.sharePercent * 100,
        payout: m.payout,
        theoretical_payout: m.theoreticalPayout,
        crimes_count: m.crimesCount,
        crimes_participated: m.crimeIds
      }))

      await savePayoutWeek(weekData, memberData, payoutResults.crimeIds, user.name, user.apiKey)

      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 5000)

    } catch (err) {
      console.error('Error saving payout:', err)
      setSaveError(err.message)
    } finally {
      setIsSaving(false)
    }
  }

  function handleExportCSV() {
    if (!payoutResults) return

    const csvContent = exportPayoutsToCSV(sortedMembers, payoutResults)
    const blob = new Blob([csvContent], { type: 'text/csv' })
    const url = window.URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${fromDate}-Forge_OC_Payout.csv`
    a.click()
    window.URL.revokeObjectURL(url)
  }

  function handleCopyBatchURL() {
    if (!payoutResults) return

    const batchURL = generateBatchPayoutURL(sortedMembers)

    if (!batchURL) {
      alert('No valid payouts to generate URL')
      return
    }

    navigator.clipboard.writeText(batchURL).then(() => {
      setShowBatchURL(true)
      setTimeout(() => setShowBatchURL(false), 3000)
    }).catch(err => {
      console.error('Failed to copy:', err)
      alert('Failed to copy URL to clipboard')
    })
  }

  async function handleImportCSV(event) {
    const file = event.target.files[0]
    if (!file) return

    setImportingCSV(true)

    try {
      // Parse week start from filename: "20251215-Forge_OC_Payout.csv"
      const dateMatch = file.name.match(/^(\d{8})/)
      if (!dateMatch) {
        throw new Error('Filename must start with date in YYYYMMDD format (e.g., 20251215-Forge_OC_Payout.csv)')
      }

      const dateStr = dateMatch[1]
      const year = parseInt(dateStr.substring(0, 4))
      const month = parseInt(dateStr.substring(4, 6)) - 1
      const day = parseInt(dateStr.substring(6, 8))

      const weekStart = new Date(year, month, day)
      weekStart.setHours(0, 0, 0, 0)

      const weekEnd = new Date(weekStart)
      weekEnd.setDate(weekEnd.getDate() + 6)
      weekEnd.setHours(23, 59, 59, 999)

      const text = await file.text()
      const parsed = parsePayoutCSV(text)

      if (parsed.members.length === 0) {
        throw new Error('No valid member data found in CSV')
      }

      // Find crimes executed in this date range to link
      const weekStartTs = Math.floor(weekStart.getTime() / 1000)
      const weekEndTs = Math.floor(weekEnd.getTime() / 1000)

      const { data: weekCrimes } = await supabase
        .from('crimes')
        .select('crime_id')
        .gte('executed_at', weekStartTs)
        .lt('executed_at', weekEndTs)
        .eq('status', 'Successful')

      const crimeIds = (weekCrimes || []).map(c => c.crime_id)

      // Calculate totals from crimes if available
      let totalMoneyReward = 0
      let totalItemReward = 0
      let totalItemCost = 0

      if (crimeIds.length > 0) {
        const { data: crimes } = await supabase
          .from('crimes')
          .select('rewards_money')
          .in('crime_id', crimeIds)

        totalMoneyReward = (crimes || []).reduce((sum, c) => sum + (c.rewards_money || 0), 0)

        // Get item values
        const { data: rewardItems } = await supabase
          .from('crime_reward_items')
          .select('unit_value, quantity')
          .in('crime_id', crimeIds)

        totalItemReward = (rewardItems || []).reduce((sum, i) => sum + (i.unit_value * i.quantity), 0)

        const { data: requiredItems } = await supabase
          .from('crime_required_items')
          .select('unit_value, was_consumed')
          .in('crime_id', crimeIds)
          .eq('was_consumed', true)

        totalItemCost = (requiredItems || []).reduce((sum, i) => sum + (i.unit_value || 0), 0)
      }

      const weekData = {
        week_start: weekStart.toISOString().split('T')[0],
        week_end: weekEnd.toISOString().split('T')[0],
        week_start_timestamp: weekStartTs,
        week_end_timestamp: weekEndTs,
        total_money_reward: totalMoneyReward,
        total_item_reward: totalItemReward,
        total_item_cost: totalItemCost,
        net_item_value: totalItemReward - totalItemCost,
        faction_cut_percent: 20,
        faction_cut_amount: 0,
        member_payout_total: parsed.totalPayout,
        crimes_processed: crimeIds.length,
        total_time_spent: parsed.totalTime,
        average_time_spent: parsed.memberCount > 0 ? Math.floor(parsed.totalTime / parsed.memberCount) : 0,
        total_adjusted_tickets: parsed.totalTickets
      }

      await savePayoutWeek(weekData, parsed.members, crimeIds, `${user.name} (CSV Import)`, user.apiKey)

      alert(`Successfully imported ${parsed.memberCount} member payouts for week of ${weekStart.toLocaleDateString()}`)

      // Refresh history if showing
      if (showHistory) {
        loadHistoricalPayouts()
      }

    } catch (err) {
      console.error('Error importing CSV:', err)
      alert(`Failed to import CSV: ${err.message}`)
    } finally {
      setImportingCSV(false)
      event.target.value = ''
    }
  }

  // Sort members
  const sortedMembers = useMemo(() => {
    if (!payoutResults?.members) return []

    const sorted = [...payoutResults.members]

    if (sortConfig.key) {
      sorted.sort((a, b) => {
        let aVal = a[sortConfig.key]
        let bVal = b[sortConfig.key]

        if (sortConfig.key === 'name') {
          aVal = (aVal || '').toLowerCase()
          bVal = (bVal || '').toLowerCase()
        }

        if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1
        if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1
        return 0
      })
    }

    return sorted
  }, [payoutResults, sortConfig])

  const handleSort = (key) => {
    setSortConfig(prev => ({
      key,
      direction: prev.key === key && prev.direction === 'desc' ? 'asc' : 'desc'
    }))
  }

  const SortIcon = ({ columnKey }) => {
    if (sortConfig.key !== columnKey) {
      return <span className="ml-1 text-gray-400">-</span>
    }
    return <span className="ml-1">{sortConfig.direction === 'asc' ? '^' : 'v'}</span>
  }

  // Crime statistics
  const crimeStats = useMemo(() => {
    if (!crimesData?.crimes) return null
    return getCrimeStats(crimesData.crimes)
  }, [crimesData])

  return (
    <div className="space-y-6">
      {/* Date Range Selection */}
      <div className="card">
        <h2 className="text-xl font-semibold mb-4">Payout Analysis Window</h2>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-4">
          <div>
            <label className="block text-sm font-medium mb-2 text-green-600">From Date:</label>
            <div className="grid grid-cols-2 gap-2">
              <input
                type="date"
                value={fromDate}
                onChange={handleFromDateChange}
                className="input bg-green-50 dark:bg-green-900/20 border-green-300"
              />
              <input
                type="text"
                value={fromTimestamp || ''}
                readOnly
                className="input bg-orange-50 dark:bg-orange-900/20 border-orange-300 text-sm"
                placeholder="Unix timestamp"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2 text-green-600">To Date:</label>
            <div className="grid grid-cols-2 gap-2">
              <input
                type="date"
                value={toDate}
                onChange={handleToDateChange}
                className="input bg-green-50 dark:bg-green-900/20 border-green-300"
              />
              <input
                type="text"
                value={toTimestamp || ''}
                readOnly
                className="input bg-orange-50 dark:bg-orange-900/20 border-orange-300 text-sm"
                placeholder="Unix timestamp"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2 text-purple-600">Faction Cut (%):</label>
            <input
              type="number"
              value={factionCutPercent}
              onChange={(e) => setFactionCutPercent(parseFloat(e.target.value) || 0)}
              min="0"
              max="100"
              step="0.1"
              className="input bg-purple-50 dark:bg-purple-900/20 border-purple-300"
            />
          </div>
        </div>

        <div className="flex flex-wrap gap-2 mb-4">
          <button
            onClick={handleSetCurrentWeek}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
          >
            Current Week
          </button>
          <button
            onClick={handleSetPreviousWeek}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
          >
            Previous Week
          </button>
          <button
            onClick={() => setShowHistory(!showHistory)}
            className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 text-sm"
          >
            {showHistory ? 'Hide' : 'View'} History
          </button>
          <label className="px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 text-sm cursor-pointer">
            {importingCSV ? 'Importing...' : 'Import CSV'}
            <input
              type="file"
              accept=".csv"
              onChange={handleImportCSV}
              className="hidden"
              disabled={importingCSV}
            />
          </label>
        </div>

        <button
          onClick={handleRunPayout}
          disabled={!fromTimestamp || !toTimestamp || loadingData}
          className="px-8 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-lg font-semibold disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {loadingData ? (
            <>
              <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
              Loading Data...
            </>
          ) : (
            'Run Payout'
          )}
        </button>

        {dataError && (
          <div className="mt-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
            <p className="text-sm text-red-600 dark:text-red-400">{dataError}</p>
          </div>
        )}
      </div>

      {/* Historical Payouts */}
      {showHistory && (
        <HistoricalPayoutsView
          payouts={historicalPayouts}
          loading={loadingHistory}
          onRefresh={loadHistoricalPayouts}
        />
      )}

      {/* Payout Results */}
      {hasCalculated && payoutResults && (
        <>
          {/* Summary Cards */}
          <div className="card bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-slate-800 dark:to-slate-700 border-2 border-blue-200 dark:border-blue-700">
            <h2 className="text-xl font-semibold mb-4">Payout Summary</h2>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatCard label="Money Reward" value={formatCurrency(payoutResults.totalMoneyReward)} color="orange" />
              <StatCard
                label="Item Reward"
                value={formatCurrency(payoutResults.totalItemReward)}
                color="blue"
                clickable={true}
                onClick={() => setShowItemRewards(!showItemRewards)}
              />
              <StatCard
                label="Item Cost"
                value={formatCurrency(payoutResults.totalItemCost)}
                color="red"
                clickable={true}
                onClick={() => setShowItemCosts(!showItemCosts)}
              />
              <StatCard label="Net Total" value={formatCurrency(payoutResults.totalMoneyReward + payoutResults.netItemValue)} color="green" />

              <StatCard label="Faction Cut" value={`${factionCutPercent}%`} color="purple" />
              <StatCard label="Member Pool" value={formatCurrency(payoutResults.memberPayoutTotal)} color="indigo" />
              <StatCard label="Members" value={payoutResults.participatingMembers} color="teal" />
              <StatCard label="Crimes" value={payoutResults.totalCrimes || payoutResults.crimesProcessed} color="gray" />
            </div>

            <button
              onClick={() => setShowCrimeStats(!showCrimeStats)}
              className="mt-4 text-sm text-blue-600 dark:text-blue-400 hover:underline"
            >
              {showCrimeStats ? 'Hide' : 'Show'} Crime Statistics
            </button>
          </div>

          {/* Crime Statistics */}
          {showCrimeStats && crimeStats && (
            <CrimeStatsView
              stats={crimeStats}
              fromTimestamp={fromTimestamp}
              toTimestamp={toTimestamp}
              onClose={() => setShowCrimeStats(false)}
            />
          )}

          {/* Item Rewards Breakdown */}
          {showItemRewards && payoutResults.itemBreakdown?.rewards && (
            <div className="card bg-blue-50 dark:bg-blue-900/20 border-2 border-blue-200 dark:border-blue-700">
              <h4 className="font-semibold text-blue-900 dark:text-blue-100 mb-3">Item Rewards Breakdown</h4>

              <div className="overflow-x-auto">
                <div className="min-w-full">
                  {/* Header Row */}
                  <div className="grid grid-cols-4 gap-2 text-xs font-semibold text-blue-700 dark:text-blue-300 border-b border-blue-300 dark:border-blue-700 pb-2 mb-2">
                    <div>Item Name</div>
                    <div className="text-right">Unit Value</div>
                    <div className="text-right">Quantity</div>
                    <div className="text-right">Total Value</div>
                  </div>

                  {/* Data Rows */}
                  <div className="space-y-1">
                    {Object.entries(payoutResults.itemBreakdown.rewards).map(([itemId, data]) => {
                      const unitValue = data.quantity > 0 ? Math.floor(data.totalValue / data.quantity) : 0
                      return (
                        <div key={itemId} className="grid grid-cols-4 gap-2 text-sm">
                          <div className="text-blue-800 dark:text-blue-200 truncate" title={data.name}>
                            {data.name}
                          </div>
                          <div className="text-right text-blue-700 dark:text-blue-300">
                            {formatCurrency(unitValue)}
                          </div>
                          <div className="text-right text-blue-700 dark:text-blue-300">
                            {data.quantity.toLocaleString()}
                          </div>
                          <div className="text-right font-semibold text-blue-900 dark:text-blue-100">
                            {formatCurrency(data.totalValue)}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>

              <div className="mt-3 pt-2 border-t border-blue-300 dark:border-blue-700 flex justify-between font-bold">
                <span className="text-blue-900 dark:text-blue-100">Total:</span>
                <span className="text-blue-900 dark:text-blue-100">{formatCurrency(payoutResults.totalItemReward)}</span>
              </div>
            </div>
          )}

          {/* Item Costs Breakdown */}
          {showItemCosts && payoutResults.itemBreakdown?.costs && (
            <div className="card bg-red-50 dark:bg-red-900/20 border-2 border-red-200 dark:border-red-700">
              <h4 className="font-semibold text-red-900 dark:text-red-100 mb-3">Item Costs Breakdown</h4>

              <div className="overflow-x-auto">
                <div className="min-w-full">
                  {/* Header Row */}
                  <div className="grid grid-cols-4 gap-2 text-xs font-semibold text-red-700 dark:text-red-300 border-b border-red-300 dark:border-red-700 pb-2 mb-2">
                    <div>Item Name</div>
                    <div className="text-right">Unit Value</div>
                    <div className="text-right">Quantity</div>
                    <div className="text-right">Total Value</div>
                  </div>

                  {/* Data Rows */}
                  <div className="space-y-1">
                    {Object.entries(payoutResults.itemBreakdown.costs).map(([itemId, data]) => {
                      const unitValue = data.quantity > 0 ? Math.floor(data.totalValue / data.quantity) : 0
                      return (
                        <div key={itemId} className="grid grid-cols-4 gap-2 text-sm">
                          <div className="text-red-800 dark:text-red-200 truncate" title={data.name}>
                            {data.name}
                          </div>
                          <div className="text-right text-red-700 dark:text-red-300">
                            {formatCurrency(unitValue)}
                          </div>
                          <div className="text-right text-red-700 dark:text-red-300">
                            {data.quantity.toLocaleString()}
                          </div>
                          <div className="text-right font-semibold text-red-900 dark:text-red-100">
                            {formatCurrency(data.totalValue)}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>

              <div className="mt-3 pt-2 border-t border-red-300 dark:border-red-700 flex justify-between font-bold">
                <span className="text-red-900 dark:text-red-100">Total:</span>
                <span className="text-red-900 dark:text-red-100">{formatCurrency(payoutResults.totalItemCost)}</span>
              </div>
            </div>
          )}

          {/* Action Buttons */}
          <div className="card">
            <div className="flex flex-wrap gap-2">
              <button
                onClick={handleExportCSV}
                className="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700"
              >
                Export CSV
              </button>
              <button
                onClick={handleCopyBatchURL}
                className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700"
              >
                Copy Batch URL
              </button>
              <button
                onClick={handleSaveWeek}
                disabled={isSaving || payoutResults.members.length === 0}
                className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSaving ? 'Saving...' : 'Save to Database'}
              </button>
            </div>

            {saveSuccess && (
              <div className="mt-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4">
                <p className="text-sm text-green-600 dark:text-green-400">
                  Payout saved successfully! {payoutResults.crimeIds.length} crimes linked.
                </p>
              </div>
            )}

            {saveError && (
              <div className="mt-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
                <p className="text-sm text-red-600 dark:text-red-400">{saveError}</p>
              </div>
            )}

            {showBatchURL && (
              <div className="mt-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
                <p className="text-sm text-blue-600 dark:text-blue-400">
                  Batch payout URL copied to clipboard!
                </p>
              </div>
            )}
          </div>

          {/* Member Payouts Table */}
          <div className="card">
            <h3 className="text-lg font-semibold mb-4">Member Payouts</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b-2 border-gray-200 dark:border-slate-700">
                  <tr className="text-left">
                    <th className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700" onClick={() => handleSort('name')}>
                      Member <SortIcon columnKey="name" />
                    </th>
                    <th className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700" onClick={() => handleSort('userId')}>
                      ID <SortIcon columnKey="userId" />
                    </th>
                    <th className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700" onClick={() => handleSort('timeSpent')}>
                      Time <SortIcon columnKey="timeSpent" />
                    </th>
                    <th className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700" onClick={() => handleSort('timePercent')}>
                      Time % <SortIcon columnKey="timePercent" />
                    </th>
                    <th className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700" onClick={() => handleSort('tier')}>
                      Tier <SortIcon columnKey="tier" />
                    </th>
                    <th className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700" onClick={() => handleSort('baseTickets')}>
                      Tickets <SortIcon columnKey="baseTickets" />
                    </th>
                    <th className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700" onClick={() => handleSort('sitOutPenalty')}>
                      Penalty <SortIcon columnKey="sitOutPenalty" />
                    </th>
                    <th className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700" onClick={() => handleSort('sharePercent')}>
                      Share % <SortIcon columnKey="sharePercent" />
                    </th>
                    <th className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700" onClick={() => handleSort('payout')}>
                      Payout <SortIcon columnKey="payout" />
                    </th>
                    <th className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700" onClick={() => handleSort('theoreticalPayout')}>
                      Theoretical <SortIcon columnKey="theoreticalPayout" />
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sortedMembers.length === 0 ? (
                    <tr>
                      <td colSpan="10" className="py-8 text-center text-gray-500">
                        No payouts calculated. Click "Run Payout" to calculate.
                      </td>
                    </tr>
                  ) : (
                    sortedMembers.map((member) => (
                      <tr key={member.userId} className="border-b border-gray-200 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-700/50">
                        <td className="py-2 px-2 font-medium text-xs">{member.name}</td>
                        <td className="py-2 px-2 text-xs text-gray-600 dark:text-gray-400">{member.userId}</td>
                        <td className="py-2 px-2 text-xs">{formatTimeHours(member.timeSpent)}</td>
                        <td className="py-2 px-2 text-xs">{member.timePercent.toFixed(2)}%</td>
                        <td className="py-2 px-2"><TierBadge tier={member.tier} /></td>
                        <td className="py-2 px-2 text-xs">{member.baseTickets}</td>
                        <td className="py-2 px-2 text-xs">
                          <span className={member.sitOutPenalty < 0 ? 'text-red-600' : ''}>
                            {member.sitOutPenalty.toFixed(0)}
                          </span>
                        </td>
                        <td className="py-2 px-2 text-xs">{(member.sharePercent * 100).toFixed(4)}%</td>
                        <td className="py-2 px-2 font-semibold text-blue-600 dark:text-blue-400 text-xs">
                          {formatCurrency(member.payout)}
                        </td>
                        <td className="py-2 px-2 text-xs text-gray-600 dark:text-gray-400">
                          {formatCurrency(member.theoreticalPayout)}
                          {member.payout > member.theoreticalPayout && (
                            <span className="ml-1 text-green-600">+</span>
                          )}
                          {member.payout < member.theoreticalPayout && (
                            <span className="ml-1 text-red-600">-</span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
                {sortedMembers.length > 0 && (
                  <tfoot className="border-t-2 border-gray-300 dark:border-slate-600">
                    <tr className="font-bold">
                      <td colSpan="8" className="py-2 px-2 text-right text-xs">TOTAL:</td>
                      <td className="py-2 px-2 text-blue-600 dark:text-blue-400 text-xs">
                        {formatCurrency(payoutResults.memberPayoutTotal)}
                      </td>
                      <td className="py-2 px-2 text-gray-600 dark:text-gray-400 text-xs">
                        {formatCurrency(sortedMembers.reduce((sum, m) => sum + m.theoreticalPayout, 0))}
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>
        </>
      )}

      {/* Help Text */}
      {!hasCalculated && !showHistory && (
        <div className="card bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
          <h3 className="font-semibold text-blue-900 dark:text-blue-100 mb-2">How to Use</h3>
          <ol className="text-sm text-blue-800 dark:text-blue-200 space-y-2 list-decimal list-inside">
            <li>Select date range (or use Current/Previous Week buttons)</li>
            <li>Adjust Faction Cut % if needed (default: 20%)</li>
            <li>Click "Run Payout" to load data from Supabase and calculate</li>
            <li>Review the Payout Summary and Member Payouts table</li>
            <li>Compare Actual Payout vs Theoretical Payout per member</li>
            <li>Click "Save to Database" to store in Supabase with crime links</li>
            <li>Use "Import CSV" to import historical payout sheets</li>
          </ol>
        </div>
      )}
    </div>
  )
}

function StatCard({ label, value, color, clickable, onClick }) {
  const colorClasses = {
    orange: 'border-orange-200 dark:border-orange-700',
    blue: 'border-blue-200 dark:border-blue-700',
    red: 'border-red-200 dark:border-red-700',
    green: 'border-green-200 dark:border-green-700',
    purple: 'border-purple-200 dark:border-purple-700',
    indigo: 'border-indigo-200 dark:border-indigo-700',
    teal: 'border-teal-200 dark:border-teal-700',
    gray: 'border-gray-200 dark:border-gray-700'
  }

  const textClasses = {
    orange: 'text-orange-600 dark:text-orange-400',
    blue: 'text-blue-600 dark:text-blue-400',
    red: 'text-red-600 dark:text-red-400',
    green: 'text-green-600 dark:text-green-400',
    purple: 'text-purple-600 dark:text-purple-400',
    indigo: 'text-indigo-600 dark:text-indigo-400',
    teal: 'text-teal-600 dark:text-teal-400',
    gray: 'text-gray-600 dark:text-gray-400'
  }

  return (
    <div
      className={`bg-white dark:bg-slate-800 rounded-lg p-3 border-2 ${colorClasses[color]} ${clickable ? 'cursor-pointer hover:shadow-lg transition-shadow' : ''}`}
      onClick={clickable ? onClick : undefined}
    >
      <div className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1">
        {label}
        {clickable && <span className="ml-1 text-gray-400">▼</span>}
      </div>
      <div className={`text-lg font-bold ${textClasses[color]}`}>{value}</div>
    </div>
  )
}

function TierBadge({ tier }) {
  const colors = {
    1: 'bg-yellow-500',
    2: 'bg-orange-500',
    3: 'bg-red-500',
    4: 'bg-purple-500',
    5: 'bg-blue-500',
    6: 'bg-gray-500'
  }
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-white font-semibold text-xs ${colors[tier]}`}>
      T{tier}
    </span>
  )
}

function CrimeStatsView({ stats, fromTimestamp, toTimestamp, onClose }) {
  const [expandedCrime, setExpandedCrime] = useState(null)
  const [statusFilters, setStatusFilters] = useState({
    success: true,
    failed: true,
    pending: false
  })

  // Filter crimes to only those executed in the pay period
  const payPeriodCrimes = useMemo(() => {
    return (stats?.crimesList || []).filter(crime => {
      if (!crime.executed_at) return false
      return crime.executed_at >= fromTimestamp && crime.executed_at <= toTimestamp
    })
  }, [stats, fromTimestamp, toTimestamp])

  const filteredStats = useMemo(() => getCrimeStats(payPeriodCrimes), [payPeriodCrimes])

  const filteredCrimes = useMemo(() => {
    return payPeriodCrimes.filter(crime => {
      const isSuccess = crime.status === 'Successful' || crime.status === 'Success'
      const isFailed = crime.status === 'Failed' || crime.status === 'Failure'
      const isPending = crime.status === 'Planning' || crime.status === 'Recruiting'

      if (isSuccess && !statusFilters.success) return false
      if (isFailed && !statusFilters.failed) return false
      if (isPending && !statusFilters.pending) return false

      return true
    })
  }, [payPeriodCrimes, statusFilters])

  const toggleFilter = (filter) => {
    setStatusFilters(prev => ({ ...prev, [filter]: !prev[filter] }))
  }

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold">Crime Statistics (Pay Period Only)</h3>
        <button onClick={onClose} className="text-gray-500 hover:text-gray-700">
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <div className="bg-white dark:bg-slate-800 rounded-lg p-3 border border-gray-200">
          <div className="text-xs text-gray-600 dark:text-gray-400">Total Crimes</div>
          <div className="text-2xl font-bold">{filteredStats.totals.count}</div>
        </div>
        <div className="bg-white dark:bg-slate-800 rounded-lg p-3 border border-green-200">
          <div className="text-xs text-gray-600 dark:text-gray-400">Successful</div>
          <div className="text-xl font-bold text-green-600">{filteredStats.totals.success}</div>
        </div>
        <div className="bg-white dark:bg-slate-800 rounded-lg p-3 border border-red-200">
          <div className="text-xs text-gray-600 dark:text-gray-400">Failed</div>
          <div className="text-xl font-bold text-red-600">{filteredStats.totals.failed}</div>
        </div>
        <div className="bg-white dark:bg-slate-800 rounded-lg p-3 border border-blue-200">
          <div className="text-xs text-gray-600 dark:text-gray-400">Total Money</div>
          <div className="text-lg font-bold text-blue-600">{formatCurrency(filteredStats.totals.totalMoney)}</div>
        </div>
      </div>

      <h4 className="font-semibold mb-2">By Difficulty Level</h4>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-4">
        {Object.entries(filteredStats.byDifficulty)
          .sort(([a], [b]) => parseInt(a) - parseInt(b))
          .map(([level, data]) => {
            const successRate = data.total > 0 ? ((data.success / data.total) * 100).toFixed(1) : 0
            return (
              <div key={level} className="bg-white dark:bg-slate-800 rounded-lg p-2 border border-gray-200 dark:border-slate-700 text-center">
                <div className="text-xs font-semibold text-gray-600 dark:text-gray-400">Level {level}</div>
                <div className="text-sm">
                  <span className="text-green-600">{data.success}</span>
                  {' / '}
                  <span className="text-red-600">{data.failed}</span>
                </div>
                <div className="text-xs text-gray-500">
                  {successRate}% success
                </div>
              </div>
            )
          })}
      </div>

      <div className="mb-4">
        <h4 className="font-semibold mb-2">Filter by Status</h4>
        <div className="flex gap-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={statusFilters.success}
              onChange={() => toggleFilter('success')}
              className="w-4 h-4 text-green-600"
            />
            <span className="text-sm">Success ({filteredStats.totals.success})</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={statusFilters.failed}
              onChange={() => toggleFilter('failed')}
              className="w-4 h-4 text-red-600"
            />
            <span className="text-sm">Failed ({filteredStats.totals.failed})</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={statusFilters.pending}
              onChange={() => toggleFilter('pending')}
              className="w-4 h-4 text-yellow-600"
            />
            <span className="text-sm">Pending (Planning/Recruiting)</span>
          </label>
        </div>
      </div>

      <h4 className="font-semibold mb-2">Individual Crimes ({filteredCrimes.length} shown)</h4>
      <div className="space-y-2 max-h-96 overflow-y-auto">
        {filteredCrimes.map((crime) => {
          const isPending = crime.status === 'Planning' || crime.status === 'Recruiting'
          const isSuccess = crime.status === 'Successful' || crime.status === 'Success'

          return (
            <div key={crime.id} className="bg-white dark:bg-slate-800 rounded-lg border border-gray-200 dark:border-slate-700">
              <div
                className="p-3 cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-700/50 flex items-center justify-between"
                onClick={() => setExpandedCrime(expandedCrime === crime.id ? null : crime.id)}
              >
                <div className="flex items-center gap-3">
                  <span className="text-lg">{expandedCrime === crime.id ? '▼' : '▶'}</span>
                  <div>
                    <div className="font-semibold text-sm">
                      {crime.name} (Level {crime.difficulty})
                    </div>
                    <div className="text-xs text-gray-500">
                      Crime #{crime.id} • {crime.participants.length} participants
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {isSuccess && (
                    <span className="text-green-600 font-semibold text-sm">
                      {formatCurrency(crime.moneyReward)}
                    </span>
                  )}
                  <span className={`px-2 py-1 rounded text-xs font-medium ${isSuccess
                      ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
                      : isPending
                        ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400'
                        : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400'
                    }`}>
                    {crime.status}
                  </span>
                </div>
              </div>

              {expandedCrime === crime.id && (
                <div className="px-3 pb-3 border-t border-gray-200 dark:border-slate-700">
                  <div className="mt-3">
                    <h5 className="font-semibold text-xs mb-2">Participants:</h5>
                    <div className="space-y-1">
                      {crime.slots && crime.slots.length > 0 ? (
                        crime.slots
                          .filter(slot => slot.user && slot.user.id)
                          .map((slot, idx) => {
                            const positionLabel = slot.position_number
                              ? `${slot.position} ${slot.position_number}`
                              : slot.position

                            const userName = slot.user.name || 'Unknown'
                            const userId = slot.user.id
                            const displayName = userName.includes('[') ? userName : `${userName} [${userId}]`

                            return (
                              <div key={idx} className="text-xs flex justify-between items-center py-1">
                                <span className="text-gray-700 dark:text-gray-300">
                                  {displayName} - {positionLabel}
                                </span>
                                <span className="text-gray-500">
                                  CPR: {(slot.checkpoint_pass_rate || 0).toFixed(1)}%
                                </span>
                              </div>
                            )
                          })
                      ) : (
                        <div className="text-xs text-gray-500">No participant data available</div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function HistoricalPayoutsView({ payouts, loading, onRefresh }) {
  if (loading) {
    return (
      <div className="card">
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mr-3"></div>
          <p className="text-gray-600 dark:text-gray-400">Loading historical payouts...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold">Historical Payouts</h3>
        <button
          onClick={onRefresh}
          className="px-3 py-1 bg-blue-600 text-white text-sm rounded hover:bg-blue-700"
        >
          Refresh
        </button>
      </div>

      {payouts.length === 0 ? (
        <p className="text-center text-gray-500 py-8">No historical payouts found</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b-2 border-gray-200 dark:border-slate-700">
              <tr className="text-left">
                <th className="py-2 px-2 font-semibold text-xs">Week</th>
                <th className="py-2 px-2 font-semibold text-xs">Total Payout</th>
                <th className="py-2 px-2 font-semibold text-xs">Members</th>
                <th className="py-2 px-2 font-semibold text-xs">Crimes</th>
                <th className="py-2 px-2 font-semibold text-xs">Faction Cut</th>
                <th className="py-2 px-2 font-semibold text-xs">Saved By</th>
              </tr>
            </thead>
            <tbody>
              {payouts.map((payout) => (
                <tr key={payout.id} className="border-b border-gray-200 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-700/50">
                  <td className="py-2 px-2 text-xs">
                    {payout.week_start} to {payout.week_end}
                  </td>
                  <td className="py-2 px-2 text-xs font-semibold text-blue-600">
                    {formatCurrencyShort(payout.member_payout_total || payout.total_member_payout || 0)}
                  </td>
                  <td className="py-2 px-2 text-xs">{payout.member_count || '-'}</td>
                  <td className="py-2 px-2 text-xs">
                    {payout.crimes_processed || (payout.crime_ids?.length || 0)}
                  </td>
                  <td className="py-2 px-2 text-xs">{payout.faction_cut_percent?.toFixed(0) || 20}%</td>
                  <td className="py-2 px-2 text-xs text-gray-500">{payout.saved_by}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}