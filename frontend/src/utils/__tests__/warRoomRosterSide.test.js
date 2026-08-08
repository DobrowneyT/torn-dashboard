// Roster-side toggle decisions (#335).
import { describe, it, expect } from 'vitest'
import {
  THEM, US, DEFAULT_ROSTER_SIDE,
  isRosterSide, selectRosterMembers, rosterColumns, rosterColumnCount,
  isStatsFilterAvailable, otherSide,
} from '../warRoomRosterSide'

const members = [{ member_id: 1, member_name: 'Enemy' }]
const ourMembers = [{ member_id: 2, member_name: 'Ours' }]

describe('selectRosterMembers', () => {
  it('shows the opponent by default and our faction when toggled', () => {
    expect(selectRosterMembers(THEM, { members, ourMembers })).toBe(members)
    expect(selectRosterMembers(US, { members, ourMembers })).toBe(ourMembers)
  })

  it('falls back to the opponent for an unknown side', () => {
    // A stale persisted value or a typo must not blank the war room.
    expect(selectRosterMembers('sideways', { members, ourMembers })).toBe(members)
    expect(selectRosterMembers(undefined, { members, ourMembers })).toBe(members)
  })

  it('returns an empty list rather than throwing when a roster is absent', () => {
    expect(selectRosterMembers(US, {})).toEqual([])
    expect(selectRosterMembers(THEM)).toEqual([])
  })
})

describe('rosterColumns', () => {
  it('hides Dibs and Attack on our own faction', () => {
    // You cannot dib or hit a team-mate; hiding beats greying out.
    expect(rosterColumns(US)).toMatchObject({ dibs: false, action: false })
  })

  it('keeps Dibs and Attack against the opponent', () => {
    expect(rosterColumns(THEM)).toMatchObject({ dibs: true, action: true })
  })

  it('shows Energy and booster cooldown only on our own faction', () => {
    expect(rosterColumns(US)).toMatchObject({ energy: true, boosterCd: true })
    expect(rosterColumns(THEM)).toMatchObject({ energy: false, boosterCd: false })
  })
})

describe('rosterColumnCount', () => {
  it('counts the columns actually rendered for each side', () => {
    // Drives the empty-state colSpan; a wrong number visibly breaks that row.
    expect(rosterColumnCount(THEM)).toBe(8)
    expect(rosterColumnCount(US)).toBe(8)
  })

  it('stays in step with rosterColumns', () => {
    for (const side of [THEM, US]) {
      const optional = Object.values(rosterColumns(side)).filter(Boolean).length
      expect(rosterColumnCount(side)).toBe(6 + optional)
    }
  })
})

describe('isStatsFilterAvailable', () => {
  it('suspends the stats filter on our own faction', () => {
    // Spies are fetched for the enemy only, so bsp_total is null for us —
    // an active min/max would silently empty the table on toggle.
    expect(isStatsFilterAvailable(US)).toBe(false)
    expect(isStatsFilterAvailable(THEM)).toBe(true)
  })
})

describe('side helpers', () => {
  it('defaults to the opponent', () => {
    // Not persisted: better to re-click than to wonder mid-war where the
    // targets went because the toggle was left flipped in a previous session.
    expect(DEFAULT_ROSTER_SIDE).toBe(THEM)
  })

  it('validates a side', () => {
    expect(isRosterSide(THEM)).toBe(true)
    expect(isRosterSide(US)).toBe(true)
    expect(isRosterSide('both')).toBe(false)
    expect(isRosterSide(null)).toBe(false)
  })

  it('toggles between the two sides', () => {
    expect(otherSide(THEM)).toBe(US)
    expect(otherSide(US)).toBe(THEM)
  })
})
