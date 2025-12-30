import { useState, useMemo } from 'react'
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
  
  // UI state
  const [hasCalculated, setHasCalculated] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [saveError, setSaveError] = useState(null)
  const [showBatchURL, setShowBatchURL] = useState(false)
  
  // Sorting state
  const [sortConfig, setSortConfig] = useState({ key: null, direction: 'desc' })

  // Initialize with current week on mount
  useState(() => {
    const currentWeek = getCurrentWeekRange()
    setFromDate(currentWeek.monday.toISOString().split('T')[0])
    setToDate(currentWeek.sunday.toISOString().split('T')[0])
    setFromTimestamp(currentWeek.mondayTimestamp)
    setToTimestamp(currentWeek.sundayTimestamp)
  }, [])

  // Calculate payouts when timestamps are set and "Run Payout" is clicked
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
        debugInfo: []
      }
    }

    console.log('=== PAYOUT CALCULATION DEBUG ===')
    console.log('Date range:', new Date(fromTimestamp * 1000), 'to', new Date(toTimestamp * 1000))
    console.log('Total crimes in database:', Object.keys(crimesData?.crimes || {}).length)
    
    const results = calculatePayoutsWithItems(
      crimesData,
      cprData,
      fromTimestamp,
      toTimestamp,
      config
    )
    
    console.log('Calculation results:', results)
    console.log('Members with time > 0:', results.members.filter(m => m.timeSpent > 0).length)
    console.log('Sample member:', results.members[0])
    
    return results
  }, [cprData, crimesData, fromTimestamp, toTimestamp, hasCalculated])

  const { 
    members, 
    totalMoneyReward, 
    itemReward,
    itemCost,
    factionCut,
    factionCutPercent,
    memberPayout,
    participatingMembers,
    payoutPerMember,
    crimesProcessed 
  } = payoutResults

  // Sorting logic
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

  function handleRunPayout() {
    if (!fromTimestamp || !toTimestamp) {
      alert('Please select both FROM and TO dates')
      return
    }
    
    if (fromTimestamp >= toTimestamp) {
      alert('FROM date must be before TO date')
      return
    }
    
    if (crimesData?.crimes) {
      const crimeEntries = Object.entries(crimesData.crimes).slice(0, 3)
      console.log('Sample crimes:', crimeEntries)
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
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-4">
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

      {/* Payout Summary Dashboard - Only show after calculation */}
      {hasCalculated && (
        <>
          <div className="card bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-slate-800 dark:to-slate-700 border-2 border-blue-200 dark:border-blue-700">
            <h2 className="text-xl font-semibold mb-4">Payout Summary</h2>
            
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {/* Faction Cut */}
              <div className="bg-white dark:bg-slate-800 rounded-lg p-3 border-2 border-gray-200 dark:border-slate-600">
                <div className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1">Faction Cut</div>
                <div className="text-xl font-bold text-green-600 dark:text-green-400">
                  {formatPercent(factionCutPercent)}
                </div>
              </div>

              {/* Money Reward - FULL AMOUNT */}
              <div className="bg-white dark:bg-slate-800 rounded-lg p-3 border-2 border-gray-200 dark:border-slate-600">
                <div className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1">Money Reward</div>
                <div className="text-lg font-bold text-orange-600 dark:text-orange-400">
                  {formatCurrency(totalMoneyReward)}
                </div>
              </div>

              {/* Item Reward - FULL AMOUNT */}
              <div className="bg-white dark:bg-slate-800 rounded-lg p-3 border-2 border-gray-200 dark:border-slate-600">
                <div className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1">Item Reward</div>
                <div className="text-lg font-bold text-blue-600 dark:text-blue-400">
                  {formatCurrency(itemReward)}
                </div>
              </div>

              {/* Item Cost - FULL AMOUNT */}
              <div className="bg-white dark:bg-slate-800 rounded-lg p-3 border-2 border-gray-200 dark:border-slate-600">
                <div className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1">Item Cost</div>
                <div className="text-lg font-bold text-red-600 dark:text-red-400">
                  {formatCurrency(itemCost)}
                </div>
              </div>

              {/* Member Payout - FULL AMOUNT */}
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

              {/* Payout Per Member - FULL AMOUNT */}
              <div className="bg-white dark:bg-slate-800 rounded-lg p-3 border-2 border-gray-200 dark:border-slate-600">
                <div className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1">Payout Per Member</div>
                <div className="text-lg font-bold text-teal-600 dark:text-teal-400">
                  {formatCurrency(payoutPerMember)}
                </div>
              </div>

              {/* Crimes Processed */}
              <div className="bg-white dark:bg-slate-800 rounded-lg p-3 border-2 border-gray-200 dark:border-slate-600">
                <div className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1">Crimes Completed</div>
                <div className="text-xl font-bold text-gray-700 dark:text-gray-300">
                  {crimesProcessed}
                </div>
              </div>
            </div>
          </div>

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
                  ✅ Week saved successfully! Export JSON and commit to <code>public/data/payouts/</code>
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
                    sortedMembers.map((member, index) => {
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

      {/* Instructions - Show only when not calculated */}
      {!hasCalculated && (
        <div className="card bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
          <h3 className="font-semibold text-blue-900 dark:text-blue-100 mb-2">
            📋 How to Use
          </h3>
          <ol className="text-sm text-blue-800 dark:text-blue-200 space-y-2 list-decimal list-inside">
            <li>Select date range (or use Current/Previous Week buttons)</li>
            <li>Click <strong>"Run Payout"</strong> to calculate payouts</li>
            <li>Review the Payout Summary dashboard (matches your Excel sheet)</li>
            <li>Check member payouts in the table - <strong>click any column header to sort!</strong></li>
            <li>Click "Copy Batch URL" to get Torn payout link</li>
            <li>Click "Save Week" to store locally, then export JSON for repository</li>
          </ol>
        </div>
      )}
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