/**
 * One comparator for every table in the app (#834, epic #803).
 *
 * ⚠️ **Lifted from `warroom/RollCallResultsTable`, not designed fresh.** That
 * file already had the right shape — a per-column comparator map and a header
 * that renders its own affordance — and three other conventions had grown up
 * around it. This generalises the one that worked.
 *
 * ⚠️ **The affordances were never the real defect.** The audit counted 22
 * tables missing sort controls, but the damage was in the comparators: a column
 * with no explicit coercion fell through to a raw `<` / `>`, so `null` returned
 * 0 and scattered rows to arbitrary positions, `"10" < "9"` sorted lexically,
 * and `parseInt(x) || 0` collapsed a real zero into a missing value. A column
 * declares its KIND here and gets the right comparison once.
 */
import { parseDbTime } from './time.js'

/** Empty for sorting purposes: null, undefined, and the empty string. */
const isBlank = (v) => v === null || v === undefined || v === ''

/**
 * Compare two present values of a given kind. Never sees a blank — the caller
 * handles those, because where they go depends on the sort direction.
 */
export function compareValues(a, b, kind) {
  if (kind === 'number') {
    // ⚠️ `Number`, not `parseInt`: parseInt('1.5') is 1, and parseInt('')
    // is NaN where Number('') is 0. The blank check upstream already removed
    // the empty string, so Number is the honest conversion here.
    const x = Number(a)
    const y = Number(b)
    // A value that is not a number at all sorts with the unknowns rather than
    // as 0, which would place it among real data.
    if (Number.isNaN(x) || Number.isNaN(y)) {
      if (Number.isNaN(x) && Number.isNaN(y)) return 0
      return Number.isNaN(x) ? 1 : -1
    }
    return x - y
  }

  if (kind === 'date') {
    // ⚠️ `parseDbTime`, never `new Date`. Postgres hands us `+00` — a bare
    // two-digit offset that `new Date` rejects outright (#140), and that the
    // repo has a guard test about. An unparseable value is UNKNOWN, not epoch
    // zero: zero would sort it to 1970 and put it first.
    const x = parseDbTime(a)
    const y = parseDbTime(b)
    if (!x || !y) {
      if (!x && !y) return 0
      return x ? -1 : 1
    }
    return x.getTime() - y.getTime()
  }

  if (kind === 'bool') return Number(!!a) - Number(!!b)

  // Text. `sensitivity: 'base'` so case and accents do not split a list.
  return String(a).localeCompare(String(b), undefined, { sensitivity: 'base' })
}

/** The direction a header click should produce. */
export function nextDirection(clicked, currentCol, currentDir) {
  if (clicked !== currentCol) return 'asc'
  return currentDir === 'asc' ? 'desc' : 'asc'
}

const valueOf = (row, col) => (col.accessor ? col.accessor(row) : row?.[col.key])

/**
 * Sort rows by one column.
 *
 * `columns` are `{ key, kind?, accessor?, compare?, sortable? }`. `compare` is
 * a bespoke comparator and wins over `kind` — availability has a semantic order
 * that alphabetical would scramble.
 *
 * `tieBreak` names a column used to settle equal rows, **always ascending**. It
 * takes a key or a LIST of keys applied in order, so a board where many rows
 * genuinely share a value can settle on something meaningful before falling
 * back to a name. The Hall of Fame is the case that wanted it: every member at
 * level 100 shares faction rank 1, and "who is highest placed in Torn" is a far
 * more interesting second question than "whose name starts with A".
 *
 * ⚠️ A tie column that IS the sorted column is skipped, not treated as the
 * end of the list — sorting BY global rank must still fall through to the name.
 *
 * ⚠️ Returns a NEW array. `Array.prototype.sort` mutates, and a React view
 * sorting its own props in place is a bug waiting for a re-render.
 */
export function sortRows(rows, columns, sortCol, sortDir, { tieBreak } = {}) {
  const list = Array.isArray(rows) ? [...rows] : []
  const col = columns?.find((c) => c.key === sortCol)
  if (!col) return list

  const tieKeys = tieBreak == null ? [] : [].concat(tieBreak)
  const ties = tieKeys
    .map((k) => columns?.find((c) => c.key === k))
    .filter((c) => c && c.key !== col.key)
  const dir = sortDir === 'desc' ? -1 : 1

  const one = (a, b, c, d) => {
    const av = valueOf(a, c)
    const bv = valueOf(b, c)

    // ⚠️ **Blanks are resolved BEFORE the direction is applied**, which is what
    // keeps them last in BOTH directions. Reversing a sort should reverse the
    // rows that have data — not haul the empty ones to the top, where they read
    // as "the sort is broken" rather than as "these are empty".
    const aBlank = isBlank(av)
    const bBlank = isBlank(bv)
    if (aBlank || bBlank) {
      if (aBlank && bBlank) return 0
      return aBlank ? 1 : -1
    }

    return d * (c.compare ? c.compare(av, bv) : compareValues(av, bv, c.kind))
  }

  return list.sort((a, b) => {
    const primary = one(a, b, col, dir)
    if (primary !== 0) return primary
    // ⚠️ The tie-break runs in a FIXED direction, never the sort's. Lifted
    // verbatim in spirit from RollCallResultsTable: without it the order within
    // a group depends on whatever order the rows arrived in, so a live table
    // reshuffles under somebody as data comes in.
    for (const t of ties) {
      const settled = one(a, b, t, 1)
      if (settled !== 0) return settled
    }
    return 0
  })
}
