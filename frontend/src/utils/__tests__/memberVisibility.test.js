// Fallen members: Torn preserves the account of a player who has died and
// keeps them on the faction roster forever. They cannot act, so they must not
// be counted in roll call, activity totals or any roster view — but the row is
// never deleted, so history keeps the original snapshot.
import { describe, it, expect } from 'vitest'
import { isActiveMember, withoutFallen } from '../memberVisibility'

describe('isActiveMember', () => {
  it('excludes a fallen member', () => {
    expect(isActiveMember({ status_state: 'Fallen' })).toBe(false)
  })

  it('keeps everyone who can still act, or return to acting', () => {
    // Hospital, travel and jail are all temporary — those members come back
    // and belong on the roster the whole time.
    for (const state of ['Okay', 'Hospital', 'Traveling', 'Abroad', 'Jail', 'Federal']) {
      expect(isActiveMember({ status_state: state }), state).toBe(true)
    }
  })

  it('reads the status off a raw row as well as a flattened one', () => {
    // The hook flattens to status_state, but callers hand it both shapes.
    expect(isActiveMember({ state: { status: { state: 'Fallen' } } })).toBe(false)
    expect(isActiveMember({ state: { status: { state: 'Okay' } } })).toBe(true)
  })

  it('⚠️ keeps a member whose status we simply do not know', () => {
    // Absent status must not read as fallen — that would silently empty the
    // roster on any payload that omits it.
    expect(isActiveMember({})).toBe(true)
    expect(isActiveMember({ status_state: null })).toBe(true)
    expect(isActiveMember(null)).toBe(true)
  })
})

describe('withoutFallen', () => {
  it('drops only the fallen, preserving order', () => {
    const rows = [
      { member_id: 1, status_state: 'Okay' },
      { member_id: 2, status_state: 'Fallen' },
      { member_id: 3, status_state: 'Hospital' },
    ]
    expect(withoutFallen(rows).map(m => m.member_id)).toEqual([1, 3])
  })

  it('handles an empty or missing list', () => {
    expect(withoutFallen([])).toEqual([])
    expect(withoutFallen(undefined)).toEqual([])
  })
})
