// Helpers for the Global Admin "Key Pool Health" table: classify a row's status
// (including synthetic "missing" members that have no key) and sort the table by
// any column. Null/empty values (a missing member has no level/consent/claim)
// always sort last, regardless of direction, so populated rows stay together.
import { parseDbTime } from './time'

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

export function sortKeyPoolRows(rows, key, dir = 'asc') {
  const accessor = ACCESSORS[key]
  if (!accessor) return [...rows]
  const sign = dir === 'desc' ? -1 : 1
  return [...rows].sort((a, b) => {
    const va = accessor(a)
    const vb = accessor(b)
    const ea = isEmpty(va)
    const eb = isEmpty(vb)
    if (ea && eb) return 0
    if (ea) return 1 // empties last regardless of direction
    if (eb) return -1
    if (va < vb) return -1 * sign
    if (va > vb) return 1 * sign
    return 0
  })
}

export const KEY_POOL_COLUMNS = ['member', 'level', 'consent', 'status', 'last_claimed', 'last_error']
