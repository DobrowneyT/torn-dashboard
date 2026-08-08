// Roster-side toggle decisions (#335).
import { describe, it, expect } from 'vitest'
import {
  THEM, US, DEFAULT_ROSTER_SIDE,
  isRosterSide, selectRosterMembers, rosterColumns, rosterColumnCount,
  isStatsFilterAvailable, otherSide, canViewOurRoster, effectiveRosterSide, pollingState,
  effectiveSortCol,
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

describe('pollingState (#345)', () => {
  it('reports off when the war room is disabled', () => {
    expect(pollingState({ enabled: false })).toMatchObject({ state: 'off', polling: false })
  })

  it('reports live whenever the room is enabled, whatever the war is doing', () => {
    // #345 removed the war-window gate: an enabled room polls, full stop.
    // Previously a war starting in 8 hours meant no polling at all while the
    // badge still read LIVE.
    expect(pollingState({ enabled: true, rosterIntervalMs: 1000 }))
      .toMatchObject({ state: 'live', polling: true, rosterPolling: true })
  })

  it('distinguishes an enabled room whose roster poll is switched off', () => {
    // Plain "LIVE" over a roster nobody refreshes would repeat the original
    // lie in miniature.
    expect(pollingState({ enabled: true, rosterIntervalMs: 0 }))
      .toMatchObject({ state: 'roster-paused', polling: true, rosterPolling: false })
  })

  it('treats an unset cadence as polling, not paused', () => {
    // Number(null) is 0; reading "unset" as "off" would blank the board on
    // upgrade before the column is populated.
    expect(pollingState({ enabled: true })).toMatchObject({ state: 'live', rosterPolling: true })
    expect(pollingState({ enabled: true, rosterIntervalMs: null }))
      .toMatchObject({ state: 'live', rosterPolling: true })
  })
})

describe('effectiveSortCol (#351)', () => {
  it('keeps a shared column on either side', () => {
    for (const col of ['name', 'activity', 'status', 'timer', 'stats', 'farm']) {
      expect(effectiveSortCol(col, US)).toBe(col)
      expect(effectiveSortCol(col, THEM)).toBe(col)
    }
  })

  it('keeps the our-roster stat columns while we are on our roster', () => {
    for (const col of ['energy', 'cooldown_drug', 'cooldown_medical', 'cooldown_booster']) {
      expect(effectiveSortCol(col, US)).toBe(col)
    }
  })

  it('falls back when the sort column does not exist on this side', () => {
    // sortCol is persisted across reloads, so someone who sorts by energy,
    // toggles back to the enemy and reloads would otherwise land on a sort
    // over a column that isn't rendered — every row compares equal and the
    // header arrow points at nothing.
    expect(effectiveSortCol('energy', THEM)).toBe('timer')
    expect(effectiveSortCol('cooldown_drug', THEM)).toBe('timer')
  })

  it('falls back for a war lead who lost the role mid-session', () => {
    // effectiveRosterSide already forces them back to THEM; this makes sure
    // the sort follows rather than stranding the table on a dead comparator.
    const side = effectiveRosterSide(US, { isWarLead: false })
    expect(effectiveSortCol('energy', side)).toBe('timer')
  })

  it('ignores an unrecognised sort column rather than rewriting it', () => {
    expect(effectiveSortCol('mystery', THEM)).toBe('mystery')
  })
})
