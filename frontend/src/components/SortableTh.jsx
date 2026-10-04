import { useMemo, useState } from 'react'
import { sortRows, nextDirection } from '../utils/tableSort.js'
import { InfoDot } from './InfoTooltip'

/**
 * A sortable table header, and the hook that drives it (#834, epic #803).
 *
 * ⚠️ **Lifted from `warroom/RollCallResultsTable`**, which already had this
 * shape while three other conventions grew up elsewhere. Converting that file
 * to use this is what proves the lift was faithful.
 */

/**
 * ⚠️ A column that cannot be sorted renders a PLAIN `<th>` with no button and
 * no hover. A header that looks clickable and reorders nothing is worse than
 * one that plainly does not — and "if it makes sense" was the explicit
 * qualifier on the original request.
 */
export default function SortableTh({
  col, sortCol, sortDir, onSort, className = '', label, style, children, info,
}) {
  const key = typeof col === 'string' ? col : col?.key
  const sortable = typeof col === 'string' ? true : col?.sortable !== false
  const active = sortCol === key

  if (!sortable) {
    return <th className={`px-3 py-1.5 font-medium ${className}`} style={style}>{children}</th>
  }

  return (
    <th
      className={`px-3 py-1.5 font-medium ${className}`}
      // ⚠️ Passed through because callers set column widths here. A dropped
      // `style` is invisible — the table just lays out differently.
      style={style}
      // ⚠️ Real `aria-sort`, not just an arrow. A screen reader otherwise gets
      // a button with no indication of what the current order is.
      aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(key)}
        // ⚠️ `label` exists because children are not always text — a header can
        // wrap its name in a tooltip, and "Sort by [object Object]" is the
        // failure a screen reader would get. Falls back to the children when
        // they are a plain string, then to the key.
        aria-label={`Sort by ${label ?? (typeof children === 'string' ? children : key)}`}
        className="inline-flex items-center gap-1 hover:text-gray-700 dark:hover:text-gray-200"
      >
        {children}
        {/* ⚠️ Rendered at opacity 0 rather than omitted, so the header does not
            change width when it becomes the active column and the whole table
            shifts under the cursor mid-click. */}
        <span className={active ? '' : 'opacity-0'} aria-hidden="true">
          {sortDir === 'asc' ? '▲' : '▼'}
        </span>
      </button>
      {/* ⚠️ OUTSIDE the button, as an InfoDot. The header is already an
          enabled control, and wrapping it would force one tap to choose
          between sorting and opening the panel; nesting a button inside a
          button is also invalid markup. */}
      {info && <InfoDot>{info}</InfoDot>}
    </th>
  )
}

/**
 * Sort state plus the sorted rows.
 *
 * `columns` are `{ key, kind?, accessor?, compare?, sortable? }`.
 * `tieBreak` names the column that settles equal rows, always ascending.
 *
 * ⚠️ Sorting is USER state and survives a data refresh. The War Room polls at
 * up to 2 Hz; re-deriving the sort from incoming data would fight whoever is
 * reading it.
 */
export function useTableSort(rows, columns, { initialCol, initialDir = 'asc', tieBreak } = {}) {
  const [sortCol, setSortCol] = useState(initialCol ?? columns?.[0]?.key)
  const [sortDir, setSortDir] = useState(initialDir)

  const onSort = (key) => {
    setSortDir((d) => nextDirection(key, sortCol, d))
    setSortCol(key)
  }

  const sorted = useMemo(
    () => sortRows(rows, columns, sortCol, sortDir, { tieBreak }),
    [rows, columns, sortCol, sortDir, tieBreak],
  )

  return { sorted, sortCol, sortDir, onSort }
}
