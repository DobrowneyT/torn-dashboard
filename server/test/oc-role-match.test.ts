// #442 — joining mirrored roles to Torn's own crime positions.
//
// The third appearance of the same string-mismatch hazard: tornprobability says
// "Thief 1", Torn says "Thief #1", and the weights endpoint says "Thief1". A
// wrong join reports one role's headcount under another's name, which is
// invisible on screen.
import { describe, expect, it } from 'vitest'
import { matchRolesToPositions } from '../src/oc/roleMatch.js'

const ROLES = [
  { position_id: 'P1', role_name: 'Robber' },
  { position_id: 'P2', role_name: 'Muscle 1' },
  { position_id: 'P4', role_name: 'Thief 1' },
]

describe('matchRolesToPositions', () => {
  it('joins across the "#" spelling difference', () => {
    const positions = [
      { position_label: 'Robber', position_id: 'P1' },
      { position_label: 'Muscle #1', position_id: 'P2' },
      { position_label: 'Thief #1', position_id: 'P4' },
    ]
    const r = matchRolesToPositions(ROLES, positions)
    expect(r.unmatched).toEqual([])
    expect(r.conflicts).toEqual([])
    expect(r.matches.map((m) => m.positionLabel)).toEqual(['Robber', 'Muscle #1', 'Thief #1'])
    // Corroborated by both signals.
    expect(r.matches.every((m) => m.via === 'both')).toBe(true)
  })

  it('⚠️ matches on the NAME where name and position id disagree', () => {
    // The failure this cross-check exists for: tornprobability numbering its
    // positions differently from Torn. Trusting the id would silently attach
    // every CPR reading to the wrong role — so the name wins, and the
    // disagreement is still reported for diagnosis.
    const positions = [
      { position_label: 'Robber', position_id: 'P1' },
      { position_label: 'Muscle #1', position_id: 'P4' },   // id says P4
      { position_label: 'Thief #1', position_id: 'P2' },    // ids swapped
    ]
    const r = matchRolesToPositions(ROLES, positions)
    expect(r.conflicts.map((c) => c.roleName).sort()).toEqual(['Muscle 1', 'Thief 1'])
    // ⚠️ Every role still matched, and each to the position its NAME names —
    // refusing them cost a real headcount and showed a warning nobody could act
    // on. `via` records that the corroboration was lost.
    expect(r.matches.map((m) => m.roleName)).toEqual(['Robber', 'Muscle 1', 'Thief 1'])
    expect(r.matches.map((m) => m.positionLabel)).toEqual(['Robber', 'Muscle #1', 'Thief #1'])
    expect(r.matches.map((m) => m.via)).toEqual(['both', 'name', 'name'])
    expect(r.unmatched).toEqual([])
  })

  it('falls back to the name when Torn has no position id', () => {
    // position_id is nullable in oc_crime_positions; the label always exists.
    const positions = [
      { position_label: 'Robber', position_id: null },
      { position_label: 'Muscle #1', position_id: null },
      { position_label: 'Thief #1', position_id: null },
    ]
    const r = matchRolesToPositions(ROLES, positions)
    expect(r.matches).toHaveLength(3)
    expect(r.matches.every((m) => m.via === 'name')).toBe(true)
    expect(r.conflicts).toEqual([])
  })

  it('falls back to the position id when the label is worded differently', () => {
    const positions = [{ position_label: 'Getaway Driver', position_id: 'P1' }]
    const r = matchRolesToPositions([{ position_id: 'P1', role_name: 'Robber' }], positions)
    expect(r.matches[0]).toMatchObject({ positionLabel: 'Getaway Driver', via: 'position' })
  })

  it('⚠️ reports a role it could not match rather than leaving it empty', () => {
    // An unmatched role with no readings renders as "nobody can fill this",
    // which is a far more alarming claim than "we could not look" — and would
    // send someone hunting for a training problem that does not exist.
    const r = matchRolesToPositions(ROLES, [{ position_label: 'Robber', position_id: 'P1' }])
    expect(r.unmatched).toEqual(['Muscle 1', 'Thief 1'])
    expect(r.matches).toHaveLength(1)
  })

  it('handles a crime we have never run, so have no positions for', () => {
    const r = matchRolesToPositions(ROLES, [])
    expect(r.matches).toEqual([])
    expect(r.unmatched).toHaveLength(3)
  })

  it('does not confuse Muscle 1 with Muscle 2', () => {
    // The normalisation must be aggressive enough to join and no more.
    const roles = [
      { position_id: 'P2', role_name: 'Muscle 1' },
      { position_id: 'P5', role_name: 'Muscle 3' },
    ]
    const positions = [
      { position_label: 'Muscle #1', position_id: 'P2' },
      { position_label: 'Muscle #3', position_id: 'P5' },
    ]
    const r = matchRolesToPositions(roles, positions)
    expect(r.matches.find((m) => m.roleName === 'Muscle 1')!.positionLabel).toBe('Muscle #1')
    expect(r.matches.find((m) => m.roleName === 'Muscle 3')!.positionLabel).toBe('Muscle #3')
  })
})
