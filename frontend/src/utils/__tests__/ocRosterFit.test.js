// #442 — connecting the simulator's hypothetical crew to the roster we have.
import { describe, expect, it } from 'vitest'
import {
  headcountAtCpr, cprCurve, maxSustainableCpr, roleFit, crewFit, staleReadings,
} from '../ocRosterFit'

const READINGS = [
  { member_id: '1', member_name: 'Ace', cpr: 92 },
  { member_id: '2', member_name: 'Bee', cpr: 78 },
  { member_id: '3', member_name: 'Cee', cpr: 71 },
  { member_id: '4', member_name: 'Dee', cpr: 44 },
]

describe('headcountAtCpr', () => {
  it('counts everyone at or above the bar', () => {
    expect(headcountAtCpr(READINGS, 70)).toBe(3)
    expect(headcountAtCpr(READINGS, 80)).toBe(1)
    expect(headcountAtCpr(READINGS, 95)).toBe(0)
  })

  it('is inclusive at the boundary — 71 clears a bar of 71', () => {
    expect(headcountAtCpr(READINGS, 71)).toBe(3)
    expect(headcountAtCpr(READINGS, 72)).toBe(2)
  })

  it('does not count a member whose reading is missing as a zero', () => {
    // ⚠️ The #351 rule. An unknown is not a failure, and counting it as one
    // makes a crime nobody has run look like a crime nobody can do.
    const withGap = [...READINGS, { member_id: '5', member_name: 'Eee', cpr: null }]
    expect(headcountAtCpr(withGap, 0)).toBe(4)
  })

  it('handles no readings at all', () => {
    expect(headcountAtCpr([], 50)).toBe(0)
    expect(headcountAtCpr(undefined, 50)).toBe(0)
  })
})

describe('cprCurve', () => {
  it('shows where the roster falls off a cliff', () => {
    // The useful direction: not "how many at 70" but "the bar cannot go past 78
    // without losing all but one person".
    const curve = cprCurve(READINGS, 10)
    expect(curve.find((p) => p.cpr === 70).count).toBe(3)
    expect(curve.find((p) => p.cpr === 80).count).toBe(1)
    expect(curve.find((p) => p.cpr === 100).count).toBe(0)
  })

  it('is monotonically non-increasing, as a sanity check on itself', () => {
    const curve = cprCurve(READINGS, 5)
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i].count).toBeLessThanOrEqual(curve[i - 1].count)
    }
  })
})

describe('maxSustainableCpr', () => {
  it('is the practical ceiling for a role', () => {
    expect(maxSustainableCpr(READINGS, 1)).toBe(92)
    expect(maxSustainableCpr(READINGS, 3)).toBe(71)
  })

  it('returns null when we cannot crew it at any bar', () => {
    // Distinct from a ceiling of 0: this means we lack the people, and the UI
    // must not print "ceiling 0" as though that were a measurement.
    expect(maxSustainableCpr(READINGS, 9)).toBeNull()
    expect(maxSustainableCpr([], 1)).toBeNull()
  })
})

describe('roleFit', () => {
  const role = { position_id: 'P1', role_name: 'Robber' }

  it('separates "nobody clears the bar" from "we have no readings"', () => {
    // ⚠️ Both show 0 eligible and they mean completely different things: the
    // first is a training problem, the second is a data problem.
    const tooHigh = roleFit(role, READINGS, 99)
    const noData = roleFit(role, [], 50)
    expect(tooHigh.eligible).toBe(0)
    expect(tooHigh.hasReadings).toBe(true)
    expect(noData.eligible).toBe(0)
    expect(noData.hasReadings).toBe(false)
  })

  it('reports the shortfall against what the role needs', () => {
    expect(roleFit(role, READINGS, 80, { needed: 3 }).shortfall).toBe(2)
    expect(roleFit(role, READINGS, 70, { needed: 3 }).shortfall).toBe(0)
  })
})

describe('crewFit', () => {
  const roles = [
    { position_id: 'P1', role_name: 'Robber' },
    { position_id: 'P2', role_name: 'Muscle 1' },
  ]
  const byRole = {
    P1: READINGS,
    P2: [{ member_id: '9', member_name: 'Zed', cpr: 60 }],
  }

  it('names the role that binds the plan', () => {
    const fit = crewFit(roles, byRole, [70, 70])
    expect(fit.tightest.roleName).toBe('Muscle 1')
    expect(fit.crewable).toBe(false)
    expect(fit.unfilled).toEqual(['Muscle 1'])
  })

  it('calls a crew fieldable when every role has someone', () => {
    expect(crewFit(roles, byRole, [70, 55]).crewable).toBe(true)
  })

  it('⚠️ does NOT check that the eligible sets are disjoint', () => {
    // One member can be the only person clearing the bar for every role, and
    // this deliberately still reports crewable — solving it is an assignment
    // problem belonging to the team builder (#443). Pinned so the limitation is
    // a documented choice rather than an unnoticed bug.
    const sameGuy = [{ member_id: '1', member_name: 'Ace', cpr: 92 }]
    const fit = crewFit(roles, { P1: sameGuy, P2: sameGuy }, [90, 90])
    expect(fit.crewable).toBe(true)
  })

  it('survives a crime with no roles', () => {
    expect(crewFit([], {}, []).tightest).toBeNull()
    expect(crewFit(undefined, undefined, undefined).crewable).toBe(false)
  })
})

describe('staleReadings', () => {
  const now = Date.parse('2026-08-13T00:00:00Z')

  it('counts readings older than the window', () => {
    const rows = [
      { cpr: 90, updated_at: '2026-08-12T00:00:00+00' },
      { cpr: 80, updated_at: '2026-06-01T00:00:00+00' },
    ]
    expect(staleReadings(rows, now)).toBe(1)
  })

  it('parses the bare +00 offset Postgres serves', () => {
    // The #140 trap: Date.parse on "...+00" is NaN, and a NaN comparison is
    // false, so every reading would silently look fresh.
    expect(staleReadings([{ cpr: 90, updated_at: '2026-01-01T00:00:00+00' }], now)).toBe(1)
  })

  it('does not count a reading with no timestamp as stale', () => {
    expect(staleReadings([{ cpr: 90, updated_at: null }], now)).toBe(0)
  })
})
