import SortableTh, { useTableSort } from '../SortableTh.jsx'
import { availabilityLabel, rollCallTally, compareRollCall } from '../../utils/rollCall'

// Shared table of roll-call responses. Edited responses (revised=true) are
// highlighted. A yes/no tally of who'll be on at the start sits above it. Used
// by the leadership notes panel and the summary "responded" modal.
//
// ⚠️ Sort state lives HERE, not in the callers (#793). Two callers render this
// — the notes panel and RollCallResultsModal — and threading it through both
// would mean one of them quietly not getting it.

// ⚠️ The comparators are UNCHANGED from the SORTERS map this replaces (#834).
// Each one carried a reason that is still true, so each one moved verbatim onto
// its column rather than being re-expressed as a `kind`.
const COLUMNS = [
  {
    key: 'name',
    compare: (a, b) => String(a || '').localeCompare(String(b || ''), undefined, { sensitivity: 'base' }),
    accessor: r => r.member_name,
  },
  {
    // Yes first when ascending: the people turning up are what a lead is counting.
    key: 'start',
    accessor: r => r,
    compare: (a, b) => Number(!!b.on_at_start) - Number(!!a.on_at_start),
  },
  {
    // ⚠️ Self-hosp only means anything for a "no" — the column renders "—" for
    // everybody who IS on at the start, and sorting those into the middle would
    // scatter the rows the column exists to compare.
    key: 'selfHosp',
    accessor: r => r,
    compare: (a, b) => selfHospRank(a) - selfHospRank(b),
  },
  {
    // ⚠️ By availability ORDER, never by label text. Alphabetical gives
    // "1–2 Hours Late, 3–5, 6+, On time, Will not be available" — which buries
    // the people who are turning up in the middle of the list.
    key: 'availability',
    accessor: r => r,
    compare: (a, b) => compareRollCall(a, b, 1),
  },
]

function selfHospRank(r) {
  if (r.on_at_start) return 3            // not applicable
  if (r.can_self_hospital) return 0      // can put themselves in
  if (r.needs_merc) return 1             // needs a merc
  return 2                               // answered neither
}

export default function RollCallResultsTable({ rows = [] }) {
  // ⚠️ `tieBreak: 'name'` preserves the behaviour the old comment spelled out:
  // without it the order within a group depends on whatever order the rows
  // arrived in, so the table reshuffles under a lead as responses come in.
  const { sorted, sortCol, sortDir, onSort } = useTableSort(rows, COLUMNS, {
    initialCol: 'name', tieBreak: 'name',
  })

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
            <SortableTh col="name"         sortCol={sortCol} sortDir={sortDir} onSort={onSort}>Member</SortableTh>
            <SortableTh col="start"        sortCol={sortCol} sortDir={sortDir} onSort={onSort}>Start</SortableTh>
            <SortableTh col="selfHosp"     sortCol={sortCol} sortDir={sortDir} onSort={onSort}>Self-hosp</SortableTh>
            <SortableTh col="availability" sortCol={sortCol} sortDir={sortDir} onSort={onSort}>Availability</SortableTh>
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
