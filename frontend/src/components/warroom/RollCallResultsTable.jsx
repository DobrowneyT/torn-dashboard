import { availabilityLabel, rollCallTally } from '../../utils/rollCall'

// Shared table of roll-call responses (sorted alphabetically by name). Edited
// responses (revised=true) are highlighted. A yes/no tally of who'll be on at
// the start sits above it. Used by the leadership notes panel and the summary
// "responded" modal.
export default function RollCallResultsTable({ rows = [] }) {
  const sorted = [...rows].sort((a, b) =>
    (a.member_name || '').localeCompare(b.member_name || '', undefined, { sensitivity: 'base' }))
  const tally = rollCallTally(rows)

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3 text-xs">
        <span className="text-gray-500 dark:text-gray-400">On at start:</span>
        <span className="inline-flex items-center gap-1 font-medium text-green-600 dark:text-green-400">
          {tally.yes} Yes
        </span>
        <span className="inline-flex items-center gap-1 font-medium text-red-600 dark:text-red-400">
          {tally.no} No
        </span>
        <span className="text-gray-400 dark:text-gray-500">({tally.total} responded)</span>
      </div>
      <div className="rounded-lg border border-gray-200 dark:border-slate-600 overflow-hidden overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-gray-50 dark:bg-slate-700/40 text-left text-gray-500 dark:text-gray-400">
            <th className="px-3 py-1.5 font-medium">Member</th>
            <th className="px-3 py-1.5 font-medium">Start</th>
            <th className="px-3 py-1.5 font-medium">Self-hosp</th>
            <th className="px-3 py-1.5 font-medium">Availability</th>
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr><td colSpan={4} className="px-3 py-2 text-gray-500 dark:text-gray-400">No responses yet.</td></tr>
          ) : sorted.map(r => (
            <tr key={r.member_id} className={`border-t border-gray-100 dark:border-slate-700 ${r.revised ? 'bg-amber-50 dark:bg-amber-900/20' : ''}`}>
              <td className="px-3 py-1.5 text-gray-700 dark:text-gray-300">
                {r.member_name || r.member_id}
                {r.revised && <span className="ml-1.5 text-[10px] px-1 py-0.5 rounded bg-amber-200 dark:bg-amber-800 text-amber-800 dark:text-amber-200">edited</span>}
              </td>
              <td className="px-3 py-1.5">{r.on_at_start ? <span className="text-green-600 dark:text-green-400">Yes</span> : <span className="text-red-600 dark:text-red-400">No</span>}</td>
              <td className="px-3 py-1.5 text-gray-600 dark:text-gray-400">{r.on_at_start ? '—' : (r.can_self_hospital ? 'Yes' : (r.needs_merc ? 'No (merc)' : '—'))}</td>
              <td className="px-3 py-1.5 text-gray-600 dark:text-gray-400">{availabilityLabel(r.availability)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  )
}
