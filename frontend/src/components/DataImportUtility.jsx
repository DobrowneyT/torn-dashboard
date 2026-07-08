import { useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { importCprData, importCrimesData as importCrimesDataApi } from '../utils/adminApi'

export default function DataImportUtility() {
  const { user } = useAuth()
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState({ current: 0, total: 0, type: '' })
  const [results, setResults] = useState(null)
  const [error, setError] = useState(null)

  // Both import paths now hand the full JSON payload to the admin-db Edge
  // Function (import_cpr / import_crimes actions), which bulk-upserts in
  // ~2 / ~4 queries respectively instead of the previous per-member loop.
  // Progress is no longer per-record (it's a single server-side call), so
  // the UI shows an indeterminate spinner instead of a count.

  async function importCPRData(file) {
    try {
      setImporting(true)
      setError(null)
      setProgress({ current: 0, total: 0, type: 'CPR' })

      const text = await file.text()
      const data = JSON.parse(text)

      if (!data.members) {
        throw new Error('Invalid CPR data format - missing members object')
      }

      const result = await importCprData(data.members, user.apiKey)

      setResults({
        type: 'CPR',
        membersInserted: result.membersCount ?? 0,
        cprRecordsInserted: result.cprRecordsCount ?? 0,
      })
    } catch (err) {
      console.error('Error importing CPR data:', err)
      setError(err.message)
    } finally {
      setImporting(false)
    }
  }

  async function importCrimesData(file) {
    try {
      setImporting(true)
      setError(null)
      setProgress({ current: 0, total: 0, type: 'Crimes' })

      const text = await file.text()
      const data = JSON.parse(text)

      if (!data.crimes) {
        throw new Error('Invalid crimes data format - missing crimes object')
      }

      const result = await importCrimesDataApi(data.crimes, user.apiKey)

      setResults({
        type: 'Crimes',
        crimesInserted: result.crimesCount ?? 0,
        slotsInserted:  result.slotsCount  ?? 0,
      })
    } catch (err) {
      console.error('Error importing crimes data:', err)
      setError(err.message)
    } finally {
      setImporting(false)
    }
  }

  function handleFileSelect(event, type) {
    const file = event.target.files[0]
    if (!file) return

    if (type === 'cpr') {
      importCPRData(file)
    } else if (type === 'crimes') {
      importCrimesData(file)
    }

    event.target.value = ''
  }

  return (
    <div className="space-y-6">
      <div className="card">
        <h2 className="text-xl font-semibold mb-4">Database Import Utility</h2>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
          Import your existing JSON data files into Supabase. This is a one-time migration.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="border border-gray-200 dark:border-slate-700 rounded-lg p-6">
            <h3 className="font-semibold mb-2">CPR Database</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
              Import cpr_database.json
            </p>
            <label className="btn-primary cursor-pointer inline-block">
              {importing && progress.type === 'CPR' ? 'Importing...' : 'Select CPR File'}
              <input
                type="file"
                accept=".json"
                onChange={(e) => handleFileSelect(e, 'cpr')}
                className="hidden"
                disabled={importing}
              />
            </label>
          </div>

          <div className="border border-gray-200 dark:border-slate-700 rounded-lg p-6">
            <h3 className="font-semibold mb-2">Crimes Database</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
              Import crimes_database.json
            </p>
            <label className="btn-primary cursor-pointer inline-block">
              {importing && progress.type === 'Crimes' ? 'Importing...' : 'Select Crimes File'}
              <input
                type="file"
                accept=".json"
                onChange={(e) => handleFileSelect(e, 'crimes')}
                className="hidden"
                disabled={importing}
              />
            </label>
          </div>
        </div>

        {importing && (
          <div className="mt-6 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
            <div className="flex items-center gap-3 mb-2">
              <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600"></div>
              <p className="text-sm font-semibold text-blue-900 dark:text-blue-100">
                Importing {progress.type} Data...
              </p>
            </div>
            <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
              <div 
                className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                style={{ width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%` }}
              ></div>
            </div>
            <p className="text-xs text-gray-600 dark:text-gray-400 mt-2">
              {progress.current} / {progress.total} records
            </p>
          </div>
        )}

        {results && (
          <div className="mt-6 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4">
            <h4 className="font-semibold text-green-900 dark:text-green-100 mb-2">
              Import Successful!
            </h4>
            <div className="text-sm text-green-800 dark:text-green-200">
              {results.type === 'CPR' && (
                <>
                  <p>Members imported: {results.membersInserted}</p>
                  <p>CPR records imported: {results.cprRecordsInserted}</p>
                </>
              )}
              {results.type === 'Crimes' && (
                <>
                  <p>Crimes imported: {results.crimesInserted}</p>
                  <p>Crime slots imported: {results.slotsInserted}</p>
                </>
              )}
            </div>
          </div>
        )}

        {error && (
          <div className="mt-6 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
            <h4 className="font-semibold text-red-900 dark:text-red-100 mb-2">
              Import Failed
            </h4>
            <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
          </div>
        )}
      </div>

      <div className="card bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800">
        <h3 className="font-semibold text-yellow-900 dark:text-yellow-100 mb-2">
          Important Notes
        </h3>
        <ul className="text-sm text-yellow-800 dark:text-yellow-200 space-y-1 list-disc list-inside">
          <li>This is a one-time migration from JSON files to Supabase</li>
          <li>Importing will UPSERT data (update existing, insert new)</li>
          <li>Crime slots are replaced completely for each crime</li>
          <li>After migration, the system will use Supabase as the source of truth</li>
          <li>You can import multiple times if needed (updates existing records)</li>
          <li>Large files may take several minutes to import</li>
        </ul>
      </div>
    </div>
  )
}