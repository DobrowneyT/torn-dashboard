import { useState, useMemo, useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { config } from '../config'
import { supabase } from '../utils/supabase'
import {
  getCurrentWeekRange,
  getPreviousWeekRange,
  calculatePayoutsWithItems,
  formatCurrency,
  formatPercent,
  exportPayoutsToCSV,
  generateBatchPayoutURL
} from '../utils/payoutCalculations'

export default function PayoutManagement({ cprData, crimesData }) {
  const { user } = useAuth()
  
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [fromTimestamp, setFromTimestamp] = useState(null)
  const [toTimestamp, setToTimestamp] = useState(null)
  const [factionCutPercent, setFactionCutPercent] = useState(20)
  
  const [hasCalculated, setHasCalculated] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [saveError, setSaveError] = useState(null)
  const [showBatchURL, setShowBatchURL] = useState(false)
  const [showItemDetails, setShowItemDetails] = useState(false)
  
  const [sortConfig, setSortConfig] = useState({ key: null, direction: 'desc' })
  
  const [historicalPayouts, setHistoricalPayouts] = useState([])
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [importingCSV, setImportingCSV] = useState(false)

  useEffect(() => {
    const currentWeek = getCurrentWeekRange()
    setFromDate(currentWeek.monday.toISOString().split('T')[0])
    setToDate(currentWeek.sunday.toISOString().split('T')[0])
    setFromTimestamp(currentWeek.mondayTimestamp)
    setToTimestamp(currentWeek.sundayTimestamp)
  }, [])

  useEffect(() => {
    if (showHistory) {
      loadHistoricalPayouts()
    }
  }, [showHistory])

  async function loadHistoricalPayouts() {
    try {
      setLoadingHistory(true)
      
      const { data, error } = await supabase
        .from('oc_payout_weeks')
        .select('*')
        .order('week_end', { ascending: false })
        .limit(20)
      
      if (error) throw error
      
      setHistoricalPayouts(data || [])
    } catch (err) {
      console.error('Error loading historical payouts:', err)
      alert(`Failed to load history: ${err.message}`)
    } finally {
      setLoadingHistory(false)
    }
  }

  const payoutResults = useMemo(() => {
    if (!hasCalculated || !fromTimestamp || !toTimestamp || !cprData || !crimesData) {
      return {
        members: [],
        totalMoneyReward: 0,
        itemReward: 0,
        itemCost: 0,
        factionCut: 0,
        factionCutPercent: 0,
        memberPayout: 0,
        participatingMembers: 0,
        payoutPerMember: 0,
        crimesProcessed: 0,
        totalTimeSpent: 0,
        itemDetails: []
      }
    }

    return calculatePayoutsWithItems(
      crimesData,
      cprData,
      fromTimestamp,
      toTimestamp,
      config,
      factionCutPercent / 100
    )
  }, [cprData, crimesData, fromTimestamp, toTimestamp, hasCalculated, factionCutPercent])

  const { 
    members, 
    totalMoneyReward, 
    itemReward,
    itemCost,
    factionCut,
    memberPayout,
    participatingMembers,
    payoutPerMember,
    crimesProcessed,
    itemDetails,
    totalTimeSpent,
    averageTime,
    totalAdjustedTickets
  } = payoutResults

  const sortedMembers = useMemo(() => {
    if (!sortConfig.key) {
      return members
    }

    const sorted = [...members].sort((a, b) => {
      let aVal = a[sortConfig.key]
      let bVal = b[sortConfig.key]

      if (sortConfig.key === 'name') {
        aVal = aVal.toLowerCase()
        bVal = bVal.toLowerCase()
      }
      
      if (sortConfig.key === 'timePercent') {
        const totalTime = totalTimeSpent || 1
        aVal = a.timeSpent / totalTime
        bVal = b.timeSpent / totalTime
      }

      if (aVal < bVal) {
        return sortConfig.direction === 'asc' ? -1 : 1
      }
      if (aVal > bVal) {
        return sortConfig.direction === 'asc' ? 1 : -1
      }
      return 0
    })

    return sorted
  }, [members, sortConfig, totalTimeSpent])

  const handleSort = (key) => {
    let direction = 'desc'
    if (sortConfig.key === key && sortConfig.direction === 'desc') {
      direction = 'asc'
    }
    setSortConfig({ key, direction })
  }

  const SortIcon = ({ columnKey }) => {
    if (sortConfig.key !== columnKey) {
      return <span className="ml-1 text-gray-400">⇅</span>
    }
    return (
      <span className="ml-1">
        {sortConfig.direction === 'asc' ? '↑' : '↓'}
      </span>
    )
  }

  function handleSetCurrentWeek() {
    const currentWeek = getCurrentWeekRange()
    setFromDate(currentWeek.monday.toISOString().split('T')[0])
    setToDate(currentWeek.sunday.toISOString().split('T')[0])
    setFromTimestamp(currentWeek.mondayTimestamp)
    setToTimestamp(currentWeek.sundayTimestamp)
    setHasCalculated(false)
  }

  function handleSetPreviousWeek() {
    const previousWeek = getPreviousWeekRange()
    setFromDate(previousWeek.monday.toISOString().split('T')[0])
    setToDate(previousWeek.sunday.toISOString().split('T')[0])
    setFromTimestamp(previousWeek.mondayTimestamp)
    setToTimestamp(previousWeek.sundayTimestamp)
    setHasCalculated(false)
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
  }

  function handleFactionCutChange(e) {
    const value = parseFloat(e.target.value)
    if (!isNaN(value) && value >= 0 && value <= 100) {
      setFactionCutPercent(value)
      if (hasCalculated) {
        setHasCalculated(true)
      }
    }
  }

  function handleRunPayout() {
    if (!fromTimestamp || !toTimestamp) {
      alert('Please select both FROM and TO dates')
      return
    }
    
    if (fromTimestamp >= toTimestamp) {
      alert('FROM date must be before TO date')
      return
    }
    
    setHasCalculated(true)
  }

  async function handleSaveWeek() {
    setIsSaving(true)
    setSaveError(null)
    setSaveSuccess(false)

    try {
      const weekStart = new Date(fromTimestamp * 1000).toISOString().split('T')[0]
      const weekEnd = new Date(toTimestamp * 1000).toISOString().split('T')[0]
      
      const { data: weekData, error: weekError } = await supabase
        .from('oc_payout_weeks')
        .upsert({
          week_start: weekStart,
          week_end: weekEnd,
          week_start_timestamp: fromTimestamp,
          week_end_timestamp: toTimestamp,
          total_money_reward: totalMoneyReward,
          total_item_reward: itemReward,
          total_item_cost: itemCost,
          net_item_value: itemReward - itemCost,
          faction_cut_percent: factionCutPercent,
          faction_cut_amount: factionCut,
          member_payout_total: memberPayout,
          crimes_processed: crimesProcessed,
          total_time_spent: totalTimeSpent,
          average_time_spent: averageTime,
          total_adjusted_tickets: totalAdjustedTickets,
          min_time_for_full_tickets: 432000,
          min_time_for_any_payout: 172800,
          saved_by: user.name,
          updated_at: new Date().toISOString()
        }, { 
          onConflict: 'week_start,week_end',
          returning: 'representation'
        })
        .select()
        .single()
      
      if (weekError) throw weekError
      
      const weekId = weekData.id
      
      const memberRecords = members.map(m => ({
        week_id: weekId,
        member_id: m.userId.toString(),
        member_name: m.name,
        tier: m.tier,
        base_tickets: m.baseTickets,
        sit_out_penalty: m.sitOutPenalty,
        adjusted_tickets: m.adjustedTickets,
        time_spent: m.timeSpent,
        time_percent: (m.timeSpent / totalTimeSpent) * 100,
        share_percent: m.sharePercent * 100,
        crimes_count: m.crimesCount,
        payout: m.payout
      }))
      
      const { error: deleteError } = await supabase
        .from('oc_payout_members')
        .delete()
        .eq('week_id', weekId)
      
      if (deleteError) console.warn('Error deleting old member records:', deleteError)
      
      const { error: membersError } = await supabase
        .from('oc_payout_members')
        .insert(memberRecords)
      
      if (membersError) throw membersError
      
      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 5000)

    } catch (err) {
      console.error('Error saving payout:', err)
      setSaveError(err.message || 'Failed to save payout data')
    } finally {
      setIsSaving(false)
    }
  }

  function handleExportCSV() {
    const csvContent = exportPayoutsToCSV(sortedMembers, payoutResults)
    const weekEnding = toDate
    
    const blob = new Blob([csvContent], { type: 'text/csv' })
    const url = window.URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `payouts_${weekEnding}.csv`
    a.click()
    window.URL.revokeObjectURL(url)
  }

  function handleCopyBatchURL() {
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
      const text = await file.text()
      const lines = text.trim().split('\n')
      
      if (lines.length < 2) {
        throw new Error('CSV file is empty or invalid')
      }
      
      const headers = lines[0].split(',')
      
      let totalMemberPayout = 0
      const memberRecords = []
      
      for (let i = 1; i < lines.length; i++) {
        const values = lines[i].split(',')
        
        if (values.length < 9) continue
        
        const memberName = values[0]
        const memberId = values[1]
        const timeSpent = parseInt(values[2]) || 0
        const timePercent = parseFloat(values[3].replace('%', '')) || 0
        const tier = parseInt(values[4]) || 6
        const baseTickets = parseInt(values[5]) || 0
        const sitOutPenalty = parseFloat(values[6]) || 0
        const sharePercent = parseFloat(values[7].replace('%', '')) || 0
        const payoutStr = values[8].replace(/[$,"]/g, '')
        const payout = parseInt(payoutStr) || 0
        
        if (!memberId || isNaN(parseInt(memberId))) continue
        
        const adjustedTickets = baseTickets + sitOutPenalty
        
        memberRecords.push({
          member_id: memberId,
          member_name: memberName,
          tier: tier,
          base_tickets: baseTickets,
          sit_out_penalty: sitOutPenalty,
          adjusted_tickets: adjustedTickets,
          time_spent: timeSpent,
          time_percent: timePercent,
          share_percent: sharePercent,
          crimes_count: 0,
          payout: payout
        })
        
        totalMemberPayout += payout
      }
      
      if (memberRecords.length === 0) {
        throw new Error('No valid member records found in CSV')
      }
      
      const weekStart = fromDate
      const weekEnd = toDate
      
      const { data: weekData, error: weekError } = await supabase
        .from('oc_payout_weeks')
        .upsert({
          week_start: weekStart,
          week_end: weekEnd,
          week_start_timestamp: fromTimestamp,
          week_end_timestamp: toTimestamp,
          total_money_reward: 0,
          total_item_reward: 0,
          total_item_cost: 0,
          net_item_value: 0,
          faction_cut_percent: factionCutPercent,
          faction_cut_amount: 0,
          member_payout_total: totalMemberPayout,
          crimes_processed: 0,
          total_time_spent: memberRecords.reduce((sum, m) => sum + m.time_spent, 0),
          average_time_spent: 0,
          total_adjusted_tickets: memberRecords.reduce((sum, m) => sum + m.adjusted_tickets, 0),
          min_time_for_full_tickets: 432000,
          min_time_for_any_payout: 172800,
          saved_by: user.name + ' (CSV Import)',
          updated_at: new Date().toISOString()
        }, {
          onConflict: 'week_start,week_end',
          returning: 'representation'
        })
        .select()
        .single()
      
      if (weekError) throw weekError
      
      const weekId = weekData.id
      
      const { error: deleteError } = await supabase
        .from('oc_payout_members')
        .delete()
        .eq('week_id', weekId)
      
      if (deleteError) console.warn('Error deleting old records:', deleteError)
      
      const membersWithWeekId = memberRecords.map(m => ({ ...m, week_id: weekId }))
      
      const { error: insertError } = await supabase
        .from('oc_payout_members')
        .insert(membersWithWeekId)
      
      if (insertError) throw insertError
      
      alert(`Successfully imported ${memberRecords.length} member payouts for week ${weekStart}`)
      
      event.target.value = ''
      
    } catch (err) {
      console.error('Error importing CSV:', err)
      alert(`Failed to import CSV: ${err.message}`)
    } finally {
      setImportingCSV(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="card">
        <h2 className="text-xl font-semibold mb-4">Payout Analysis Window</h2>
        
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-4">
          <div>
            <label className="block text-sm font-medium mb-2" style={{color: '#22c55e'}}>From Timestamp:</label>
            <div className="grid grid-cols-2 gap-2">
              <input
                type="date"
                value={fromDate}
                onChange={handleFromDateChange}
                className="input"
                style={{backgroundColor: '#dcfce7', borderColor: '#22c55e'}}
              />
              <input
                type="text"
                value={fromTimestamp || ''}
                readOnly
                className="input"
                style={{backgroundColor: '#fed7aa', borderColor: '#f97316'}}
                placeholder="Unix timestamp"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2" style={{color: '#22c55e'}}>To Timestamp:</label>
            <div className="grid grid-cols-2 gap-2">
              <input
                type="date"
                value={toDate}
                onChange={handleToDateChange}
                className="input"
                style={{backgroundColor: '#dcfce7', borderColor: '#22c55e'}}
              />
              <input
                type="text"
                value={toTimestamp || ''}
                readOnly
                className="input"
                style={{backgroundColor: '#fed7aa', borderColor: '#f97316'}}
                placeholder="Unix timestamp"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2" style={{color: '#8b5cf6'}}>Faction Cut (%):</label>
            <input
              type="number"
              value={factionCutPercent}
              onChange={handleFactionCutChange}
              min="0"
              max="100"
              step="0.1"
              className="input"
              style={{backgroundColor: '#ede9fe', borderColor: '#8b5cf6'}}
            />
          </div>
        </div>

        <div className="mb-4">
          <label className="block text-sm font-medium mb-2">Status:</label>
          <div className="text-sm text-gray-600 dark:text-gray-400">
            {hasCalculated ? '✓ Payouts calculated' : 'Click "Run Payout" to calculate'}
          </div>
        </div>

        <div className="flex flex-wrap gap-2 mb-4">
          <button
            onClick={handleSetCurrentWeek}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm"
          >
            Current Week
          </button>
          <button
            onClick={handleSetPreviousWeek}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm"
          >
            Previous Week
          </button>
          <button
            onClick={() => setShowHistory(!showHistory)}
            className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors text-sm"
          >
            {showHistory ? 'Hide' : 'View'} History
          </button>
          <label className="px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 transition-colors text-sm cursor-pointer">
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
          disabled={!fromTimestamp || !toTimestamp}
          className="px-8 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-lg font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Run Payout
        </button>
      </div>

      {showHistory && (
        <HistoricalPayoutsView 
          payouts={historicalPayouts} 
          loading={loadingHistory}
          onRefresh={loadHistoricalPayouts}
        />
      )}

      {hasCalculated && (
        <>
          <div className="card bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-slate-800 dark:to-slate-700 border-2 border-blue-200 dark:border-blue-700">
            <h2 className="text-xl font-semibold mb-4">Payout Summary</h2>
            
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="bg-white dark:bg-slate-800 rounded-lg p-3 border-2 border-purple-200 dark:border-purple-600">
                <div className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1">Faction Cut</div>
                <div className="text-xl font-bold text-purple-600 dark:text-purple-400">
                  {formatPercent(factionCutPercent)}
                </div>
              </div>

              <div className="bg-white dark:bg-slate-800 rounded-lg p-3 border-2 border-gray-200 dark:border-slate-600">
                <div className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1">Money Reward</div>
                <div className="text-lg font-bold text-orange-600 dark:text-orange-400">
                  {formatCurrency(totalMoneyReward)}
                </div>
              </div>

              <div 
                className="bg-white dark:bg-slate-800 rounded-lg p-3 border-2 border-gray-200 dark:border-slate-600 cursor-pointer hover:border-blue-400 transition-colors"
                onClick={() => setShowItemDetails(!showItemDetails)}
              >
                <div className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1 flex items-center justify-between">
                  <span>Item Reward</span>
                  <span className="text-blue-500">{showItemDetails ? '▼' : '▶'}</span>
                </div>
                <div className="text-lg font-bold text-blue-600 dark:text-blue-400">
                  {formatCurrency(itemReward)}
                </div>
              </div>

              <div 
                className="bg-white dark:bg-slate-800 rounded-lg p-3 border-2 border-gray-200 dark:border-slate-600 cursor-pointer hover:border-red-400 transition-colors"
                onClick={() => setShowItemDetails(!showItemDetails)}
              >
                <div className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1 flex items-center justify-between">
                  <span>Item Cost</span>
                  <span className="text-red-500">{showItemDetails ? '▼' : '▶'}</span>
                </div>
                <div className="text-lg font-bold text-red-600 dark:text-red-400">
                  {formatCurrency(itemCost)}
                </div>
              </div>

              <div className="bg-white dark:bg-slate-800 rounded-lg p-3 border-2 border-gray-200 dark:border-slate-600">
                <div className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1">Member Payout</div>
                <div className="text-lg font-bold text-purple-600 dark:text-purple-400">
                  {formatCurrency(memberPayout)}
                </div>
              </div>

              <div className="bg-white dark:bg-slate-800 rounded-lg p-3 border-2 border-gray-200 dark:border-slate-600">
                <div className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1">Participating Members</div>
                <div className="text-xl font-bold text-indigo-600 dark:text-indigo-400">
                  {participatingMembers}
                </div>
              </div>

              <div className="bg-white dark:bg-slate-800 rounded-lg p-3 border-2 border-gray-200 dark:border-slate-600">
                <div className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1">Payout Per Member</div>
                <div className="text-lg font-bold text-teal-600 dark:text-teal-400">
                  {formatCurrency(payoutPerMember)}
                </div>
              </div>

              <div className="bg-white dark:bg-slate-800 rounded-lg p-3 border-2 border-gray-200 dark:border-slate-600">
                <div className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1">Crimes Completed</div>
                <div className="text-xl font-bold text-gray-700 dark:text-gray-300">
                  {crimesProcessed}
                </div>
              </div>
            </div>
          </div>

          {showItemDetails && itemDetails && itemDetails.length > 0 && (
            <ItemDetailsView itemDetails={itemDetails} />
          )}

          <div className="card">
            <div className="flex flex-wrap gap-2">
              <button
                onClick={handleExportCSV}
                className="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors"
              >
                Export CSV
              </button>
              <button
                onClick={handleCopyBatchURL}
                className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors"
              >
                Copy Batch URL
              </button>
              <button
                onClick={handleSaveWeek}
                disabled={isSaving || members.length === 0}
                className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSaving ? 'Saving...' : 'Save to Database'}
              </button>
            </div>

            {saveSuccess && (
              <div className="mt-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4">
                <p className="text-sm text-green-600 dark:text-green-400">
                  Week saved successfully to Supabase!
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

          <div className="card">
            <h3 className="text-lg font-semibold mb-4">Member Payouts</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b-2 border-gray-200 dark:border-slate-700">
                  <tr className="text-left">
                    <th 
                      className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700"
                      onClick={() => handleSort('name')}
                    >
                      Member <SortIcon columnKey="name" />
                    </th>
                    <th 
                      className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700"
                      onClick={() => handleSort('userId')}
                    >
                      ID <SortIcon columnKey="userId" />
                    </th>
                    <th 
                      className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700"
                      onClick={() => handleSort('timeSpent')}
                    >
                      Time <SortIcon columnKey="timeSpent" />
                    </th>
                    <th 
                      className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700"
                      onClick={() => handleSort('timePercent')}
                    >
                      Time % <SortIcon columnKey="timePercent" />
                    </th>
                    <th 
                      className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700"
                      onClick={() => handleSort('tier')}
                    >
                      Tier <SortIcon columnKey="tier" />
                    </th>
                    <th 
                      className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700"
                      onClick={() => handleSort('baseTickets')}
                    >
                      Tickets <SortIcon columnKey="baseTickets" />
                    </th>
                    <th 
                      className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700"
                      onClick={() => handleSort('sitOutPenalty')}
                    >
                      Penalty <SortIcon columnKey="sitOutPenalty" />
                    </th>
                    <th 
                      className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700"
                      onClick={() => handleSort('sharePercent')}
                    >
                      OC % <SortIcon columnKey="sharePercent" />
                    </th>
                    <th 
                      className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700"
                      onClick={() => handleSort('payout')}
                    >
                      OC Payout <SortIcon columnKey="payout" />
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sortedMembers.length === 0 ? (
                    <tr>
                      <td colSpan="9" className="py-8 text-center text-gray-500">
                        No payouts calculated. Click "Run Payout" to calculate.
                      </td>
                    </tr>
                  ) : (
                    sortedMembers.map((member) => {
                      const timePercent = totalTimeSpent > 0 
                        ? ((member.timeSpent / totalTimeSpent) * 100)
                        : 0
                      
                      return (
                        <tr key={member.userId} className="border-b border-gray-200 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-700/50">
                          <td className="py-2 px-2 font-medium text-xs">{member.name}</td>
                          <td className="py-2 px-2 text-xs text-gray-600 dark:text-gray-400">
                            {member.userId}
                          </td>
                          <td className="py-2 px-2 text-xs">
                            {member.timeSpent}
                          </td>
                          <td className="py-2 px-2 text-xs">
                            {isNaN(timePercent) ? 'NaN%' : `${timePercent.toFixed(2)}%`}
                          </td>
                          <td className="py-2 px-2">
                            <TierBadge tier={member.tier} />
                          </td>
                          <td className="py-2 px-2 text-xs">{member.baseTickets || 0}</td>
                          <td className="py-2 px-2 text-xs">
                            <span className={member.sitOutPenalty < 0 ? 'text-red-600' : ''}>
                              {(member.sitOutPenalty || 0).toFixed(2)}
                            </span>
                          </td>
                          <td className="py-2 px-2 text-xs">
                            {((member.sharePercent || 0) * 100).toFixed(4)}%
                          </td>
                          <td className="py-2 px-2 font-semibold text-blue-600 dark:text-blue-400 text-xs">
                            {formatCurrency(member.payout)}
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
                {sortedMembers.length > 0 && (
                  <tfoot className="border-t-2 border-gray-300 dark:border-slate-600">
                    <tr className="font-bold">
                      <td colSpan="8" className="py-2 px-2 text-right text-xs">
                        TOTAL:
                      </td>
                      <td className="py-2 px-2 text-blue-600 dark:text-blue-400 text-xs">
                        {formatCurrency(memberPayout)}
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>
        </>
      )}

      {!hasCalculated && !showHistory && (
        <div className="card bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
          <h3 className="font-semibold text-blue-900 dark:text-blue-100 mb-2">
            How to Use
          </h3>
          <ol className="text-sm text-blue-800 dark:text-blue-200 space-y-2 list-decimal list-inside">
            <li>Select date range (or use Current/Previous Week buttons)</li>
            <li>Adjust Faction Cut % if needed (default: 20%)</li>
            <li>Click <strong>"Run Payout"</strong> to calculate payouts</li>
            <li>Review the Payout Summary dashboard</li>
            <li>Click "Save to Database" to store in Supabase</li>
            <li>Use "Import CSV" to import historical payouts</li>
            <li>Click "View History" to see past weeks</li>
          </ol>
        </div>
      )}
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
                <th className="py-2 px-2 font-semibold text-xs">Saved At</th>
              </tr>
            </thead>
            <tbody>
              {payouts.map((payout) => (
                <tr key={payout.id} className="border-b border-gray-200 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-700/50">
                  <td className="py-2 px-2 text-xs">
                    {payout.week_start} to {payout.week_end}
                  </td>
                  <td className="py-2 px-2 text-xs font-semibold text-blue-600">
                    {formatCurrency(payout.member_payout_total)}
                  </td>
                  <td className="py-2 px-2 text-xs">
                    {payout.total_adjusted_tickets ? 
                      Math.round(payout.total_adjusted_tickets / 40) : 'N/A'}
                  </td>
                  <td className="py-2 px-2 text-xs">{payout.crimes_processed}</td>
                  <td className="py-2 px-2 text-xs">
                    {payout.faction_cut_percent.toFixed(0)}%
                  </td>
                  <td className="py-2 px-2 text-xs">{payout.saved_by}</td>
                  <td className="py-2 px-2 text-xs text-gray-500">
                    {new Date(payout.saved_at).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function ItemDetailsView({ itemDetails }) {
  function estimateItemValue(itemId) {
    const commonValues = {
      '1361': 50000,
      '1362': 100000,
      '1203': 75000,
      '71': 25000,
      '579': 50000,
    }
    return commonValues[itemId] || 50000
  }

  const totalReward = itemDetails
    .filter(i => i.status === 'reward')
    .reduce((sum, i) => sum + (i.quantity * estimateItemValue(i.id)), 0)

  const totalUsed = itemDetails
    .filter(i => i.status === 'used')
    .reduce((sum, i) => sum + (i.quantity * estimateItemValue(i.id)), 0)

  return (
    <div className="card bg-gradient-to-br from-purple-50 to-pink-50 dark:from-slate-800 dark:to-slate-700 border-2 border-purple-200 dark:border-purple-700">
      <h3 className="text-lg font-semibold mb-4">Item Details</h3>
      
      <div className="grid grid-cols-3 gap-4 mb-4">
        <div className="bg-white dark:bg-slate-800 rounded-lg p-3 border border-blue-200">
          <div className="text-xs text-gray-600 dark:text-gray-400">Items Rewarded</div>
          <div className="text-lg font-bold text-blue-600">{formatCurrency(totalReward)}</div>
        </div>
        <div className="bg-white dark:bg-slate-800 rounded-lg p-3 border border-red-200">
          <div className="text-xs text-gray-600 dark:text-gray-400">Items Used</div>
          <div className="text-lg font-bold text-red-600">{formatCurrency(totalUsed)}</div>
        </div>
        <div className="bg-white dark:bg-slate-800 rounded-lg p-3 border border-green-200">
          <div className="text-xs text-gray-600 dark:text-gray-400">Net Value</div>
          <div className="text-lg font-bold text-green-600">{formatCurrency(totalReward - totalUsed)}</div>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b-2 border-gray-200 dark:border-slate-700">
            <tr className="text-left">
              <th className="py-2 px-2 font-semibold text-xs">Item ID</th>
              <th className="py-2 px-2 font-semibold text-xs">Type</th>
              <th className="py-2 px-2 font-semibold text-xs">Quantity</th>
              <th className="py-2 px-2 font-semibold text-xs">Est. Unit Value</th>
              <th className="py-2 px-2 font-semibold text-xs">Total Value</th>
            </tr>
          </thead>
          <tbody>
            {itemDetails.map((item, idx) => {
              const unitValue = estimateItemValue(item.id)
              const totalValue = item.quantity * unitValue
              const isReward = item.status === 'reward'

              return (
                <tr key={idx} className="border-b border-gray-200 dark:border-slate-700">
                  <td className="py-2 px-2 text-xs">{item.id}</td>
                  <td className="py-2 px-2 text-xs">
                    <span className={`px-2 py-0.5 rounded ${isReward ? 'bg-blue-100 text-blue-800' : 'bg-red-100 text-red-800'}`}>
                      {item.status}
                    </span>
                  </td>
                  <td className="py-2 px-2 text-xs">{item.quantity}</td>
                  <td className="py-2 px-2 text-xs">{formatCurrency(unitValue)}</td>
                  <td className={`py-2 px-2 text-xs font-semibold ${isReward ? 'text-blue-600' : 'text-red-600'}`}>
                    {formatCurrency(totalValue)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
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

// Handles CSV imports with week dates from filename

async function handleImportCSV(event) {
  const file = event.target.files[0]
  if (!file) return

  try {
    setImporting(true)
    setImportError(null)

    // Parse week start from filename: "20251215-Forge_OC_Payout.csv"
    const dateMatch = file.name.match(/^(\d{8})/)
    if (!dateMatch) {
      throw new Error('Filename must start with date in YYYYMMDD format (e.g., 20251215-Forge_OC_Payout.csv)')
    }

    const dateStr = dateMatch[1]
    const year = parseInt(dateStr.substring(0, 4))
    const month = parseInt(dateStr.substring(4, 6)) - 1 // JS months are 0-indexed
    const day = parseInt(dateStr.substring(6, 8))

    const weekStart = new Date(year, month, day)
    weekStart.setHours(0, 0, 0, 0)

    // Week ends on Sunday (6 days later)
    const weekEnd = new Date(weekStart)
    weekEnd.setDate(weekEnd.getDate() + 6)
    weekEnd.setHours(23, 59, 59, 999)

    // Verify it's a Monday
    if (weekStart.getDay() !== 1) {
      const confirm = window.confirm(
        `Warning: ${dateStr} is not a Monday. Week start should be Monday. Continue anyway?`
      )
      if (!confirm) {
        setImporting(false)
        return
      }
    }

    const text = await file.text()
    const lines = text.trim().split('\n')
    
    if (lines.length < 2) {
      throw new Error('CSV file is empty or invalid')
    }

    // Parse header
    const headers = lines[0].split(',').map(h => h.trim())
    
    // Find required columns
    const memberCol = headers.findIndex(h => h.toLowerCase().includes('member'))
    const idCol = headers.findIndex(h => h.toLowerCase() === 'id')
    const timeCol = headers.findIndex(h => h.toLowerCase().includes('time spent in'))
    const tierCol = headers.findIndex(h => h.toLowerCase() === 'tier')
    const ticketsCol = headers.findIndex(h => h.toLowerCase() === 'tickets')
    const penaltyCol = headers.findIndex(h => h.toLowerCase().includes('penalty'))
    const shareCol = headers.findIndex(h => h.toLowerCase().includes('share'))
    const payoutCol = headers.findIndex(h => h.toLowerCase().includes('payout'))

    if (memberCol === -1 || idCol === -1 || payoutCol === -1) {
      throw new Error('CSV must have Member, ID, and OC Payout columns')
    }

    // Parse member data
    const members = []
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue

      const values = line.split(',').map(v => v.trim())
      
      const payoutStr = values[payoutCol].replace(/[$,"]/g, '')
      const payout = parseInt(payoutStr)
      
      if (isNaN(payout) || payout === 0) continue

      const timeSpent = timeCol !== -1 ? parseInt(values[timeCol]) : 0
      const tier = tierCol !== -1 ? parseInt(values[tierCol]) : 6
      const tickets = ticketsCol !== -1 ? parseInt(values[ticketsCol]) : 0
      const penalty = penaltyCol !== -1 ? parseFloat(values[penaltyCol]) : 0
      const share = shareCol !== -1 ? parseFloat(values[shareCol].replace('%', '')) : 0

      members.push({
        member_id: values[idCol],
        member_name: values[memberCol],
        tier: tier,
        base_tickets: tickets,
        sit_out_penalty: penalty,
        adjusted_tickets: tickets + penalty,
        share_percent: share / 100,
        time_spent: timeSpent,
        payout: payout,
        week_start: weekStart.toISOString().split('T')[0],
        week_end: weekEnd.toISOString().split('T')[0]
      })
    }

    if (members.length === 0) {
      throw new Error('No valid member data found in CSV')
    }

    // Calculate totals
    const totalPayout = members.reduce((sum, m) => sum + m.payout, 0)
    const totalTime = members.reduce((sum, m) => sum + m.time_spent, 0)
    const avgTime = totalTime / members.length
    const totalTickets = members.reduce((sum, m) => sum + m.adjusted_tickets, 0)

    // Save week summary
    const { data: weekData, error: weekError } = await supabase
      .from('oc_payout_weeks')
      .upsert({
        week_start: weekStart.toISOString().split('T')[0],
        week_end: weekEnd.toISOString().split('T')[0],
        week_start_timestamp: Math.floor(weekStart.getTime() / 1000),
        week_end_timestamp: Math.floor(weekEnd.getTime() / 1000),
        member_payout_total: totalPayout,
        total_member_payout: totalPayout, // Alias for compatibility
        member_count: members.length,
        total_time_spent: totalTime,
        average_time_spent: Math.floor(avgTime),
        total_adjusted_tickets: totalTickets,
        faction_cut_percent: 20, // Default, adjust as needed
        faction_cut_amount: 0,
        total_money_reward: 0,
        total_item_reward: 0,
        total_item_cost: 0,
        net_item_value: 0,
        crimes_processed: 0,
        min_time_for_full_tickets: 432000,
        min_time_for_any_payout: 172800,
        saved_by: user.name,
        saved_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'week_start,week_end'
      })
      .select()
      .single()

    if (weekError) throw weekError

    // Save member payouts
    const membersWithWeekId = members.map(m => ({
      ...m,
      week_id: weekData.id,
      crimes_count: 0, // Will be populated when linked to crimes data
      updated_at: new Date().toISOString()
    }))

    const { error: membersError } = await supabase
      .from('oc_payout_members')
      .upsert(membersWithWeekId, {
        onConflict: 'week_id,member_id'
      })

    if (membersError) throw membersError

    setImportSuccess(`Successfully imported ${members.length} member payouts for week ${weekStart.toLocaleDateString()}`)
    setTimeout(() => setImportSuccess(null), 5000)

    // Reload saved payouts
    loadSavedPayouts()

  } catch (err) {
    setImportError(err.message)
  } finally {
    setImporting(false)
    event.target.value = '' // Reset file input
  }
}