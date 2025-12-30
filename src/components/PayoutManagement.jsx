import { useState, useMemo, useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { config } from '../config'
import {
  getCurrentWeekRange,
  getPreviousWeekRange,
  getCustomRange,
  calculatePayoutsWithItems,
  formatTimeSpent,
  formatCurrency,
  formatPercent,
  exportPayoutsToCSV,
  exportPayoutsToJSON,
  generateBatchPayoutURL
} from '../utils/payoutCalculations'

export default function PayoutManagement({ cprData, crimesData }) {
  const { user } = useAuth()
  
  // Date range state
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [fromTimestamp, setFromTimestamp] = useState(null)
  const [toTimestamp, setToTimestamp] = useState(null)
  
  // Faction cut state (editable)
  const [factionCutPercent, setFactionCutPercent] = useState(20)
  
  // UI state
  const [hasCalculated, setHasCalculated] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [saveError, setSaveError] = useState(null)
  const [showBatchURL, setShowBatchURL] = useState(false)
  const [showItemDetails, setShowItemDetails] = useState(false)
  
  // Sorting state
  const [sortConfig, setSortConfig] = useState({ key: null, direction: 'desc' })

  // Initialize with current week on mount
  useEffect(() => {
    const currentWeek = getCurrentWeekRange()
    setFromDate(currentWeek.monday.toISOString().split('T')[0])
    setToDate(currentWeek.sunday.toISOString().split('T')[0])
    setFromTimestamp(currentWeek.mondayTimestamp)
    setToTimestamp(currentWeek.sundayTimestamp)
  }, [])

  // Calculate payouts
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

    console.log('=== PAYOUT CALCULATION DEBUG ===')
    console.log('Date range:', new Date(fromTimestamp * 1000), 'to', new Date(toTimestamp * 1000))
    console.log('Faction cut:', factionCutPercent + '%')
    
    const results = calculatePayoutsWithItems(
      crimesData,
      cprData,
      fromTimestamp,
      toTimestamp,
      config,
      factionCutPercent / 100 // Pass as decimal
    )
    
    console.log('Item details:', results.itemDetails)
    console.log('Item reward:', results.itemReward)
    console.log('Item cost:', results.itemCost)
    
    return results
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
    itemDetails
  } = payoutResults

  // Sorted members
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
        const totalTime = payoutResults.totalTimeSpent || 1
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
  }, [members, sortConfig, payoutResults.totalTimeSpent])

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
      // Trigger recalculation if already calculated
      if (hasCalculated) {
        setHasCalculated(true) // Force recalc
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
      const payoutData = exportPayoutsToJSON(members, payoutResults, user.name)
      
      const existingPayouts = JSON.parse(localStorage.getItem('savedPayouts') || '[]')
      existingPayouts.push(payoutData)
      localStorage.setItem('savedPayouts', JSON.stringify(existingPayouts))

      console.log('Payout data saved:', payoutData)
      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 5000)

    } catch (err) {
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

  function handleExportJSON() {
    const jsonData = exportPayoutsToJSON(sortedMembers, payoutResults, user.name)
    const weekEnding = toDate
    
    const blob = new Blob([JSON.stringify(jsonData, null, 2)], { type: 'application/json' })
    const url = window.URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `payouts_${weekEnding}.json`
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

  return (
    <div className="space-y-6">
      {/* Date Range Selector */}
      <div className="card">
        <h2 className="text-xl font-semibold mb-4">Payout Analysis Window</h2>
        
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-4">
          {/* From Date */}
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

          {/* To Date */}
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

          {/* Faction Cut */}
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

        {/* Status */}
        <div className="mb-4">
          <label className="block text-sm font-medium mb-2">Status:</label>
          <div className="text-sm text-gray-600 dark:text-gray-400">
            {hasCalculated ? '✓ Payouts calculated' : 'Click "Run Payout" to calculate'}
          </div>
        </div>

        {/* Quick Select Buttons */}
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
        </div>

        {/* Run Payout Button */}
        <button
          onClick={handleRunPayout}
          disabled={!fromTimestamp || !toTimestamp}
          className="px-8 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-lg font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Run Payout
        </button>
      </div>

      {/* Payout Summary Dashboard */}
      {hasCalculated && (
        <>
          <div className="card bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-slate-800 dark:to-slate-700 border-2 border-blue-200 dark:border-blue-700">
            <h2 className="text-xl font-semibold mb-4">Payout Summary</h2>
            
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {/* Faction Cut - Editable */}
              <div className="bg-white dark:bg-slate-800 rounded-lg p-3 border-2 border-purple-200 dark:border-purple-600">
                <div className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1">Faction Cut</div>
                <div className="text-xl font-bold text-purple-600 dark:text-purple-400">
                  {formatPercent(factionCutPercent)}
                </div>
              </div>

              {/* Money Reward */}
              <div className="bg-white dark:bg-slate-800 rounded-lg p-3 border-2 border-gray-200 dark:border-slate-600">
                <div className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1">Money Reward</div>
                <div className="text-lg font-bold text-orange-600 dark:text-orange-400">
                  {formatCurrency(totalMoneyReward)}
                </div>
              </div>

              {/* Item Reward - Clickable */}
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

              {/* Item Cost - Clickable */}
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

              {/* Member Payout */}
              <div className="bg-white dark:bg-slate-800 rounded-lg p-3 border-2 border-gray-200 dark:border-slate-600">
                <div className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1">Member Payout</div>
                <div className="text-lg font-bold text-purple-600 dark:text-purple-400">
                  {formatCurrency(memberPayout)}
                </div>
              </div>

              {/* Participating Members */}
              <div className="bg-white dark:bg-slate-800 rounded-lg p-3 border-2 border-gray-200 dark:border-slate-600">
                <div className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1">Participating Members</div>
                <div className="text-xl font-bold text-indigo-600 dark:text-indigo-400">
                  {participatingMembers}
                </div>
              </div>

              {/* Payout Per Member */}
              <div className="bg-white dark:bg-slate-800 rounded-lg p-3 border-2 border-gray-200 dark:border-slate-600">
                <div className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1">Payout Per Member</div>
                <div className="text-lg font-bold text-teal-600 dark:text-teal-400">
                  {formatCurrency(payoutPerMember)}
                </div>
              </div>

              {/* Crimes Completed */}
              <div className="bg-white dark:bg-slate-800 rounded-lg p-3 border-2 border-gray-200 dark:border-slate-600">
                <div className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1">Crimes Completed</div>
                <div className="text-xl font-bold text-gray-700 dark:text-gray-300">
                  {crimesProcessed}
                </div>
              </div>
            </div>
          </div>

          {/* Item Details Expandable Section */}
          {showItemDetails && itemDetails && itemDetails.length > 0 && (
            <ItemDetailsView itemDetails={itemDetails} />
          )}

          {/* Action Buttons */}
          <div className="card">
            <div className="flex flex-wrap gap-2">
              <button
                onClick={handleExportCSV}
                className="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors"
              >
                📊 Export CSV
              </button>
              <button
                onClick={handleExportJSON}
                className="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors"
              >
                📄 Export JSON
              </button>
              <button
                onClick={handleCopyBatchURL}
                className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors"
              >
                🔗 Copy Batch URL
              </button>
              <button
                onClick={handleSaveWeek}
                disabled={isSaving || members.length === 0}
                className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSaving ? 'Saving...' : '💾 Save Week'}
              </button>
            </div>

            {/* Success/Error Messages */}
            {saveSuccess && (
              <div className="mt-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4">
                <p className="text-sm text-green-600 dark:text-green-400">
                  ✅ Week saved successfully!
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
                  ✅ Batch payout URL copied to clipboard!
                </p>
              </div>
            )}
          </div>

          {/* Member Payout Table */}
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
                      const timePercent = payoutResults.totalTimeSpent > 0 
                        ? ((member.timeSpent / payoutResults.totalTimeSpent) * 100)
                        : 0
                      
                      return (
                        <tr key={member.userId} className="border-b border-gray-200 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-700/50">
                          <td className="py-2 px-2 font-medium text-xs">{member.name}</td>
                          <td className="py-2 px-2 text-xs text-gray-600 dark:text-gray-400">
                            {member.userId}
                          </td>
                          <td className="py-2 px-2 text-xs">
                            {formatTimeSpent(member.timeSpent)}
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

      {/* Instructions */}
      {!hasCalculated && (
        <div className="card bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
          <h3 className="font-semibold text-blue-900 dark:text-blue-100 mb-2">
            📋 How to Use
          </h3>
          <ol className="text-sm text-blue-800 dark:text-blue-200 space-y-2 list-decimal list-inside">
            <li>Select date range (or use Current/Previous Week buttons)</li>
            <li>Adjust Faction Cut % if needed (default: 20%)</li>
            <li>Click <strong>"Run Payout"</strong> to calculate payouts</li>
            <li>Review the Payout Summary dashboard</li>
            <li>Click Item Reward/Cost boxes to see item details</li>
            <li>Check member payouts - click any column header to sort</li>
            <li>Use action buttons to export or copy batch URL</li>
          </ol>
        </div>
      )}
    </div>
  )
}

// Item Details Component
function ItemDetailsView({ itemDetails }) {
  const [sortKey, setSortKey] = useState('totalValue')
  const [sortDir, setSortDir] = useState('desc')

  const sortedItems = useMemo(() => {
    return [...itemDetails].sort((a, b) => {
      const getValue = (item) => {
        switch (sortKey) {
          case 'name': return item.id
          case 'status': return item.status
          case 'quantity': return item.quantity
          case 'totalValue': return item.quantity * estimateItemValue(item.id)
          default: return 0
        }
      }

      const aVal = getValue(a)
      const bVal = getValue(b)

      if (sortDir === 'asc') {
        return aVal > bVal ? 1 : -1
      } else {
        return aVal < bVal ? 1 : -1
      }
    })
  }, [itemDetails, sortKey, sortDir])

  const handleSort = (key) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  // Temporary estimate - will be replaced with inventory lookup
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

  const totalReward = sortedItems
    .filter(i => i.status === 'reward')
    .reduce((sum, i) => sum + (i.quantity * estimateItemValue(i.id)), 0)

  const totalUsed = sortedItems
    .filter(i => i.status === 'used')
    .reduce((sum, i) => sum + (i.quantity * estimateItemValue(i.id)), 0)

  return (
    <div className="card bg-gradient-to-br from-purple-50 to-pink-50 dark:from-slate-800 dark:to-slate-700 border-2 border-purple-200 dark:border-purple-700">
      <h3 className="text-lg font-semibold mb-4">Item Details</h3>
      
      {/* Summary */}
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

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b-2 border-gray-200 dark:border-slate-700">
            <tr className="text-left">
              <th 
                className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-100"
                onClick={() => handleSort('name')}
              >
                Item ID {sortKey === 'name' && (sortDir === 'asc' ? '↑' : '↓')}
              </th>
              <th 
                className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-100"
                onClick={() => handleSort('status')}
              >
                Type {sortKey === 'status' && (sortDir === 'asc' ? '↑' : '↓')}
              </th>
              <th 
                className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-100"
                onClick={() => handleSort('quantity')}
              >
                Quantity {sortKey === 'quantity' && (sortDir === 'asc' ? '↑' : '↓')}
              </th>
              <th className="py-2 px-2 font-semibold text-xs">
                Est. Unit Value
              </th>
              <th 
                className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-100"
                onClick={() => handleSort('totalValue')}
              >
                Total Value {sortKey === 'totalValue' && (sortDir === 'asc' ? '↑' : '↓')}
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedItems.map((item, idx) => {
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

      <div className="mt-4 text-xs text-gray-600 dark:text-gray-400">
        💡 <strong>Note:</strong> Item values are estimates. Set up Inventory Management for accurate costs.
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