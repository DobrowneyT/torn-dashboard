// Roster-side toggle decisions (#335).
import { describe, it, expect } from 'vitest'
import {
  THEM, US, DEFAULT_ROSTER_SIDE,
  isRosterSide, selectRosterMembers, rosterColumns, rosterColumnCount,
  isStatsFilterAvailable, otherSide, canViewOurRoster, effectiveRosterSide, pollingState,
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

  it('shows Energy and all three cooldowns only on our own faction', () => {
    expect(rosterColumns(US)).toMatchObject({
      energy: true, drugCd: true, medicalCd: true, boosterCd: true,
    })
    expect(rosterColumns(THEM)).toMatchObject({
      energy: false, drugCd: false, medicalCd: false, boosterCd: false,
    })
  })
})

describe('rosterColumnCount', () => {
  it('counts the columns actually rendered for each side', () => {
    // Drives the empty-state colSpan; a wrong number visibly breaks that row.
    expect(rosterColumnCount(THEM)).toBe(8)
    expect(rosterColumnCount(US)).toBe(10)
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

describe('canViewOurRoster', () => {
  it('admits war leads, leadership and admins', () => {
    expect(canViewOurRoster({ isWarLead: true })).toBe(true)
    expect(canViewOurRoster({ isLeadership: true })).toBe(true)
    expect(canViewOurRoster({ isAdmin: true })).toBe(true)
  })

  it('excludes an ordinary member', () => {
    // Live energy and drug cooldowns say when a teammate is playing and
    // whether they are mid-overdose — lead data, not roster-wide data.
    expect(canViewOurRoster({})).toBe(false)
    expect(canViewOurRoster()).toBe(false)
  })

  it('excludes a visitor even when they also carry a lead role', () => {
    // Visitors are read-only outsiders; the role combination is possible and
    // must fail closed.
    expect(canViewOurRoster({ isWarLead: true, isVisitor: true })).toBe(false)
    expect(canViewOurRoster({ isLeadership: true, isVisitor: true })).toBe(false)
  })
})

describe('effectiveRosterSide', () => {
  const lead = { isWarLead: true }

  it('honours the chosen side for a permitted viewer', () => {
    expect(effectiveRosterSide(US, lead)).toBe(US)
    expect(effectiveRosterSide(THEM, lead)).toBe(THEM)
  })

  it('drops back to the enemy when the viewer may not see our roster', () => {
    // Roles are re-read on session refresh, so a lead can lose the role with
    // the board open — the table must not strand them on our roster.
    expect(effectiveRosterSide(US, {})).toBe(THEM)
    expect(effectiveRosterSide(US, { isWarLead: true, isVisitor: true })).toBe(THEM)
  })

  it('normalises a nonsense side to the enemy', () => {
    expect(effectiveRosterSide('sideways', lead)).toBe(THEM)
    expect(effectiveRosterSide(undefined, lead)).toBe(THEM)
  })
})

describe('pollingState (#342)', () => {
  const HOUR = 3600
  const now = 1_800_000_000_000
  const nowSec = Math.floor(now / 1000)

  it('reports off when the war room is disabled', () => {
    expect(pollingState({ enabled: false, nowMs: now })).toMatchObject({ state: 'off', polling: false })
  })

  it('reports scheduled — NOT live — before an auto-managed war starts', () => {
    // The exact production case: enabled, auto-managed, war 8h away. The board
    // showed a green LIVE badge over a roster frozen at the last war's end,
    // while the server was deliberately not polling.
    const s = pollingState({
      enabled: true, autoManaged: true,
      warStartAt: nowSec + 8 * HOUR, nowMs: now,
    })
    expect(s).toMatchObject({ state: 'scheduled', polling: false })
    expect(s.startsAt).toBe(nowSec + 8 * HOUR)
  })

  it('reports live once an auto-managed war is inside its window', () => {
    expect(pollingState({
      enabled: true, autoManaged: true,
      warStartAt: nowSec - HOUR, warEndAt: nowSec + HOUR, nowMs: now,
    })).toMatchObject({ state: 'live', polling: true })
  })

  it('reports ended after an auto-managed war closes', () => {
    expect(pollingState({
      enabled: true, autoManaged: true,
      warStartAt: nowSec - 4 * HOUR, warEndAt: nowSec - HOUR, nowMs: now,
    })).toMatchObject({ state: 'ended', polling: false })
  })

  it('treats an open-ended war as live', () => {
    for (const warEndAt of [null, 0, undefined]) {
      expect(pollingState({
        enabled: true, autoManaged: true, warStartAt: nowSec - HOUR, warEndAt, nowMs: now,
      })).toMatchObject({ state: 'live', polling: true })
    }
  })

  it('always reports live for a manual session, whatever the war window says', () => {
    // auto_managed=false is the documented escape hatch — pressing Save yields
    // the session to the leader and the ticker polls regardless.
    expect(pollingState({
      enabled: true, autoManaged: false, warStartAt: nowSec + 8 * HOUR, nowMs: now,
    })).toMatchObject({ state: 'live', polling: true })
  })

  it('assumes live when there is no usable start time', () => {
    // Never claim a gate we cannot prove — mislabelling a working board as
    // stopped is its own kind of lie.
    expect(pollingState({ enabled: true, autoManaged: true, warStartAt: null, nowMs: now }))
      .toMatchObject({ state: 'live', polling: true })
  })
})
