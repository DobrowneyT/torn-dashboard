import { useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { isAdmin } from '../config'
import { supabase } from '../utils/supabase'
import { syncCrimesFromAPI } from '../utils/syncCrimesFromAPI'
import { syncItemsFromAPI } from '../utils/syncItemsFromAPI'
import { syncMembersFromAPI } from '../utils/syncMembersFromAPI'
import { importPayoutCSV } from '../utils/csvPayoutImport'
import * as adminApi from '../utils/adminApi'

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
          <nav className="-mb-px flex flex-wrap gap-x-6 gap-y-0">
            <button
              onClick={() => setActiveTab('import')}
              className={`py-2 px-1 border-b-2 font-medium text-sm ${activeTab === 'import'
                  ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                  : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300'
                }`}
            >
              Import Data
            </button>
            <button
              onClick={() => setActiveTab('view')}
              className={`py-2 px-1 border-b-2 font-medium text-sm ${activeTab === 'view'
                  ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                  : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300'
                }`}
            >
              View Data
            </button>
            <button
              onClick={() => setActiveTab('sync')}
              className={`py-2 px-1 border-b-2 font-medium text-sm ${activeTab === 'sync'
                  ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                  : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300'
                }`}
            >
              API Sync
            </button>
            <button
              onClick={() => setActiveTab('clear')}
              className={`py-2 px-1 border-b-2 font-medium text-sm ${activeTab === 'clear'
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
      <SingleOCPayoutDelete />
      <SingleRWPayoutDelete />
    </div>
  )
}

function CprDataImport() {
  const { user } = useAuth()
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

      const response = await adminApi.importCprData(membersData, user.apiKey)

      if (!response.success) {
        throw new Error(response.error || 'Import failed')
      }

      setResult({ success: true, membersCount: response.membersCount, cprRecordsCount: response.cprRecordsCount })
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
  const { user } = useAuth()
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

      const response = await adminApi.importCrimesData(crimesData, user.apiKey)

      if (!response.success) {
        throw new Error(response.error || 'Import failed')
      }

      setResult({
        success: true,
        crimesCount: response.crimesCount,
        slotsCount: response.slotsCount,
        rewardItemsCount: response.rewardItemsCount,
        requiredItemsCount: response.requiredItemsCount
      })
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

      const importResult = await importPayoutCSV(file, user.apiKey, `${user.name} (Data Management)`)

      setResult({
        success: true,
        weekStart: importResult.weekStart,
        memberCount: importResult.memberCount,
        crimesLinked: importResult.crimesLinked
      })
    } catch (err) {
      setResult({ success: false, error: err.message })
    } finally {
      setImporting(false)
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
              <p>{result.crimesLinked} crimes linked</p>
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
  const [syncingItems, setSyncingItems] = useState(false)
  const [syncingMembers, setSyncingMembers] = useState(false)
  const [result, setResult] = useState(null)
  const [itemsResult, setItemsResult] = useState(null)
  const [membersResult, setMembersResult] = useState(null)

  const handleSyncCrimes = async () => {
    try {
      setSyncing(true)
      setResult(null)

      const apiKey = user?.apiKey

      if (!apiKey) {
        setResult({
          success: false,
          error: 'No API key found. Please log out and log back in.'
        })
        return
      }

      const syncResult = await syncCrimesFromAPI(apiKey, null)
      setResult(syncResult)
    } catch (err) {
      setResult({ success: false, error: err.message })
    } finally {
      setSyncing(false)
    }
  }

  const handleSyncItems = async () => {
    try {
      setSyncingItems(true)
      setItemsResult(null)

      const apiKey = user?.apiKey

      if (!apiKey) {
        setItemsResult({
          success: false,
          error: 'No API key found. Please log out and log back in.',
          itemsCount: 0
        })
        return
      }

      const syncResult = await syncItemsFromAPI(apiKey)
      setItemsResult(syncResult)
    } catch (err) {
      setItemsResult({ success: false, error: err.message, itemsCount: 0 })
    } finally {
      setSyncingItems(false)
    }
  }

  const handleSyncMembers = async () => {
    try {
      setSyncingMembers(true)
      setMembersResult(null)

      const apiKey = user?.apiKey

      if (!apiKey) {
        setMembersResult({
          success: false,
          error: 'No API key found. Please log out and log back in.',
          totalMembers: 0
        })
        return
      }

      const syncResult = await syncMembersFromAPI(apiKey)
      setMembersResult(syncResult)
    } catch (err) {
      setMembersResult({ success: false, error: err.message, totalMembers: 0 })
    } finally {
      setSyncingMembers(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="card border border-green-200 dark:border-green-900/30">
        <h3 className="text-lg font-semibold mb-4">Sync Members from Torn API</h3>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Fetch current faction members and update the database. Sets inactive members to is_current=false.
        </p>

        <button
          onClick={handleSyncMembers}
          disabled={syncingMembers}
          className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 flex items-center gap-2"
        >
          {syncingMembers ? (
            <>
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
              Syncing...
            </>
          ) : (
            <>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Sync Members Now
            </>
          )}
        </button>

        {membersResult && (
          <div className={`mt-4 p-4 rounded-lg ${membersResult.success ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800' : 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800'}`}>
            {membersResult.success ? (
              <div className="text-sm text-green-600 dark:text-green-400">
                <p>Successfully synced members</p>
                <p>{membersResult.totalMembers} current faction members</p>
                <p>{membersResult.membersUpdated} existing members updated</p>
                {membersResult.membersCreated > 0 && <p>{membersResult.membersCreated} new members added</p>}
              </div>
            ) : (
              <p className="text-sm text-red-600 dark:text-red-400">
                Error: {membersResult.error}
              </p>
            )}
          </div>
        )}
      </div>

      <div className="card border border-blue-200 dark:border-blue-900/30">
        <h3 className="text-lg font-semibold mb-4">Sync Crimes from Torn API</h3>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Fetch latest crime data directly from Torn API v2 and update the database.
        </p>

        <button
          onClick={handleSyncCrimes}
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

      <div className="card border border-purple-200 dark:border-purple-900/30">
        <h3 className="text-lg font-semibold mb-4">Sync Items from Torn API</h3>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Fetch all item data from Torn API and update the items database (typically 1500+ items).
        </p>

        <button
          onClick={handleSyncItems}
          disabled={syncingItems}
          className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 flex items-center gap-2"
        >
          {syncingItems ? (
            <>
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
              Syncing...
            </>
          ) : (
            <>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Sync Items Now
            </>
          )}
        </button>

        {itemsResult && (
          <div className={`mt-4 p-4 rounded-lg ${itemsResult.success ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800' : 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800'}`}>
            {itemsResult.success ? (
              <div className="text-sm text-green-600 dark:text-green-400">
                <p>Successfully synced {itemsResult.itemsCount} items</p>
              </div>
            ) : (
              <p className="text-sm text-red-600 dark:text-red-400">
                Error: {itemsResult.error}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function ClearDataTab() {
  const { user } = useAuth()
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
      id: 'single_payout',
      label: 'Delete Single Payout Week',
      description: 'Delete a specific payout week and its member records',
      tables: [],
      color: 'blue',
      requiresSelection: true
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
        try {
          const response = await adminApi.adminClearTable(table, user.apiKey)
          deletedCounts[table] = response.success ? 'cleared' : 'error'
        } catch (err) {
          console.error(`Error clearing ${table}:`, err)
          deletedCounts[table] = 'error'
        }
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
        <div className="modal-overlay">
          <div className="modal-dialog sm:max-w-md">
            <div className="flex-1 overflow-y-auto p-6">
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
        </div>
      )}
    </div>
  )
}

function SingleOCPayoutDelete() {
  const { user } = useAuth()
  const [payouts, setPayouts] = useState([])
  const [loading, setLoading] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [result, setResult] = useState(null)

  const loadPayouts = async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('oc_payout_weeks')
        .select('id, week_start, week_end, member_payout_total, member_count, created_at')
        .order('week_end', { ascending: false })
        .limit(20)

      if (error) throw error
      setPayouts(data || [])
    } catch (err) {
      console.error('Error loading OC payouts:', err)
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async (weekId) => {
    if (!confirm('Are you sure you want to delete this OC payout week? This cannot be undone.')) return

    setDeleting(true)
    setResult(null)
    try {
      // Unlink any crimes referencing this week (FK — must clear before deleting the week)
      await adminApi.adminUpdate('crimes', { payout_week_id: null }, { payout_week_id: weekId }, user.apiKey)
      // Delete member records, then the week itself
      await adminApi.adminDelete('oc_payout_members', { week_id: weekId }, user.apiKey)
      await adminApi.adminDelete('oc_payout_weeks', { id: weekId }, user.apiKey)

      setResult({ success: true, message: 'OC payout week deleted successfully.' })
      loadPayouts()
    } catch (err) {
      setResult({ success: false, error: err.message })
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="card border border-blue-200 dark:border-blue-900/30">
      <h3 className="font-semibold text-lg mb-2">Delete OC Payout</h3>
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
        Select a specific OC payout week to delete. Also unlinks any crimes referencing it.
      </p>

      <button onClick={loadPayouts} disabled={loading}
        className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 mb-4">
        {loading ? 'Loading...' : 'Load OC Payout Weeks'}
      </button>

      {payouts.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b-2 border-gray-200 dark:border-slate-700">
              <tr className="text-left">
                <th className="py-2 px-2 font-semibold text-xs">Week</th>
                <th className="py-2 px-2 font-semibold text-xs">Total Payout</th>
                <th className="py-2 px-2 font-semibold text-xs">Members</th>
                <th className="py-2 px-2 font-semibold text-xs">Action</th>
              </tr>
            </thead>
            <tbody>
              {payouts.map((p) => (
                <tr key={p.id} className="border-b border-gray-200 dark:border-slate-700">
                  <td className="py-2 px-2 text-xs">{p.week_start} → {p.week_end}</td>
                  <td className="py-2 px-2 text-xs font-semibold">
                    ${((p.member_payout_total || 0) / 1e6).toFixed(2)}M
                  </td>
                  <td className="py-2 px-2 text-xs">{p.member_count || 0}</td>
                  <td className="py-2 px-2 text-xs">
                    <button onClick={() => handleDelete(p.id)} disabled={deleting}
                      className="px-2 py-1 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50">
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {result && (
        <div className={`mt-4 p-3 rounded-lg text-sm ${result.success ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 text-green-700 dark:text-green-400' : 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400'}`}>
          {result.success ? result.message : `Error: ${result.error}`}
        </div>
      )}
    </div>
  )
}

function SingleRWPayoutDelete() {
  const { user } = useAuth()
  const [payouts, setPayouts] = useState([])
  const [loading, setLoading] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [result, setResult] = useState(null)

  const loadPayouts = async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('war_payouts')
        .select('id, war_id, war_type, total_reward, total_payout, member_count, created_at, ranked_wars(opponent_name, opponent_id, start_at, end_at)')
        .order('created_at', { ascending: false })
        .limit(20)

      if (error) throw error
      setPayouts(data || [])
    } catch (err) {
      console.error('Error loading RW payouts:', err)
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async (payoutId) => {
    if (!confirm('Are you sure you want to delete this RW payout? This cannot be undone.')) return

    setDeleting(true)
    setResult(null)
    try {
      // Delete member records first (FK constraint), then the payout record
      await adminApi.adminDelete('war_payout_members', { payout_id: payoutId }, user.apiKey)
      await adminApi.adminDelete('war_payouts', { id: payoutId }, user.apiKey)

      setResult({ success: true, message: 'RW payout deleted successfully.' })
      loadPayouts()
    } catch (err) {
      setResult({ success: false, error: err.message })
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="card border border-orange-200 dark:border-orange-900/30">
      <h3 className="font-semibold text-lg mb-2">Delete RW Payout</h3>
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
        Select a specific ranked war payout to delete. Removes all member records for that payout.
      </p>

      <button onClick={loadPayouts} disabled={loading}
        className="px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 disabled:opacity-50 mb-4">
        {loading ? 'Loading...' : 'Load RW Payouts'}
      </button>

      {payouts.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b-2 border-gray-200 dark:border-slate-700">
              <tr className="text-left">
                <th className="py-2 px-2 font-semibold text-xs">War</th>
                <th className="py-2 px-2 font-semibold text-xs">Type</th>
                <th className="py-2 px-2 font-semibold text-xs">Total Payout</th>
                <th className="py-2 px-2 font-semibold text-xs">Members</th>
                <th className="py-2 px-2 font-semibold text-xs">Saved</th>
                <th className="py-2 px-2 font-semibold text-xs">Action</th>
              </tr>
            </thead>
            <tbody>
              {payouts.map((p) => {
                const war = p.ranked_wars
                const opponent = war?.opponent_name || `#${war?.opponent_id || p.war_id}`
                const date = war?.start_at
                  ? new Date(war.start_at * 1000).toLocaleDateString()
                  : `War #${p.war_id}`
                return (
                  <tr key={p.id} className="border-b border-gray-200 dark:border-slate-700">
                    <td className="py-2 px-2 text-xs font-medium">vs {opponent}<br /><span className="text-gray-400">{date}</span></td>
                    <td className="py-2 px-2 text-xs capitalize">{p.war_type || '—'}</td>
                    <td className="py-2 px-2 text-xs font-semibold">
                      ${((p.total_payout || 0) / 1e6).toFixed(2)}M
                    </td>
                    <td className="py-2 px-2 text-xs">{p.member_count || 0}</td>
                    <td className="py-2 px-2 text-xs text-gray-500">
                      {new Date(p.created_at).toLocaleDateString()}
                    </td>
                    <td className="py-2 px-2 text-xs">
                      <button onClick={() => handleDelete(p.id)} disabled={deleting}
                        className="px-2 py-1 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50">
                        Delete
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {result && (
        <div className={`mt-4 p-3 rounded-lg text-sm ${result.success ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 text-green-700 dark:text-green-400' : 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400'}`}>
          {result.success ? result.message : `Error: ${result.error}`}
        </div>
      )}
    </div>
  )
}