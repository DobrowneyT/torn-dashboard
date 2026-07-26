import { describe, it, expect } from 'vitest'
import { keyPoolStatus, sortKeyPoolRows } from '../keyPoolTable.js'

const rows = [
  { member_id: '2', member_name: 'Bea', key_level: 5, consent_version: 'login-v1', disabled: false, last_claimed_at: '2026-07-20T10:00:00Z', last_error: null, missing: false },
  { member_id: '1', member_name: 'Ace', key_level: 3, consent_version: 'login-v1', disabled: true, last_claimed_at: '2026-07-25T10:00:00Z', last_error: 'boom', missing: false },
  { member_id: '3', member_name: 'Cal', key_level: null, consent_version: null, disabled: false, last_claimed_at: null, last_error: null, missing: true },
]

describe('keyPoolStatus', () => {
  it('classifies missing, disabled, and active rows', () => {
    expect(keyPoolStatus(rows[2])).toBe('missing')
    expect(keyPoolStatus(rows[1])).toBe('disabled')
    expect(keyPoolStatus(rows[0])).toBe('active')
  })
})

describe('sortKeyPoolRows', () => {
  it('sorts by member name ascending / descending', () => {
    expect(sortKeyPoolRows(rows, 'member', 'asc').map((r) => r.member_name)).toEqual(['Ace', 'Bea', 'Cal'])
    expect(sortKeyPoolRows(rows, 'member', 'desc').map((r) => r.member_name)).toEqual(['Cal', 'Bea', 'Ace'])
  })

  it('sorts numerically by level, with the null (missing) level last regardless of direction', () => {
    expect(sortKeyPoolRows(rows, 'level', 'asc').map((r) => r.member_name)).toEqual(['Ace', 'Bea', 'Cal'])
    // desc: 5,3 then the null-level missing row still trails.
    expect(sortKeyPoolRows(rows, 'level', 'desc').map((r) => r.member_name)).toEqual(['Bea', 'Ace', 'Cal'])
  })

  it('sorts by status', () => {
    expect(sortKeyPoolRows(rows, 'status', 'asc').map((r) => keyPoolStatus(r)))
      .toEqual(['active', 'disabled', 'missing'])
  })

  it('sorts by last claimed date, nulls last', () => {
    expect(sortKeyPoolRows(rows, 'last_claimed', 'asc').map((r) => r.member_name)).toEqual(['Bea', 'Ace', 'Cal'])
  })

  it('does not mutate the input array', () => {
    const before = rows.map((r) => r.member_id)
    sortKeyPoolRows(rows, 'member', 'desc')
    expect(rows.map((r) => r.member_id)).toEqual(before)
  })
})
