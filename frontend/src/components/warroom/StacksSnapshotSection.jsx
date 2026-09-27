// #480: pre-war stacks snapshot, cross-referenced against roll call — a
// collapsible section inside the war detail modal (WarHistoryView), lazily
// fetched only when opened. Lead-only, matching the memberstats data it
// comes from.
//
// ⚠️ Reshaped 2026-09-27 around the question it is actually for: a post-war
// post-mortem. Who SAID they would be there, who was READY, who SHOWED UP —
// and, explicitly, who said they could not make it and turned up anyway. The
// column set and the CSV both come from SNAPSHOT_COLUMNS so the sheet you
// download cannot disagree with the sheet you are looking at; that drift is
// why the CSV had eight columns and the table five.
import { useState, useMemo } from 'react'
import { ChevronRight, Download } from 'lucide-react'
import { apiGet } from '../../utils/apiClient'
import InfoTooltip from '../InfoTooltip'
import { rollCallLabel, rollCallTitle, formatTct } from '../../utils/rollCall'
import {
  SNAPSHOT_COLUMNS, sortSnapshot, idleSeconds, formatIdle, outcome,
  ACTIVE_WINDOW_SEC, OUTCOME_LEGEND,
} from '../../utils/stacksSnapshot'

/** One row's value for one column, as text. The CSV and the table share it. */
function cellText(row, key) {
  switch (key) {
    case 'member':   return row.member_name ?? `#${row.member_id}`
    case 'rollCall': return rollCallLabel(row)
    case 'energy':   return row.has_reading ? String(row.energy_current) : 'unknown'
    case 'od':       return row.od_flagged_prewar ? 'yes' : 'no'
    // ⚠️ "not recorded", never blank. A blank cell in a spreadsheet reads as
    // zero, which here would claim the member was active at that instant.
    case 'activity': return formatIdle(idleSeconds(row)) ?? 'not recorded'
    case 'outcome':  return outcome(row).label
    case 'revised':  return row.revised ? 'yes' : 'no'
    default:         return ''
  }
}

function toCsv(rows) {
  const lines = [SNAPSHOT_COLUMNS.map(c => c.label).join(',')]
  for (const r of rows) {
    lines.push(SNAPSHOT_COLUMNS
      .map(c => `"${String(cellText(r, c.key)).replace(/"/g, '""')}"`)
      .join(','))
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

const OUTCOME_TONE = {
  kept:    'text-green-600 dark:text-green-400',
  missed:  'text-red-500',
  bonus:   'text-blue-600 dark:text-blue-400',
  as_said: 'text-gray-500 dark:text-gray-400',
  unknown: 'text-gray-400',
}

export default function StacksSnapshotSection({ warId, warLabel }) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [sortKey, setSortKey] = useState('member')
  const [sortDir, setSortDir] = useState(1)

  const sorted = useMemo(() => sortSnapshot(rows ?? [], sortKey, sortDir), [rows, sortKey, sortDir])

  // When the readings were taken. The capture window is the last 60s before
  // the war starts, so this doubles as "at war start" for a reader.
  const capturedAt = rows?.[0]?.captured_at ?? null
  const capturedSec = capturedAt ? Math.floor(Date.parse(capturedAt) / 1000) : null
  const capturedTct = Number.isFinite(capturedSec) ? formatTct(capturedSec) : null
  const anyActivity = (rows ?? []).some(r => r.last_action_epoch)

  function onSort(key) {
    if (key === sortKey) setSortDir(d => -d)
    else { setSortKey(key); setSortDir(1) }
  }

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

  const headerTip = {
    energy: 'Energy at capture. Every member’s maximum is the same, so it is not shown.',
    od: 'Overdosed at any point since this war was matched, not ever. ' +
        'A member who OD’d weeks ago and not since is not flagged.',
    activity: capturedTct
      ? `How long since their last action when the snapshot was taken, at ${capturedTct} TCT — within a minute of the war starting.`
      : 'How long since their last action when the snapshot was taken, within a minute of the war starting.',
    outcome: null,   // listed value-by-value below — see the Outcome branch
    revised: 'They changed their roll call answer after first submitting it.',
  }

  return (
    <div className="mt-3 border-t border-gray-200 dark:border-slate-700 pt-3">
      <button
        onClick={toggle}
        className="w-full flex items-center justify-between text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white"
      >
        <span className="flex items-center gap-1">
          <ChevronRight className={`w-4 h-4 transition-transform ${open ? 'rotate-90' : ''}`} />
          Pre-war stacks &amp; roll call
        </span>
        {open && rows && rows.length > 0 && (
          <button
            onClick={(e) => { e.stopPropagation(); downloadCsv(sorted, warLabel) }}
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
              existed, or the War Room wasn&apos;t auto-managing it.
            </p>
          )}
          {!loading && !error && rows && rows.length > 0 && (
            <>
              {/* ⚠️ Said once, at the top, rather than repeated down a column of
                  dashes: activity was added after this war's snapshot was taken,
                  and war_room_state_v2 is overwritten every sweep, so there is
                  nothing to backfill from. Silence here would read as "nobody
                  was online". */}
              {!anyActivity && (
                <p className="text-xs text-amber-600 dark:text-amber-400 mb-2">
                  Activity wasn&apos;t recorded for this war — the snapshot predates it.
                  Wars from here on will have it.
                </p>
              )}
              <div className="overflow-x-auto max-h-64 overflow-y-auto">
                <table className="min-w-full text-xs whitespace-nowrap">
                  <thead>
                    <tr className="text-left text-gray-500 dark:text-gray-400">
                      {SNAPSHOT_COLUMNS.map(col => (
                        <th
                          key={col.key}
                          className={`py-1 pr-3 sticky top-0 z-10 bg-white dark:bg-slate-800 font-medium ${col.align === 'right' ? 'text-right' : ''}`}
                        >
                          <button
                            type="button"
                            onClick={() => onSort(col.key)}
                            aria-label={`Sort by ${col.label}`}
                            className="inline-flex items-center gap-1 hover:text-gray-700 dark:hover:text-gray-200"
                          >
                            {col.key === 'outcome' ? (
                              <InfoTooltip label={col.label} decoration="no-underline">
                                {/* ⚠️ Every value spelled out. "Turned up" vs
                                    "As stated" is not guessable from the label,
                                    and it is the distinction the sheet exists
                                    to surface. */}
                                <span className="block mb-1">
                                  Roll call answer vs whether they were actually active within{' '}
                                  {Math.round(ACTIVE_WINDOW_SEC / 60)} minutes of the snapshot.
                                </span>
                                {OUTCOME_LEGEND.map(([label, meaning]) => (
                                  <span key={label} className="block">
                                    <strong>{label}</strong> — {meaning}
                                  </span>
                                ))}
                              </InfoTooltip>
                            ) : headerTip[col.key] ? (
                              <InfoTooltip label={col.label} decoration="no-underline">
                                {headerTip[col.key]}
                              </InfoTooltip>
                            ) : col.label}
                            <span className={sortKey === col.key ? '' : 'opacity-0'} aria-hidden="true">
                              {sortDir === 1 ? '▲' : '▼'}
                            </span>
                          </button>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((r) => {
                      const idle = idleSeconds(r)
                      const out = outcome(r)
                      return (
                        <tr key={r.member_id} className="border-t border-gray-100 dark:border-slate-700/50">
                          <td className="py-1 pr-3 font-medium">{r.member_name ?? `#${r.member_id}`}</td>
                          <td className="py-1 pr-3 text-gray-600 dark:text-gray-400" title={rollCallTitle(r)}>
                            {rollCallLabel(r)}
                          </td>
                          <td className="py-1 pr-3 text-right tabular-nums">
                            {r.has_reading ? r.energy_current : (
                              <InfoTooltip label="unknown" className="text-gray-400">
                                No pooled key gave a reading.
                              </InfoTooltip>
                            )}
                          </td>
                          <td className="py-1 pr-3">
                            {r.od_flagged_prewar
                              ? <span className="text-red-500 font-medium">yes</span>
                              : <span className="text-gray-500 dark:text-gray-400">no</span>}
                          </td>
                          <td className="py-1 pr-3 text-right tabular-nums">
                            {idle == null
                              ? <span className="text-gray-400">—</span>
                              : (
                                <span
                                  className={idle <= ACTIVE_WINDOW_SEC ? 'text-green-600 dark:text-green-400' : 'text-gray-600 dark:text-gray-400'}
                                  title={`Last action ${formatTct(r.last_action_epoch)} TCT`}
                                >
                                  {formatIdle(idle)}
                                </span>
                              )}
                          </td>
                          <td className={`py-1 pr-3 ${OUTCOME_TONE[out.key]}`}>{out.label}</td>
                          <td className="py-1 pr-3 text-gray-500 dark:text-gray-400">{r.revised ? 'yes' : ''}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
