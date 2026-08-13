// #398 — previous matchups and the roster diff.
//
// The recurring theme in these tests is the difference between "we have no
// record" and "the record says none": a faction we have never fought, a war
// with no recorded winner, and a war where no roll call was taken all have to
// stay distinguishable from zero.
import { describe, expect, it } from 'vitest'
import {
  warResult,
  RESULT_LABELS,
  headToHead,
  rosterDiff,
  topContributors,
  rollCallTurnout,
} from '../opponentHistory'

const US = 10739
const THEM = 77001

describe('warResult', () => {
  it('reads a win and a loss from our own faction id', () => {
    expect(warResult({ winner_faction_id: US }, US)).toBe('won')
    expect(warResult({ winner_faction_id: THEM }, US)).toBe('lost')
  })

  it('compares ids as strings, since Torn sends both', () => {
    expect(warResult({ winner_faction_id: '10739' }, 10739)).toBe('won')
    expect(warResult({ winner_faction_id: 10739 }, '10739')).toBe('won')
  })

  it('marks a forfeit without losing who won', () => {
    expect(warResult({ winner_faction_id: US, forfeit: true }, US)).toBe('won-forfeit')
    expect(warResult({ winner_faction_id: THEM, forfeit: true }, US)).toBe('lost-forfeit')
  })

  it('says unknown rather than crediting the other side', () => {
    // A finished war with no winner recorded is a gap in our data. Defaulting
    // it to a loss would quietly make our record against them look worse than
    // it is, on a panel read before deciding how to fight them.
    expect(warResult({ winner_faction_id: null }, US)).toBe('unknown')
    expect(warResult({}, US)).toBe('unknown')
    expect(RESULT_LABELS.unknown).toBe('—')
  })
})

describe('headToHead', () => {
  it('counts our record and keeps unreadable wars separate', () => {
    const record = headToHead(
      [
        { winner_faction_id: US },
        { winner_faction_id: THEM },
        { winner_faction_id: US, forfeit: true },
        { winner_faction_id: null },
      ],
      US
    )
    expect(record).toEqual({ won: 2, lost: 1, unknown: 1, total: 4 })
  })

  it('handles never having fought them', () => {
    expect(headToHead([], US)).toEqual({ won: 0, lost: 0, unknown: 0, total: 0 })
    expect(headToHead(undefined, US).total).toBe(0)
  })
})

describe('rosterDiff', () => {
  const last = [
    { member_id: 1, member_name: 'Stayed', level: 40 },
    { member_id: 2, member_name: 'Left',   level: 55 },
    { member_id: 3, member_name: 'AlsoStayed', level: 12 },
  ]
  const current = [
    { member_id: 1, member_name: 'Stayed', level: 47 },
    { member_id: 3, member_name: 'AlsoStayed', level: 12 },
    { member_id: 9, member_name: 'Arrived', level: 31 },
  ]

  it('splits the roster into new, returning and departed', () => {
    const d = rosterDiff(current, last)
    expect(d.newMembers.map((m) => m.name)).toEqual(['Arrived'])
    expect(d.returning.map((m) => m.name)).toEqual(['AlsoStayed', 'Stayed'])
    expect(d.departed.map((m) => m.name)).toEqual(['Left'])
  })

  it('reports level movement for members present in both', () => {
    const d = rosterDiff(current, last)
    const stayed = d.returning.find((m) => m.name === 'Stayed')
    expect(stayed.previousLevel).toBe(40)
    expect(stayed.level).toBe(47)
    expect(stayed.levelGain).toBe(7)
  })

  it('leaves the level gain null when a level is missing, not zero', () => {
    // "Gained 0 levels" is a claim; "we do not know their level" is not.
    const d = rosterDiff(
      [{ member_id: 1, member_name: 'Stayed' }],
      [{ member_id: 1, member_name: 'Stayed', level: 40 }]
    )
    expect(d.returning[0].levelGain).toBeNull()
    expect(d.returning[0].previousLevel).toBe(40)
  })

  it('matches ids across string and number forms', () => {
    const d = rosterDiff(
      [{ member_id: '1', member_name: 'Stayed', level: 41 }],
      [{ member_id: 1, member_name: 'Stayed', level: 40 }]
    )
    expect(d.newMembers).toEqual([])
    expect(d.returning).toHaveLength(1)
  })

  it('returns null when there is no previous roster to compare against', () => {
    // ⚠️ Distinct from an empty diff. A faction we have never fought must not
    // render as "everyone on their roster is new" — which is technically true
    // and completely useless, and would make a first matchup look alarming.
    expect(rosterDiff(current, [])).toBeNull()
    expect(rosterDiff(current, null)).toBeNull()
  })

  it('reports an unchanged roster as empty groups, not as null', () => {
    const d = rosterDiff(last, last)
    expect(d).not.toBeNull()
    expect(d.newMembers).toEqual([])
    expect(d.departed).toEqual([])
    expect(d.returning).toHaveLength(3)
  })

  it('carries both roster sizes, since neither is guaranteed to be 100', () => {
    // Torn's report held 77–100 rows per war in the real data. The sizes are
    // what let the panel say how much of a roster it is actually diffing.
    const d = rosterDiff(current, last)
    expect(d.previousSize).toBe(3)
    expect(d.currentSize).toBe(3)
  })

  it('survives an empty current roster', () => {
    // The War Room roster is empty before the first poll lands. Everyone
    // showing as departed for a few seconds would be alarming and wrong, but it
    // must at least not throw.
    const d = rosterDiff([], last)
    expect(d.departed).toHaveLength(3)
    expect(d.currentSize).toBe(0)
  })
})

describe('topContributors', () => {
  it('trims to the cap and tolerates nothing stored', () => {
    const rows = Array.from({ length: 9 }, (_, i) => ({ member_name: `M${i}`, score: 100 - i }))
    expect(topContributors(rows)).toHaveLength(5)
    expect(topContributors(rows, 2).map((r) => r.member_name)).toEqual(['M0', 'M1'])
    expect(topContributors(undefined)).toEqual([])
  })
})

describe('rollCallTurnout', () => {
  it('reports turnout as a fraction', () => {
    const t = rollCallTurnout([
      { on_at_start: true }, { on_at_start: true }, { on_at_start: false }, { on_at_start: true },
    ])
    expect(t).toEqual({ on: 3, total: 4, fraction: 0.75 })
  })

  it('returns null when no roll call was taken, rather than 0%', () => {
    // Roll call postdates some of these wars. "0% turnout" would blame the
    // faction for a feature that did not exist yet.
    expect(rollCallTurnout([])).toBeNull()
    expect(rollCallTurnout(undefined)).toBeNull()
  })
})
