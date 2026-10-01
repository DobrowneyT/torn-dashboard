// Helpers for the Global Admin "Key Pool Health" table: classify a row's status
// (including synthetic "missing" members that have no key) and sort the table by
// any column. Null/empty values (a missing member has no level/consent/claim)
// always sort last, regardless of direction, so populated rows stay together.
import { parseDbTime } from './time'
import { sortRows } from './tableSort.js'

export function keyPoolStatus(row) {
  if (row?.missing) return 'missing'
  if (row?.disabled) return 'disabled'
  // #271: enrolled but lacking faction API access (recruit / no faction
  // position) — kept out of the faction pool rotation, shown yellow.
  if (row?.has_faction_access === false) return 'no-faction-access'
  return 'active'
}

const ACCESSORS = {
  member: (r) => (r.member_name || r.member_id || '').toString().toLowerCase(),
  level: (r) => (r.key_level ?? null),
  consent: (r) => (r.consent_version || '').toLowerCase(),
  status: (r) => keyPoolStatus(r),
  last_claimed: (r) => (parseDbTime(r.last_claimed_at)?.getTime() ?? null),
  last_error: (r) => (r.last_error || '').toLowerCase(),
}

const isEmpty = (v) => v === null || v === undefined || v === ''

/**
 * Sort the key-pool table by one column.
 *
 * ⚠️ **Delegates to the shared comparator (#838).** Kept as a named export with
 * its own tests unchanged, because those tests prove `sortRows` reproduces this
 * table's behaviour — empties last regardless of direction, which is what keeps
 * populated rows together when somebody flips a column.
 *
 * ⚠️ `last_claimed` is pre-resolved to epoch ms by its accessor, so the column
 * is `number` rather than `date`: the parsing already happened, and declaring
 * it a date would hand `parseDbTime` a number it rejects.
 */
export function sortKeyPoolRows(rows, key, dir = 'asc') {
  return sortRows(rows, KEY_POOL_SORT_COLUMNS, key, dir)
}

const KEY_POOL_SORT_COLUMNS = Object.entries(ACCESSORS).map(([key, accessor]) => ({
  key,
  kind: key === 'level' || key === 'last_claimed' ? 'number' : 'text',
  accessor,
}))

export const KEY_POOL_COLUMNS = ['member', 'level', 'consent', 'status', 'last_claimed', 'last_error']
