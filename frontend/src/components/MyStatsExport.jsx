/**
 * Download your own stat history (#867).
 *
 * Requested by MonChoon, 2026-10-03, prompted by Singularity, who maintains
 * their own workstat-finder script — there is at least one member who would
 * rather work with the raw series than read our table.
 *
 * ⚠️ This hits `/api/export/me/stats.csv`, which takes **no member parameter**.
 * The server scopes the rows to the caller's verified session id. There is
 * deliberately nothing here to pass, because a member id that can be sent is a
 * member id that can be changed.
 *
 * ⚠️ The CSV ends with a completion marker. The status line goes out with the
 * headers, so a stream that dies half way still arrives as a 200 and opens
 * perfectly with most of its rows missing. The marker is the only difference,
 * which is why it is verified here and stripped before saving — exactly as the
 * leadership export does.
 */
import { useState } from 'react'
import { Download, LoaderCircle } from 'lucide-react'
import { apiFetch } from '../utils/apiClient'
import InfoTooltip from './InfoTooltip'

/** TCT (= UTC) day, which is what the export's bounds are expressed in. */
const tctDay = (d) => d.toISOString().slice(0, 10)

export default function MyStatsExport() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [days, setDays] = useState('90')

  async function download() {
    setBusy(true)
    setError(null)
    try {
      const to = new Date()
      const from = new Date(to.getTime() - Number(days) * 86400_000)
      const qs = `?from=${tctDay(from)}&to=${tctDay(to)}`
      // ⚠️ `apiFetch`, not a bare fetch. It exists specifically so the CSV
      // path gets the shared 401-refresh-and-retry without consuming the body
      // — a bare fetch here would drop a member's export on a token that
      // expired mid-session.
      const res = await apiFetch(`/api/export/me/stats.csv${qs}`)
      if (!res.ok) {
        let msg = `Export failed (${res.status})`
        try { msg = (await res.json())?.error || msg } catch { /* not JSON */ }
        throw new Error(msg)
      }
      const text = await res.text()

      // ⚠️ Verify the marker BEFORE handing the file over. A truncated export
      // that saves cleanly is worse than one that fails: it looks complete.
      const lines = text.trim().split('\n')
      if (!lines.at(-1)?.startsWith('#')) {
        throw new Error('The export was cut short — nothing saved. Try a shorter range.')
      }
      const body = lines.slice(0, -1).join('\n') + '\n'

      const url = URL.createObjectURL(new Blob([body], { type: 'text/csv;charset=utf-8' }))
      const a = document.createElement('a')
      a.href = url
      a.download = `my_stats_${tctDay(from)}_${tctDay(to)}.csv`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      setError(e.message || 'Export failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold flex items-center gap-1.5">
            Your stat history
            <InfoTooltip label={<span className="text-xs font-normal text-gray-400">what's in it?</span>}>
              <div>One row per day: your personal stats as Torn reported them, plus your gym contributions.</div>
              {/* ⚠️ Named, not left as mysterious blanks. Gym figures come from
                  a current-only endpoint, so they begin the day you joined this
                  dashboard and can never be backfilled (#866). A blank column
                  otherwise reads as a bug. */}
              <div className="mt-1.5">
                Gym columns start from the day you joined this dashboard — earlier
                rows are genuinely blank, not zero, and cannot be filled in.
              </div>
              <div className="mt-1.5">Only your own rows. Nobody else's are in the file.</div>
            </InfoTooltip>
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Download it as CSV to chart or script against.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={days}
            onChange={(e) => setDays(e.target.value)}
            className="rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-700"
            aria-label="How much history to export"
          >
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="365">Last year</option>
            <option value="1825">Everything</option>
          </select>
          <button
            type="button"
            onClick={download}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Download CSV
          </button>
        </div>
      </div>
      {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
    </div>
  )
}
