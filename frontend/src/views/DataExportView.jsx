import { useState, useEffect, useMemo } from 'react'
import { Download, AlertTriangle, Check } from 'lucide-react'
import { apiGet } from '../utils/apiClient'
import { csvFilename, fetchTableCsv, saveBlob, tctBound } from '../utils/csvExport'

// Raw CSV export (#517). The table list comes from the SERVER, filtered to what
// this caller may take — a client-side copy of the registry would show a member
// the name of every table they cannot have.

/** Default range: the last 7 days, TCT. */
function defaultRange() {
  const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
  return { from: day(-7), to: day(0) }
}

const ROLE_LABEL = {
  admin: 'Admin only',
  leadership: 'Leadership',
  warlead: 'War lead',
}

export default function DataExportView() {
  const [tables, setTables] = useState(null)
  const [table, setTable] = useState('')
  const [range, setRange] = useState(defaultRange)
  const [fromTime, setFromTime] = useState('')
  const [toTime, setToTime] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    apiGet('/api/export/tables')
      .then((res) => {
        setTables(res.tables ?? [])
        setTable((t) => t || res.tables?.[0]?.table || '')
      })
      .catch((e) => setError(e.message))
  }, [])

  const selected = useMemo(
    () => (tables ?? []).find((t) => t.table === table) ?? null,
    [tables, table]
  )

  async function runExport() {
    const from = tctBound(range.from, fromTime)
    const to = tctBound(range.to, toTime)
    if (!from || !to) { setError('Pick a start and an end date.'); return }

    setBusy(true); setError(null); setResult(null)
    try {
      const res = await fetchTableCsv({ table, from, to })
      if (!res.ok) { setError(res.error); return }
      saveBlob(res.blob, csvFilename(table, from, to))
      setResult(res)
    } catch (e) {
      setError(e.message ?? 'Export failed')
    } finally {
      setBusy(false)
    }
  }

  if (tables && tables.length === 0) {
    return (
      <div className="card">
        <h2 className="text-xl font-semibold mb-2">Data Export</h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          No tables are available to export with your current role.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="card">
        <h2 className="text-xl font-semibold mb-1">Data Export</h2>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
          Download raw table data as CSV. All dates and times are <strong>TCT</strong>.
        </p>

        <div className="space-y-5">
          <div>
            <label htmlFor="export-table" className="block text-sm font-medium mb-1">Table</label>
            <select
              id="export-table"
              value={table}
              onChange={(e) => { setTable(e.target.value); setResult(null); setError(null) }}
              className="w-full max-w-md rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm"
            >
              {(tables ?? []).map((t) => (
                <option key={t.table} value={t.table}>
                  {t.label}{t.role === 'admin' ? ' — Admin only' : ''}
                </option>
              ))}
            </select>
            {selected && (
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400 max-w-md">
                {selected.note}
                {' '}
                <span className="whitespace-nowrap">
                  Filtered on <code className="font-mono">{selected.timeCol}</code>.
                </span>
                {ROLE_LABEL[selected.role] ? ` ${ROLE_LABEL[selected.role]}.` : ''}
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-md">
            <RangeField
              label="From (TCT)" date={range.from} time={fromTime}
              onDate={(v) => setRange((r) => ({ ...r, from: v }))} onTime={setFromTime}
            />
            <RangeField
              label="To (TCT)" date={range.to} time={toTime}
              onDate={(v) => setRange((r) => ({ ...r, to: v }))} onTime={setToTime}
            />
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Leave a time blank for midnight. The end of the range is exclusive, so two
            back-to-back exports never repeat a row.
          </p>

          <button
            onClick={runExport}
            disabled={busy || !table}
            className="btn-primary inline-flex items-center gap-2 disabled:opacity-50"
          >
            <Download size={16} />
            {busy ? 'Exporting…' : 'Export CSV'}
          </button>
        </div>

        {error && (
          <p className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</p>
        )}

        {/* ⚠️ A streamed export is already a 200 by the time it can fail, so a
            short file looks perfectly valid. The server's completion marker is
            the only thing that tells them apart — say so plainly when it is
            missing, rather than reporting a successful download. */}
        {result && !result.complete && (
          <p className="mt-4 flex items-start gap-2 text-sm text-amber-700 dark:text-amber-400">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <span>
              The download was <strong>cut short</strong> — the server stopped part way
              through. The file was saved, but it is incomplete. Try a narrower range.
            </span>
          </p>
        )}
        {result?.complete && (
          <p className="mt-4 flex items-center gap-2 text-sm text-green-700 dark:text-green-400">
            <Check size={16} />
            Exported {result.rows.toLocaleString()} rows.
          </p>
        )}
      </div>
    </div>
  )
}

function RangeField({ label, date, time, onDate, onTime }) {
  const cls = 'w-full rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm'
  return (
    <div>
      <label className="block text-sm font-medium mb-1">{label}</label>
      <div className="space-y-2">
        <input type="date" value={date} onChange={(e) => onDate(e.target.value)} className={cls} aria-label={`${label} date`} />
        <input type="time" value={time} onChange={(e) => onTime(e.target.value)} className={cls} aria-label={`${label} time`} />
      </div>
    </div>
  )
}
