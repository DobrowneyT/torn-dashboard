// Saved RW payout history, in the same table shape as the OC Historical
// Payouts view — a war reads like a pay period, so the two pages should not
// need learning separately.
//
// The OC "Crimes" column has no RW equivalent; the opposing faction sits in its
// place, since "which war was this" is the thing a leader scans the list for.
import { formatCurrencyShort } from '../utils/payoutCalculations'
import { formatWarDateRange } from '../utils/warPayoutCalculations'
import { summariseWarPayoutRow } from '../utils/warPayoutHistory'
import SortableTh, { useTableSort } from './SortableTh.jsx'

/**
 * Saved war payouts. ⚠️ `Actions` is deliberately absent — it is buttons.
 *
 * ⚠️ `savedAt` is already a Date here (the row builder parses it), so the
 * column is `number` over `getTime()` rather than `date`: handing `parseDbTime`
 * a Date is not what it expects.
 */
export const PAYOUT_HISTORY_COLUMNS = [
  { key: 'warId',             kind: 'number', accessor: (r) => r.warId },
  { key: 'totalPayout',       kind: 'number', accessor: (r) => r.totalPayout },
  { key: 'memberCount',       kind: 'number', accessor: (r) => r.memberCount },
  { key: 'opponent',          kind: 'text',   accessor: (r) => r.opponent },
  { key: 'factionCutPercent', kind: 'number', accessor: (r) => r.factionCutPercent },
  { key: 'savedBy',           kind: 'text',   accessor: (r) => r.savedBy },
]

export default function WarPayoutHistory({ payouts, loading, onRefresh, onLoad, onDelete }) {
  if (loading) {
    return (
      <div className="bg-white dark:bg-slate-800 rounded-lg border border-gray-200 dark:border-slate-700 p-4">
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mr-3"></div>
          <p className="text-gray-600 dark:text-gray-400">Loading saved payouts...</p>
        </div>
      </div>
    )
  }

  // ⚠️ Newest war first, which is how this list already read.
  const { sorted: rows, sortCol, sortDir, onSort } =
    useTableSort(payouts.map(summariseWarPayoutRow), PAYOUT_HISTORY_COLUMNS, {
      initialCol: 'warId', initialDir: 'desc', tieBreak: 'warId',
    })

  return (
    <div className="bg-white dark:bg-slate-800 rounded-lg border border-gray-200 dark:border-slate-700 p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Saved RW Payouts</h3>
        <button
          onClick={onRefresh}
          className="px-3 py-1 bg-blue-600 text-white text-sm rounded hover:bg-blue-700"
        >
          Refresh
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="text-center text-gray-500 py-8">No saved payouts yet</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b-2 border-gray-200 dark:border-slate-700">
              <tr className="text-left">
                <SortableTh col={PAYOUT_HISTORY_COLUMNS[0]} className="py-2 px-2 font-semibold text-xs" sortCol={sortCol} sortDir={sortDir} onSort={onSort} label="War">War</SortableTh>
                <SortableTh col={PAYOUT_HISTORY_COLUMNS[1]} className="py-2 px-2 font-semibold text-xs" sortCol={sortCol} sortDir={sortDir} onSort={onSort} label="Total Payout">Total Payout</SortableTh>
                <SortableTh col={PAYOUT_HISTORY_COLUMNS[2]} className="py-2 px-2 font-semibold text-xs" sortCol={sortCol} sortDir={sortDir} onSort={onSort} label="Members">Members</SortableTh>
                <SortableTh col={PAYOUT_HISTORY_COLUMNS[3]} className="py-2 px-2 font-semibold text-xs" sortCol={sortCol} sortDir={sortDir} onSort={onSort} label="Opponent">Opponent</SortableTh>
                <SortableTh col={PAYOUT_HISTORY_COLUMNS[4]} className="py-2 px-2 font-semibold text-xs" sortCol={sortCol} sortDir={sortDir} onSort={onSort} label="Faction Cut">Faction Cut</SortableTh>
                <SortableTh col={PAYOUT_HISTORY_COLUMNS[5]} className="py-2 px-2 font-semibold text-xs" sortCol={sortCol} sortDir={sortDir} onSort={onSort} label="Saved By">Saved By</SortableTh>
                <th className="py-2 px-2 font-semibold text-xs">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className="border-b border-gray-200 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-700/50"
                >
                  <td className="py-2 px-2 text-xs">
                    <button
                      onClick={() => onLoad(row.id)}
                      className="text-blue-600 hover:underline font-medium capitalize"
                    >
                      {row.warType} war #{row.warId}
                    </button>
                    <div className="text-gray-500 dark:text-gray-400">
                      {formatWarDateRange(row.startAt, row.endAt)}
                    </div>
                    {row.notes && (
                      <div className="text-gray-400 dark:text-gray-500 italic truncate max-w-[16rem]">
                        {row.notes}
                      </div>
                    )}
                  </td>
                  <td className="py-2 px-2 text-xs font-semibold text-green-700 dark:text-green-400">
                    {formatCurrencyShort(row.totalPayout)}
                  </td>
                  <td className="py-2 px-2 text-xs">
                    {row.eligibleCount}/{row.memberCount}
                  </td>
                  <td className="py-2 px-2 text-xs">
                    {row.opponent ?? <span className="text-gray-400">—</span>}
                  </td>
                  <td className="py-2 px-2 text-xs">{row.factionCutPercent.toFixed(0)}%</td>
                  <td className="py-2 px-2 text-xs text-gray-500">
                    {row.savedBy ?? '—'}
                    {/* Rendered "Invalid Date" before #140 reached this column. */}
                    <div className="text-gray-400 dark:text-gray-500">
                      {row.savedAt ? row.savedAt.toLocaleDateString() : '—'}
                    </div>
                  </td>
                  <td className="py-2 px-2 text-xs">
                    <div className="flex gap-2">
                      <button
                        onClick={() => onLoad(row.id)}
                        className="px-2 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 text-xs"
                      >
                        Load
                      </button>
                      <button
                        onClick={() => onDelete(row.id)}
                        className="px-2 py-1 bg-red-600 text-white rounded hover:bg-red-700 text-xs"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
