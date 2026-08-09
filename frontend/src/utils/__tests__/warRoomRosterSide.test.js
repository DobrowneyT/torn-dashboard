// Roster-side toggle decisions (#335).
import { describe, it, expect } from 'vitest'
import {
  THEM, US, DEFAULT_ROSTER_SIDE,
  isRosterSide, selectRosterMembers, rosterColumns, rosterColumnCount,
  isStatsFilterAvailable, otherSide, canViewOurRoster, effectiveRosterSide, pollingState,
  effectiveSortCol, passesStatsFilter,
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

  it('shows Revive % only on our own faction (#358)', () => {
    // Not a display choice: Torn reports a success chance only on revives our
    // own faction received, so there is no enemy figure to show.
    expect(rosterColumns(US)).toMatchObject({ reviveChance: true })
    expect(rosterColumns(THEM)).toMatchObject({ reviveChance: false })
  })
})

describe('rosterColumnCount', () => {
  it('counts the columns actually rendered for each side', () => {
    // Drives the empty-state colSpan; a wrong number visibly breaks that row.
    expect(rosterColumnCount(THEM)).toBe(8)
    expect(rosterColumnCount(US)).toBe(11)
  })

  it('stays in step with rosterColumns', () => {
    for (const side of [THEM, US]) {
      const optional = Object.values(rosterColumns(side)).filter(Boolean).length
      expect(rosterColumnCount(side)).toBe(6 + optional)
    }
  })
})

describe('isStatsFilterAvailable', () => {
  it('is always available against the opponent', () => {
    expect(isStatsFilterAvailable(THEM)).toBe(true)
    expect(isStatsFilterAvailable(THEM, 0)).toBe(true)
  })

  it('opens up on our roster once we hold battle stats (#353)', () => {
    expect(isStatsFilterAvailable(US, 42)).toBe(true)
  })

  it('stays suspended on our roster while we hold none', () => {
    // The original trap is still open before the daily sweep has run, or if
    // the fetch failed: every bsp_total is null, so an active min/max carried
    // over from the enemy side would empty the table on toggle.
    expect(isStatsFilterAvailable(US, 0)).toBe(false)
    expect(isStatsFilterAvailable(US)).toBe(false)
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
    for (const col of ['energy', 'cooldown_drug', 'cooldown_medical', 'cooldown_booster', 'revive_chance']) {
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
    // #358: revive chance is our-roster only for the same reason.
    expect(effectiveSortCol('revive_chance', THEM)).toBe('timer')
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

describe('passesStatsFilter (#366)', () => {
  const weak = { bsp_total: 1_000_000 }
  const strong = { bsp_total: 5_000_000_000 }
  const unspied = { bsp_total: null }
  const band = { min: 2_000_000, max: 100_000_000 }

  it('filters on the total when farm mode is off', () => {
    expect(passesStatsFilter(weak, band)).toBe(false)
    expect(passesStatsFilter(strong, band)).toBe(false)
    expect(passesStatsFilter({ bsp_total: 50_000_000 }, band)).toBe(true)
  })

  it('drops un-spied members when a bound is set', () => {
    // No number means we cannot say they are in range, and claiming they are
    // would put an unknown-strength target in a filtered list.
    expect(passesStatsFilter(unspied, band)).toBe(false)
    expect(passesStatsFilter(unspied, { min: 5 })).toBe(false)
  })

  it('keeps everyone when no bound is set', () => {
    expect(passesStatsFilter(unspied, {})).toBe(true)
    expect(passesStatsFilter(weak, {})).toBe(true)
  })

  it('lets a green attack button through in FARM MODE, whatever the filter says', () => {
    // The point of the change. Those are the only people hittable this second;
    // if a push starts they are what a lead must see, and a min/max left over
    // from farming would quietly remove exactly them.
    expect(passesStatsFilter(weak, { ...band, farmMode: true, isGreen: true })).toBe(true)
    expect(passesStatsFilter(strong, { ...band, farmMode: true, isGreen: true })).toBe(true)
    expect(passesStatsFilter(unspied, { ...band, farmMode: true, isGreen: true })).toBe(true)
  })

  it('still filters non-green members in farm mode', () => {
    // The bypass is for the green tier only — otherwise farm mode would just
    // switch the filter off, which is not what was asked for.
    expect(passesStatsFilter(weak, { ...band, farmMode: true, isGreen: false })).toBe(false)
  })

  it('does not bypass outside farm mode', () => {
    // A stats filter set deliberately, with farm mode off, is a targeting tool
    // and must do what it says.
    expect(passesStatsFilter(weak, { ...band, farmMode: false, isGreen: true })).toBe(false)
  })

  it('treats 0 as a real total rather than missing', () => {
    expect(passesStatsFilter({ bsp_total: 0 }, { min: 0 })).toBe(true)
    expect(passesStatsFilter({ bsp_total: 0 }, { min: 1 })).toBe(false)
  })
})
