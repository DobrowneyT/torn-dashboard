import { describe, expect, it } from 'vitest'
import {
  buildMemberList, revivesPerformedInWindow, ACTIVITY,
} from '../warOverviewMembers'

const OURS = 10739
const THEM = 99999

// One attack row, trimmed to the fields the member list reads.
const atk = (attackerId, attackerFac, defenderId, defenderFac) => ({
  attacker_id: attackerId, attacker_faction_id: attackerFac, attacker_name: `atk${attackerId}`,
  defender_id: defenderId, defender_faction_id: defenderFac, defender_name: `def${defenderId}`,
  started: 1000, result: 'Hospitalized',
})

const rev = (targetId, targetFac, reviverId, reviverFac, timestamp = 1000) => ({
  target_id: targetId, target_faction_id: targetFac, target_name: `tgt${targetId}`,
  reviver_id: reviverId, reviver_faction_id: reviverFac, reviver_name: `rev${reviverId}`,
  timestamp, result: 'success',
})

const rosterRow = (id, name) => ({ member_id: String(id), member_name: name, is_current: true })

describe('buildMemberList', () => {
  it('keeps the members the event data already surfaced', () => {
    const list = buildMemberList({
      attacks: [atk(1, OURS, 50, THEM), atk(60, THEM, 2, OURS)],
      ourFactionId: OURS,
    })
    expect(list.map(m => m.id)).toEqual([1, 2])
    expect(list.find(m => m.id === 1)).toMatchObject({ outgoing: 1, incoming: 0 })
    expect(list.find(m => m.id === 2)).toMatchObject({ outgoing: 0, incoming: 1 })
  })

  it('does NOT list the enemy, on either side of an attack', () => {
    const list = buildMemberList({
      attacks: [atk(1, OURS, 50, THEM), atk(60, THEM, 2, OURS)],
      ourFactionId: OURS,
    })
    expect(list.map(m => m.id)).not.toContain(50)
    expect(list.map(m => m.id)).not.toContain(60)
  })

  /**
   * ⚠️ The bug this file exists for. A member who neither attacked nor was
   * attacked had no row to be found in, so the dropdown could not offer them —
   * and "absent from the list" read as "not in the war" rather than "did
   * nothing", which is the one thing the member view is for.
   */
  it('lists a roster member with no events at all', () => {
    const list = buildMemberList({
      attacks: [atk(1, OURS, 50, THEM)],
      roster: [rosterRow(1, 'Fighter'), rosterRow(7, 'Idle')],
      ourFactionId: OURS,
    })
    const idle = list.find(m => m.id === 7)
    expect(idle).toBeTruthy()
    expect(idle.name).toBe('Idle')
    expect(idle.events).toBe(0)
    expect(idle.activity).toBe(ACTIVITY.none)
  })

  /**
   * ⚠️ The second half of the same bug: revives were matched on `target_id`
   * only, so a medic who spent the war reviving teammates — never hit, never
   * hitting — was missing even though `faction_revives.reviver_id` was sitting
   * in the rows already loaded.
   */
  it('lists a member who only performed revives', () => {
    const list = buildMemberList({
      attacks: [],
      revives: [rev(3, OURS, 9, OURS)],
      ourFactionId: OURS,
    })
    const medic = list.find(m => m.id === 9)
    expect(medic).toBeTruthy()
    expect(medic.revivesOut).toBe(1)
    expect(medic.activity).toBe(ACTIVITY.revivedOnly)
  })

  it('does not count an outside reviver as one of ours', () => {
    const list = buildMemberList({
      revives: [rev(3, OURS, 9, THEM)],
      ourFactionId: OURS,
    })
    expect(list.map(m => m.id)).toEqual([3])
  })

  it('counts a revive received without claiming the member fought', () => {
    const list = buildMemberList({
      revives: [rev(3, OURS, 9, THEM)],
      ourFactionId: OURS,
    })
    expect(list[0]).toMatchObject({ revivesIn: 1, revivesOut: 0, activity: ACTIVITY.fought })
  })

  /**
   * ⚠️ Faction ids arrive as strings from some payloads, which is why the
   * server's own revive filters go through `Number()`. A `===` against a
   * number silently matched nothing.
   */
  it('matches faction ids across string and number forms', () => {
    const list = buildMemberList({
      attacks: [{ ...atk(1, OURS, 50, THEM), attacker_faction_id: String(OURS) }],
      ourFactionId: String(OURS),
    })
    expect(list.map(m => m.id)).toEqual([1])
  })

  it('prefers the name the war recorded, falling back to the roster', () => {
    const list = buildMemberList({
      attacks: [atk(1, OURS, 50, THEM)],
      roster: [rosterRow(1, 'RenamedSince')],
      ourFactionId: OURS,
    })
    // The event name is what they were called during the war, which is what a
    // post-mortem read weeks later should say.
    expect(list.find(m => m.id === 1).name).toBe('atk1')
  })

  it('falls back to the id when nothing names them', () => {
    const list = buildMemberList({
      attacks: [{ ...atk(1, OURS, 50, THEM), attacker_name: null }],
      ourFactionId: OURS,
    })
    expect(list[0].name).toBe('id 1')
  })

  it('skips roster rows that are no longer current', () => {
    const list = buildMemberList({
      roster: [{ ...rosterRow(7, 'Left'), is_current: false }],
      ourFactionId: OURS,
    })
    expect(list).toEqual([])
  })

  /**
   * ⚠️ A former member who DID fight stays, even though the current roster has
   * no row for them. The roster adds to the list; it never filters it.
   */
  it('keeps a departed member who fought', () => {
    const list = buildMemberList({
      attacks: [atk(1, OURS, 50, THEM)],
      roster: [rosterRow(7, 'StillHere')],
      ourFactionId: OURS,
    })
    expect(list.find(m => m.id === 1)).toMatchObject({ onRoster: false, activity: ACTIVITY.fought })
    expect(list.find(m => m.id === 7)).toMatchObject({ onRoster: true })
  })

  it('sorts by name, case-insensitively', () => {
    const list = buildMemberList({
      roster: [rosterRow(1, 'zara'), rosterRow(2, 'Albert'), rosterRow(3, 'bob')],
      ourFactionId: OURS,
    })
    expect(list.map(m => m.name)).toEqual(['Albert', 'bob', 'zara'])
  })

  it('counts one member once across many events', () => {
    const list = buildMemberList({
      attacks: [atk(1, OURS, 50, THEM), atk(1, OURS, 51, THEM), atk(60, THEM, 1, OURS)],
      revives: [rev(1, OURS, 9, THEM)],
      roster: [rosterRow(1, 'Busy')],
      ourFactionId: OURS,
    })
    expect(list.filter(m => m.id === 1)).toHaveLength(1)
    expect(list.find(m => m.id === 1)).toMatchObject({
      outgoing: 2, incoming: 1, revivesIn: 1, events: 4,
    })
  })

  it('ignores event rows with no participant id', () => {
    const list = buildMemberList({
      attacks: [{ ...atk(null, OURS, 50, THEM) }],
      ourFactionId: OURS,
    })
    expect(list).toEqual([])
  })

  it('returns an empty list rather than throwing on no input', () => {
    expect(buildMemberList({ ourFactionId: OURS })).toEqual([])
  })
})

describe('revivesPerformedInWindow', () => {
  it('counts only this member, and only inside the window', () => {
    const revives = [
      rev(3, OURS, 9, OURS, 100),
      rev(4, OURS, 9, OURS, 500),
      rev(5, OURS, 9, OURS, 900),   // after the window
      rev(6, OURS, 8, OURS, 200),   // somebody else
    ]
    expect(revivesPerformedInWindow({ revives, memberId: 9, fromTs: 50, toTs: 600 })).toBe(2)
  })

  it('is inclusive at both edges', () => {
    const revives = [rev(3, OURS, 9, OURS, 50), rev(4, OURS, 9, OURS, 600)]
    expect(revivesPerformedInWindow({ revives, memberId: 9, fromTs: 50, toTs: 600 })).toBe(2)
  })

  it('is zero for no member and no rows', () => {
    expect(revivesPerformedInWindow({ revives: [], memberId: null, fromTs: 0, toTs: 1 })).toBe(0)
  })
})
