// #480: pre-war stacks snapshot, cross-referenced against roll call — a
// collapsible section inside the war detail modal (WarHistoryView), lazily
// fetched only when opened. Lead-only, matching the memberstats data it
// comes from.
import { useState } from 'react'
import { ChevronRight, Download } from 'lucide-react'
import { apiGet } from '../../utils/apiClient'
import InfoTooltip from '../InfoTooltip'

function toCsv(rows) {
  const header = ['Member', 'Energy', 'Max Energy', 'Reading', 'OD before war', 'Said online', 'Availability', 'Revised']
  const lines = [header.join(',')]
  for (const r of rows) {
    const cells = [
      r.member_name ?? `#${r.member_id}`,
      r.has_reading ? r.energy_current : '',
      r.has_reading ? r.energy_maximum : '',
      r.has_reading ? 'yes' : 'unknown',
      r.od_flagged_prewar ? 'yes' : 'no',
      r.on_at_start == null ? 'no response' : (r.on_at_start ? 'yes' : 'no'),
      r.availability ?? '',
      r.revised ? 'yes' : 'no',
    ]
    lines.push(cells.map(c => `"${String(c).replace(/"/g, '""')}"`).join(','))
  }
  return lines.join('\r\n')
}

function downloadCsv(rows, warLabel) {
  const csv = toCsv(rows)
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `stacks-snapshot-${warLabel}.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export default function StacksSnapshotSection({ warId, warLabel }) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  async function toggle() {
    const next = !open
    setOpen(next)
    if (next && rows === null) {
      setLoading(true)
      setError(null)
      try {
        const data = await apiGet(`/api/wars/${warId}/stacks-snapshot`)
        setRows(data.snapshot || [])
      } catch (err) {
        setError(err.message || 'Failed to load stacks snapshot')
      } finally {
        setLoading(false)
      }
    }
  }

  return (
    <div className="mt-3 border-t border-gray-200 dark:border-slate-700 pt-3">
      <button
        onClick={toggle}
        className="w-full flex items-center justify-between text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white"
      >
        <span className="flex items-center gap-1">
          <ChevronRight className={`w-4 h-4 transition-transform ${open ? 'rotate-90' : ''}`} />
          Pre-war stacks & roll call
        </span>
        {open && rows && rows.length > 0 && (
          <button
            onClick={(e) => { e.stopPropagation(); downloadCsv(rows, warLabel) }}
            className="flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline"
          >
            <Download className="w-3.5 h-3.5" /> CSV
          </button>
        )}
      </button>

      {open && (
        <div className="mt-2">
          {loading && <p className="text-xs text-gray-400">Loading…</p>}
          {error && <p className="text-xs text-red-500">{error}</p>}
          {!loading && !error && rows && rows.length === 0 && (
            <p className="text-xs text-gray-400">
              No stacks snapshot for this war — either it started before this feature
              existed, or the War Room wasn't auto-managing it.
            </p>
          )}
          {!loading && !error && rows && rows.length > 0 && (
            <div className="overflow-x-auto max-h-64 overflow-y-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-gray-500 dark:text-gray-400">
                    <th className="py-1 pr-2">Member</th>
                    <th className="py-1 pr-2 text-right">Energy</th>
                    <th className="py-1 pr-2">OD before war</th>
                    <th className="py-1 pr-2">Said online</th>
                    <th className="py-1 pr-2">Availability</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.member_id} className="border-t border-gray-100 dark:border-slate-700/50">
                      <td className="py-1 pr-2 font-medium">{r.member_name ?? `#${r.member_id}`}</td>
                      <td className="py-1 pr-2 text-right tabular-nums">
                        {r.has_reading ? `${r.energy_current}/${r.energy_maximum}` : (
                          <InfoTooltip label="unknown" className="text-gray-400">
                            No pooled key gave a reading.
                          </InfoTooltip>
                        )}
                      </td>
                      <td className="py-1 pr-2">
                        {r.od_flagged_prewar ? (
                          <span className="text-red-500 font-medium">yes</span>
                        ) : 'no'}
                      </td>
                      <td className="py-1 pr-2">
                        {r.on_at_start == null ? (
                          <span className="text-gray-400">no response</span>
                        ) : r.on_at_start ? 'yes' : 'no'}
                      </td>
                      <td className="py-1 pr-2 text-gray-600 dark:text-gray-400">{r.availability || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
