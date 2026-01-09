import { useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { isAdmin } from '../config'
import { supabase } from '../utils/supabase'
import { syncCrimesFromAPI } from '../utils/syncCrimesFromAPI'

export default function DataManagement() {
  const { user } = useAuth()
  const [activeTab, setActiveTab] = useState('import')

  // Check admin access
  if (!isAdmin(user?.id)) {
    return (
      <div className="card">
        <div className="text-center py-12">
          <svg className="mx-auto h-12 w-12 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <h3 className="mt-4 text-lg font-semibold text-gray-900 dark:text-gray-100">
            Access Denied
          </h3>
          <p className="mt-2 text-gray-600 dark:text-gray-400">
            You do not have permission to access Data Management.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="card">
        <div className="flex items-center gap-3">
          <svg className="w-8 h-8 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
          </svg>
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              Data Management
            </h1>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              Import, view, sync, and manage faction database records
            </p>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="card">
        <div className="border-b border-gray-200 dark:border-slate-700">
          <nav className="-mb-px flex gap-6">
            <button
              onClick={() => setActiveTab('import')}
              className={`py-2 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'import'
                  ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                  : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300'
              }`}
            >
              Import Data
            </button>
            <button
              onClick={() => setActiveTab('view')}
              className={`py-2 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'view'
                  ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                  : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300'
              }`}
            >
              View Data
            </button>
            <button
              onClick={() => setActiveTab('sync')}
              className={`py-2 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'sync'
                  ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                  : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300'
              }`}
            >
              API Sync
            </button>
            <button
              onClick={() => setActiveTab('clear')}
              className={`py-2 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'clear'
                  ? 'border-red-500 text-red-600 dark:text-red-400'
                  : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300'
              }`}
            >
              Clear Data
            </button>
          </nav>
        </div>

        <div className="mt-6">
          {activeTab === 'import' && <ImportTab />}
          {activeTab === 'view' && <ViewTab />}
          {activeTab === 'sync' && <SyncTab />}
          {activeTab === 'clear' && <ClearDataTab />}
        </div>
      </div>
    </div>
  )
}

function ImportTab() {
  return (
    <div className="space-y-6">
      <CprDataImport />
      <CrimesDataImport />
      <PayoutCsvImport />
    </div>
  )
}

function CprDataImport() {
  const [file, setFile] = useState(null)
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState(null)

  const handleImport = async () => {
    if (!file) return

    try {
      setImporting(true)
      setResult(null)

      const text = await file.text()
      const data = JSON.parse(text)

      // Handle both formats: { members: {...} } or just {...}
      const membersData = data.members || data

      let membersCount = 0
      let cprRecordsCount = 0

      for (const [memberId, memberData] of Object.entries(membersData)) {
        // Upsert member
        const { error: memberError } = await supabase.from('members').upsert({
          member_id: memberId,
          member_name: memberData.name || `Member ${memberId}`,
          tier: memberData.tier || 6,
          last_scraped: memberData.last_scraped,
          updated_at: new Date().toISOString()
        }, { onConflict: 'member_id' })

        if (memberError) {
          console.error(`Error inserting member ${memberId}:`, memberError)
          continue
        }

        membersCount++

        // Upsert CPR records - handle both cpr_data and cpr_by_role keys
        const cprData = memberData.cpr_data || memberData.cpr_by_role || {}
        for (const [level, roles] of Object.entries(cprData)) {
          for (const [role, value] of Object.entries(roles)) {
            if (typeof value === 'number') {
              const { error: cprError } = await supabase.from('member_cpr').upsert({
                member_id: memberId,
                difficulty_level: parseInt(level),
                role_name: role,
                cpr_value: value,
                updated_at: new Date().toISOString()
              }, { onConflict: 'member_id,difficulty_level,role_name' })

              if (!cprError) cprRecordsCount++
            }
          }
        }
      }

      setResult({ success: true, membersCount, cprRecordsCount })
    } catch (err) {
      setResult({ success: false, error: err.message })
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="card border border-blue-200 dark:border-blue-900/30">
      <h3 className="text-lg font-semibold mb-4">Import CPR Database</h3>
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
        Upload cpr_database.json to import member CPR data into the database.
      </p>

      <input
        type="file"
        accept=".json"
        onChange={(e) => setFile(e.target.files[0])}
        className="block w-full text-sm text-gray-500 dark:text-gray-400
          file:mr-4 file:py-2 file:px-4
          file:rounded-lg file:border-0
          file:text-sm file:font-semibold
          file:bg-blue-100 file:text-blue-700
          hover:file:bg-blue-200
          dark:file:bg-blue-900/50 dark:file:text-blue-400
          dark:hover:file:bg-blue-900/70"
      />

      <button
        onClick={handleImport}
        disabled={!file || importing}
        className="mt-4 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {importing ? 'Importing...' : 'Import CPR Data'}
      </button>

      {result && (
        <div className={`mt-4 p-4 rounded-lg ${result.success ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800' : 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800'}`}>
          {result.success ? (
            <p className="text-sm text-green-600 dark:text-green-400">
              Imported {result.membersCount} members and {result.cprRecordsCount} CPR records
            </p>
          ) : (
            <p className="text-sm text-red-600 dark:text-red-400">
              Error: {result.error}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function CrimesDataImport() {
  const [file, setFile] = useState(null)
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState(null)

  const handleImport = async () => {
    if (!file) return

    try {
      setImporting(true)
      setResult(null)

      const text = await file.text()
      const data = JSON.parse(text)

      // Handle both formats: { crimes: {...} } or just {...}
      const crimesData = data.crimes || data

      let crimesCount = 0
      let slotsCount = 0
      let rewardItemsCount = 0
      let requiredItemsCount = 0

      for (const [crimeId, crimeData] of Object.entries(crimesData)) {
        // Upsert crime
        const { error: crimeError } = await supabase.from('crimes').upsert({
          crime_id: crimeId,
          name: crimeData.name || 'Unknown',
          difficulty: crimeData.difficulty || 1,
          status: crimeData.status || 'Unknown',
          previous_crime_id: crimeData.previous_crime_id?.toString() || null,
          created_at: crimeData.created_at || null,
          planning_at: crimeData.planning_at || null,
          executed_at: crimeData.executed_at || null,
          ready_at: crimeData.ready_at || null,
          expired_at: crimeData.expired_at || null,
          total_slots: crimeData.total_slots || 0,
          filled_slots: crimeData.filled_slots || 0,
          rewards_money: crimeData.rewards?.money || 0,
          rewards_respect: crimeData.rewards?.respect || 0,
          last_updated: crimeData.last_updated || new Date().toISOString(),
          first_seen: crimeData.first_seen || new Date().toISOString(),
          updated_at: new Date().toISOString()
        }, { onConflict: 'crime_id' })

        if (crimeError) {
          console.error(`Error inserting crime ${crimeId}:`, crimeError)
          continue
        }

        crimesCount++

        // Process slots
        const slots = crimeData.slots || []
        for (const slot of slots) {
          const user = slot.user || {}
          const itemReq = slot.item_requirement || {}
          const itemOutcome = user.item_outcome || {}

          const { error: slotError } = await supabase.from('crime_slots').upsert({
            crime_id: crimeId,
            position: slot.position,
            position_id: slot.position_id,
            position_number: slot.position_number,
            checkpoint_pass_rate: slot.checkpoint_pass_rate,
            user_id: user.id?.toString() || null,
            user_name: user.name || null,
            joined_at: user.joined_at || null,
            user_outcome: user.outcome || null,
            user_progress: user.progress || null,
            item_requirement_id: itemReq.id?.toString() || null,
            item_requirement_name: itemReq.name || null,
            item_requirement_is_reusable: itemReq.is_reusable || false,
            item_requirement_is_available: itemReq.is_available || false,
            item_outcome_id: itemOutcome.item_id?.toString() || null,
            item_outcome_outcome: itemOutcome.outcome || null,
            updated_at: new Date().toISOString()
          }, { onConflict: 'crime_id,position_id' })

          if (!slotError) slotsCount++

          // Insert required item if exists
          if (itemReq.id) {
            const wasConsumed = itemOutcome.outcome === 'used'
            
            const { error: reqItemError } = await supabase.from('crime_required_items').upsert({
              crime_id: crimeId,
              position: slot.position,
              position_id: slot.position_id,
              position_number: slot.position_number,
              item_id: itemReq.id.toString(),
              item_name: itemReq.name || null,
              is_reusable: itemReq.is_reusable || false,
              is_available: itemReq.is_available || false,
              user_id: user.id?.toString() || null,
              outcome_owned_by: itemOutcome.owned_by || null,
              outcome_item_id: itemOutcome.item_id?.toString() || null,
              outcome_item_uid: itemOutcome.item_uid?.toString() || null,
              outcome: itemOutcome.outcome || null,
              was_consumed: wasConsumed,
              unit_value: 0,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            }, { onConflict: 'crime_id,position_id' })

            if (!reqItemError) requiredItemsCount++
          }
        }

        // Process reward items
        const rewardItems = crimeData.rewards?.items || []
        for (const rewardItem of rewardItems) {
          const itemId = rewardItem.id?.toString()
          if (!itemId) continue

          const { error: rewardError } = await supabase.from('crime_reward_items').upsert({
            crime_id: crimeId,
            item_id: itemId,
            item_name: rewardItem.name || null,
            quantity: rewardItem.quantity || 1,
            unit_value: 0,
            total_value: 0,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }, { onConflict: 'crime_id,item_id' })

          if (!rewardError) rewardItemsCount++
        }
      }

      setResult({ success: true, crimesCount, slotsCount, rewardItemsCount, requiredItemsCount })
    } catch (err) {
      setResult({ success: false, error: err.message })
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="card border border-orange-200 dark:border-orange-900/30">
      <h3 className="text-lg font-semibold mb-4">Import Crimes Database</h3>
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
        Upload crimes_database.json to import crime data into the database.
      </p>

      <input
        type="file"
        accept=".json"
        onChange={(e) => setFile(e.target.files[0])}
        className="block w-full text-sm text-gray-500 dark:text-gray-400
          file:mr-4 file:py-2 file:px-4
          file:rounded-lg file:border-0
          file:text-sm file:font-semibold
          file:bg-orange-100 file:text-orange-700
          hover:file:bg-orange-200
          dark:file:bg-orange-900/50 dark:file:text-orange-400
          dark:hover:file:bg-orange-900/70"
      />

      <button
        onClick={handleImport}
        disabled={!file || importing}
        className="mt-4 px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {importing ? 'Importing...' : 'Import Crimes Data'}
      </button>

      {result && (
        <div className={`mt-4 p-4 rounded-lg ${result.success ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800' : 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800'}`}>
          {result.success ? (
            <div className="text-sm text-green-600 dark:text-green-400">
              <p>Imported {result.crimesCount} crimes</p>
              <p>{result.slotsCount} slots</p>
              <p>{result.rewardItemsCount} reward items</p>
              <p>{result.requiredItemsCount} required items</p>
            </div>
          ) : (
            <p className="text-sm text-red-600 dark:text-red-400">
              Error: {result.error}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function PayoutCsvImport() {
  const { user } = useAuth()
  const [file, setFile] = useState(null)
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState(null)

  const handleImport = async () => {
    if (!file) return

    try {
      setImporting(true)
      setResult(null)

      // Parse week dates from filename: 20251215-Forge_OC_Payout.csv
      const dateMatch = file.name.match(/^(\d{8})/)
      if (!dateMatch) {
        throw new Error('Filename must start with YYYYMMDD date (e.g., 20251215-Forge_OC_Payout.csv)')
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
      const lines = text.trim().split('\n')

      if (lines.length < 2) {
        throw new Error('CSV file is empty')
      }

      const headers = lines[0].split(',').map(h => h.trim())
      
      // Find column indexes
      const cols = {
        member: headers.findIndex(h => h.toLowerCase().includes('member')),
        id: headers.findIndex(h => h.toLowerCase() === 'id'),
        timeSpent: headers.findIndex(h => h.toLowerCase().includes('time spent in')),
        timePercent: headers.findIndex(h => h.toLowerCase().includes('time spent %')),
        tier: headers.findIndex(h => h.toLowerCase() === 'tier'),
        tickets: headers.findIndex(h => h.toLowerCase() === 'tickets'),
        penalty: headers.findIndex(h => h.toLowerCase().includes('penalty')),
        share: headers.findIndex(h => h.toLowerCase().includes('share')),
        payout: headers.findIndex(h => h.toLowerCase().includes('payout'))
      }

      const members = []
      let totalPayout = 0
      let totalTime = 0
      let totalTickets = 0

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim()
        if (!line) continue

        const values = line.split(',').map(v => v.trim())
        
        const payoutStr = values[cols.payout]?.replace(/[$,"]/g, '') || '0'
        const payout = parseInt(payoutStr) || 0
        
        const timeSpent = cols.timeSpent !== -1 ? parseInt(values[cols.timeSpent]) || 0 : 0
        const timePercent = cols.timePercent !== -1 ? parseFloat(values[cols.timePercent]?.replace('%', '')) || 0 : 0
        const tier = cols.tier !== -1 ? parseInt(values[cols.tier]) || 6 : 6
        const tickets = cols.tickets !== -1 ? parseInt(values[cols.tickets]) || 0 : 0
        const penalty = cols.penalty !== -1 ? parseFloat(values[cols.penalty]) || 0 : 0
        const share = cols.share !== -1 ? parseFloat(values[cols.share]?.replace('%', '')) || 0 : 0

        members.push({
          member_id: values[cols.id],
          member_name: values[cols.member],
          tier,
          base_tickets: tickets,
          sit_out_penalty: penalty,
          adjusted_tickets: tickets + penalty,
          time_spent: timeSpent,
          time_spent_percent: timePercent,
          share_percent: share,
          payout
        })

        totalPayout += payout
        totalTime += timeSpent
        totalTickets += (tickets + penalty)
      }

      // Save week summary
      const { data: weekData, error: weekError } = await supabase
        .from('oc_payout_weeks')
        .upsert({
          week_start: weekStart.toISOString().split('T')[0],
          week_end: weekEnd.toISOString().split('T')[0],
          week_start_timestamp: Math.floor(weekStart.getTime() / 1000),
          week_end_timestamp: Math.floor(weekEnd.getTime() / 1000),
          member_payout_total: totalPayout,
          total_member_payout: totalPayout,
          member_count: members.length,
          total_time_spent: totalTime,
          average_time_spent: Math.floor(totalTime / members.length),
          total_adjusted_tickets: totalTickets,
          total_time_spent_percent: members.reduce((sum, m) => sum + m.time_spent_percent, 0),
          saved_by: user.name,
          saved_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }, { onConflict: 'week_start,week_end' })
        .select()
        .single()

      if (weekError) throw weekError

      // Save member payouts
      const membersWithWeekId = members.map(m => ({
        ...m,
        week_id: weekData.id,
        week_start: weekStart.toISOString().split('T')[0],
        week_end: weekEnd.toISOString().split('T')[0],
        updated_at: new Date().toISOString()
      }))

      const { error: membersError } = await supabase
        .from('oc_payout_members')
        .upsert(membersWithWeekId, { onConflict: 'week_id,member_id' })

      if (membersError) throw membersError

      setResult({ 
        success: true, 
        weekStart: weekStart.toLocaleDateString(),
        memberCount: members.length,
        totalPayout 
      })
    } catch (err) {
      setResult({ success: false, error: err.message })
    } finally {
      setImporting(false)
      setFile(null)
    }
  }

  return (
    <div className="card border border-green-200 dark:border-green-900/30">
      <h3 className="text-lg font-semibold mb-4">Import Payout CSV</h3>
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
        Upload payout CSV with filename format: YYYYMMDD-Forge_OC_Payout.csv
      </p>

      <input
        type="file"
        accept=".csv"
        onChange={(e) => setFile(e.target.files[0])}
        className="block w-full text-sm text-gray-500 dark:text-gray-400
          file:mr-4 file:py-2 file:px-4
          file:rounded-lg file:border-0
          file:text-sm file:font-semibold
          file:bg-green-100 file:text-green-700
          hover:file:bg-green-200
          dark:file:bg-green-900/50 dark:file:text-green-400
          dark:hover:file:bg-green-900/70"
      />

      {file && (
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
          Selected: {file.name}
        </p>
      )}

      <button
        onClick={handleImport}
        disabled={!file || importing}
        className="mt-4 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {importing ? 'Importing...' : 'Import Payout CSV'}
      </button>

      {result && (
        <div className={`mt-4 p-4 rounded-lg ${result.success ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800' : 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800'}`}>
          {result.success ? (
            <div className="text-sm text-green-600 dark:text-green-400">
              <p>Imported week of {result.weekStart}</p>
              <p>{result.memberCount} members</p>
              <p>${(result.totalPayout / 1e6).toFixed(2)}M total payout</p>
            </div>
          ) : (
            <p className="text-sm text-red-600 dark:text-red-400">
              Error: {result.error}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function ViewTab() {
  const [table, setTable] = useState('members')
  const [data, setData] = useState([])
  const [loading, setLoading] = useState(false)
  const [limit, setLimit] = useState(100)

  const tableOptions = [
    { value: 'members', label: 'Members' },
    { value: 'member_cpr', label: 'Member CPR' },
    { value: 'crimes', label: 'Crimes' },
    { value: 'crime_slots', label: 'Crime Slots' },
    { value: 'crime_reward_items', label: 'Crime Reward Items' },
    { value: 'crime_required_items', label: 'Crime Required Items' },
    { value: 'oc_payout_weeks', label: 'Payout Weeks' },
    { value: 'oc_payout_members', label: 'Payout Members' },
    { value: 'tier_requirements', label: 'Tier Requirements' },
    { value: 'inventory_items', label: 'Inventory Items' },
    { value: 'pricing_batches', label: 'Pricing Batches' }
  ]

  const loadData = async () => {
    setLoading(true)
    try {
      const { data: result, error } = await supabase
        .from(table)
        .select('*')
        .limit(limit)
      
      if (error) throw error
      setData(result || [])
    } catch (err) {
      console.error('Error loading data:', err)
      setData([])
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-4 items-center flex-wrap">
        <select 
          value={table} 
          onChange={(e) => setTable(e.target.value)}
          className="input"
        >
          {tableOptions.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>

        <select 
          value={limit} 
          onChange={(e) => setLimit(parseInt(e.target.value))}
          className="input"
        >
          <option value="50">50 rows</option>
          <option value="100">100 rows</option>
          <option value="500">500 rows</option>
          <option value="1000">1000 rows</option>
        </select>

        <button
          onClick={loadData}
          disabled={loading}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? 'Loading...' : 'Load Data'}
        </button>
      </div>

      {data.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 dark:bg-slate-700">
              <tr>
                {Object.keys(data[0]).map(key => (
                  <th key={key} className="px-3 py-2 text-left font-semibold">
                    {key}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-slate-700">
              {data.map((row, i) => (
                <tr key={i} className="hover:bg-gray-50 dark:hover:bg-slate-700/50">
                  {Object.values(row).map((val, j) => (
                    <td key={j} className="px-3 py-2 max-w-xs truncate">
                      {typeof val === 'object' ? JSON.stringify(val) : String(val ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.length === 0 && !loading && (
        <p className="text-center text-gray-500 py-8">
          Select a table and click Load Data to view records
        </p>
      )}
    </div>
  )
}

function SyncTab() {
  const { user } = useAuth()
  const [syncing, setSyncing] = useState(false)
  const [result, setResult] = useState(null)

  const handleSync = async () => {
    try {
      setSyncing(true)
      setResult(null)

      const apiKey = user.apiKey || import.meta.env.VITE_TORN_API_KEY
      const factionId = import.meta.env.VITE_FACTION_ID || '10739'

      const syncResult = await syncCrimesFromAPI(apiKey, factionId)
      setResult(syncResult)
    } catch (err) {
      setResult({ success: false, error: err.message })
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="card border border-blue-200 dark:border-blue-900/30">
        <h3 className="text-lg font-semibold mb-4">Sync Crimes from Torn API</h3>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Fetch latest crime data directly from Torn API v2 and update the database.
        </p>

        <button
          onClick={handleSync}
          disabled={syncing}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
        >
          {syncing ? (
            <>
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
              Syncing...
            </>
          ) : (
            <>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Sync Crimes Now
            </>
          )}
        </button>

        {result && (
          <div className={`mt-4 p-4 rounded-lg ${result.success ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800' : 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800'}`}>
            {result.success ? (
              <div className="text-sm text-green-600 dark:text-green-400">
                <p>Successfully synced crimes</p>
                <p>{result.crimesUpdated} crimes updated</p>
                <p>{result.slotsUpdated} slots updated</p>
                {result.rewardItemsUpdated > 0 && <p>{result.rewardItemsUpdated} reward items</p>}
                {result.requiredItemsUpdated > 0 && <p>{result.requiredItemsUpdated} required items</p>}
                {result.errors && result.errors.length > 0 && (
                  <p className="mt-1 text-yellow-600">{result.errors.length} warnings</p>
                )}
              </div>
            ) : (
              <p className="text-sm text-red-600 dark:text-red-400">
                Error: {result.error}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function ClearDataTab() {
  const [confirmDialog, setConfirmDialog] = useState(null)
  const [clearing, setClearing] = useState(false)
  const [result, setResult] = useState(null)

  const clearOptions = [
    {
      id: 'crimes',
      label: 'Clear All Crimes',
      description: 'Deletes all data from: crimes, crime_slots, crime_reward_items, crime_required_items',
      tables: ['crime_reward_items', 'crime_required_items', 'crime_slots', 'crimes'],
      color: 'red'
    },
    {
      id: 'members',
      label: 'Clear All Members',
      description: 'Deletes all data from: members, member_cpr',
      tables: ['member_cpr', 'members'],
      color: 'orange'
    },
    {
      id: 'payouts',
      label: 'Clear All Payouts',
      description: 'Deletes all data from: oc_payout_weeks, oc_payout_members',
      tables: ['oc_payout_members', 'oc_payout_weeks'],
      color: 'yellow'
    },
    {
      id: 'inventory',
      label: 'Clear All Inventory',
      description: 'Deletes all data from: inventory_items, pricing_batches, sync_metadata',
      tables: ['pricing_batches', 'inventory_items', 'sync_metadata'],
      color: 'purple'
    }
  ]

  const handleClear = async (option) => {
    setClearing(true)
    setResult(null)

    try {
      const deletedCounts = {}

      for (const table of option.tables) {
        const { count, error } = await supabase
          .from(table)
          .delete()
          .neq('id', -1) // This trick deletes all rows
          .select('*', { count: 'exact', head: true })

        if (error) {
          // Try alternative delete method
          const { error: error2 } = await supabase
            .from(table)
            .delete()
            .gte('id', 0)

          if (error2) {
            // For tables without numeric id, try deleting with a broader condition
            const { error: error3 } = await supabase
              .from(table)
              .delete()
              .not('created_at', 'is', null)

            if (error3) {
              console.error(`Error clearing ${table}:`, error3)
              deletedCounts[table] = 'error'
              continue
            }
          }
        }

        deletedCounts[table] = 'cleared'
      }

      setResult({
        success: true,
        option: option.label,
        tables: deletedCounts
      })
    } catch (err) {
      setResult({
        success: false,
        error: err.message
      })
    } finally {
      setClearing(false)
      setConfirmDialog(null)
    }
  }

  return (
    <div className="space-y-6">
      <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
        <div className="flex items-start gap-3">
          <svg className="w-6 h-6 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <div>
            <h3 className="font-semibold text-red-800 dark:text-red-200">Warning: Destructive Actions</h3>
            <p className="text-sm text-red-700 dark:text-red-300 mt-1">
              The actions below will permanently delete data from the database. This cannot be undone.
              Make sure you have backups before proceeding.
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {clearOptions.map(option => (
          <div 
            key={option.id}
            className={`card border-2 border-${option.color}-200 dark:border-${option.color}-900/50`}
          >
            <h3 className="font-semibold text-lg mb-2">{option.label}</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
              {option.description}
            </p>
            <button
              onClick={() => setConfirmDialog(option)}
              disabled={clearing}
              className={`px-4 py-2 bg-${option.color}-600 text-white rounded-lg hover:bg-${option.color}-700 disabled:opacity-50`}
              style={{
                backgroundColor: option.color === 'red' ? '#dc2626' : 
                                 option.color === 'orange' ? '#ea580c' :
                                 option.color === 'yellow' ? '#ca8a04' : '#9333ea'
              }}
            >
              Clear Data
            </button>
          </div>
        ))}
      </div>

      {result && (
        <div className={`p-4 rounded-lg ${result.success ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800' : 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800'}`}>
          {result.success ? (
            <div className="text-sm text-green-600 dark:text-green-400">
              <p className="font-semibold">{result.option} completed</p>
              <ul className="mt-2 space-y-1">
                {Object.entries(result.tables).map(([table, status]) => (
                  <li key={table}>{table}: {status}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-sm text-red-600 dark:text-red-400">
              Error: {result.error}
            </p>
          )}
        </div>
      )}

      {/* Confirmation Dialog */}
      {confirmDialog && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl max-w-md w-full p-6">
            <div className="flex items-start gap-4">
              <div className="flex-shrink-0 w-12 h-12 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
                <svg className="w-6 h-6 text-red-600 dark:text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </div>
              <div className="flex-1">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                  Confirm: {confirmDialog.label}
                </h3>
                <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
                  Are you sure you want to delete all data from these tables?
                </p>
                <ul className="mt-2 text-sm text-gray-500 dark:text-gray-500 list-disc list-inside">
                  {confirmDialog.tables.map(table => (
                    <li key={table}>{table}</li>
                  ))}
                </ul>
                <p className="mt-3 text-sm font-semibold text-red-600 dark:text-red-400">
                  This action cannot be undone!
                </p>
              </div>
            </div>

            <div className="mt-6 flex gap-3 justify-end">
              <button
                onClick={() => setConfirmDialog(null)}
                disabled={clearing}
                className="px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-700 rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={() => handleClear(confirmDialog)}
                disabled={clearing}
                className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
              >
                {clearing ? 'Clearing...' : 'Yes, Delete All'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}