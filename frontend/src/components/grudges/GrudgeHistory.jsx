// Book of Grudges history (#889, slice 7).
//
// ⚠️ The audit trail has been recorded since slice 1 and visible nowhere. This
// is the answer to "I would want to keep a history of edits on that table
// though to see when targets were added, removed, or changed" — a record
// nobody can read is not a record.
import { useEffect, useState } from 'react'
import { History, LoaderCircle } from 'lucide-react'
import { apiGet } from '../../utils/apiClient'

/** Plain words for an audit row. The raw action/field pair is not readable. */
function describe(h) {
  const who = h.actor_name || (h.actor_member_id === 'system' ? 'The lookup' : h.actor_member_id)
  if (h.action === 'added' && h.field === 'reason') return `${who} added a grudge`
  if (h.action === 'added') return `${who} added this target`
  if (h.action === 'restored') return `${who} put this target back on the list`
  if (h.action === 'removed' && h.field === 'target') return `${who} removed this target`
  if (h.action === 'removed') return `${who} removed a grudge`
  if (h.action === 'approved') return `${who} approved this target`
  if (h.action === 'rejected') return `${who} rejected this target`
  if (h.action === 'state_changed') return `${who} moved this target to ${h.new_value}`
  if (h.action === 'edited' && h.field === 'target_name') return `${who} saw a name change`
  if (h.action === 'edited' && h.field === 'faction_id') return `${who} saw a faction change`
  if (h.action === 'edited' && h.field === 'severity_id') return `${who} changed the severity`
  if (h.action === 'edited') return `${who} edited the reason`
  return `${who} ${h.action}`
}

const show = (v) => (v === null || v === undefined || v === '' ? '—' : String(v))

export default function GrudgeHistory({ targetId = null }) {
  const [history, setHistory] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let on = true
    const path = targetId
      ? `/api/grudges/audit?target_id=${encodeURIComponent(targetId)}`
      : '/api/grudges/audit'
    apiGet(path)
      .then((r) => { if (on) setHistory(r?.history ?? []) })
      .catch((e) => { if (on) setError(e?.message || 'Could not load the history') })
    return () => { on = false }
  }, [targetId])

  if (error) return <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
  if (!history) {
    return (
      <p className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
        <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> Reading the history…
      </p>
    )
  }
  if (history.length === 0) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">Nothing has happened yet.</p>
  }

  return (
    <div className="space-y-3">
      <h3 className="flex items-center gap-2 font-semibold text-gray-900 dark:text-gray-100">
        <History className="h-4 w-4" aria-hidden="true" /> History
      </h3>
      <ul className="space-y-1 text-sm">
        {history.map((h) => (
          <li key={h.id} className="flex flex-wrap items-baseline gap-x-2 border-b border-gray-100 py-1 dark:border-slate-700">
            <span className="font-mono text-xs text-gray-500 dark:text-gray-400">
              {/* at_ms is epoch MILLISECONDS from SQL's extract(epoch ...) * 1000
                  — db-time-safe */}
              {new Date(h.at_ms).toLocaleString()}
            </span>
            <span className="text-gray-800 dark:text-gray-200">{describe(h)}</span>
            {!targetId && (
              <a href={`https://www.torn.com/profiles.php?XID=${h.target_id}`}
                 target="_blank" rel="noopener noreferrer"
                 className="text-blue-600 hover:underline dark:text-blue-400">#{h.target_id}</a>
            )}
            {/* ⚠️ Shows the OLD value as well as the new one. "Somebody edited
                the reason" without saying what it was is the half of the record
                that has no value. */}
            {(h.old_value || h.new_value) && (
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {show(h.old_value)} → {show(h.new_value)}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
