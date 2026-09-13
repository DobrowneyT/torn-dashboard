// #694 — the deliverable members actually read.
//
// Everything upstream is worthless if the output is a spreadsheet nobody opens.
// This is the artifact that changes what people train, so its failure modes are
// about MEANING rather than arithmetic: a number that invites pointless
// training, a threshold that looks solid when it is on a knife edge, a table
// that presents an assumption as a fact.
import { describe, expect, it } from 'vitest'
import { publishGuidance } from '../ocGuidanceTable'

const P = ['P1', 'P2', 'P3', 'P4']
const WEIGHTS = { P1: 34.6, P2: 30.0, P3: 32.5, P4: 2.9 }
const NAMES = { P1: 'Muscle', P2: 'Engineer', P3: 'Bomber', P4: 'Picklock 2' }

/** Twelve members readable for every role at 95 down to 84. */
const readings = () => {
  const pool = Array.from({ length: 12 }, (_, i) => ({ member_id: `m${i}`, cpr: 95 - i }))
  return Object.fromEntries(P.map((p) => [p, pool.map((r) => ({ ...r }))]))
}

const base = () => ({
  scenarioName: 'Blast from the Past',
  positionIds: P,
  roleNames: NAMES,
  weights: WEIGHTS,
  chosen: { P1: 92, P2: 88, P3: 90, P4: 86 },
  ceiling: { P1: 95, P2: 93, P3: 94, P4: 92 },
  readings: readings(),
})

describe('publishGuidance', () => {
  it('⚠️ publishes 0 on a carry role while keeping the bar the model used', () => {
    // The deliberate divergence (MonChoon, 2026-09-12). "You do not need this
    // role trained" is the true instruction, and ANY number invites people to
    // train toward it — but the simulator scored the crime at 86, and hiding
    // that would make the table unauditable.
    const g = publishGuidance(base())
    const carry = g.roles.find((r) => r.positionId === 'P4')
    expect(carry.isCarry).toBe(true)
    expect(carry.published).toBe(0)
    expect(carry.floor).toBe(86)
  })

  it('does not publish 0 on a role that matters', () => {
    const g = publishGuidance(base())
    for (const r of g.roles.filter((x) => !x.isCarry)) {
      expect(r.published).toBe(r.floor)
      expect(r.published).toBeGreaterThan(0)
    }
  })

  it('⚠️ decides the carry by WEIGHT, never by position or by the bar being low', () => {
    const g = publishGuidance({ ...base(), weights: { P1: 2.0, P2: 30.0, P3: 32.5, P4: 35.5 } })
    expect(g.roles.find((r) => r.positionId === 'P1').isCarry).toBe(true)
    expect(g.roles.find((r) => r.positionId === 'P4').isCarry).toBe(false)
  })

  it('⚠️ shows the FLOOR and the EXPECTED crew side by side', () => {
    // The bar is a floor, not a prediction: members bring whoever is free,
    // usually above it. A table showing only the floor understates what the
    // crime really returns — widest on exactly the carry roles published as 0.
    const g = publishGuidance(base())
    const muscle = g.roles.find((r) => r.positionId === 'P1')
    // Halfway between the published minimum and step 1's maximal, per the
    // source document: (92 + 95) / 2.
    expect(muscle.expected).toBe(93.5)
    expect(muscle.expected).toBeGreaterThan(muscle.floor)
    expect(muscle.expected).toBeLessThanOrEqual(95)
  })

  it('takes the floor→ceiling blend as a tunable, like `g`', () => {
    expect(publishGuidance({ ...base(), expectedBlend: 0 }).roles[0].expected)
      .toBe(publishGuidance({ ...base(), expectedBlend: 0 }).roles[0].floor)
    const full = publishGuidance({ ...base(), expectedBlend: 1 })
    expect(full.roles.find((r) => r.positionId === 'P1').expected).toBe(95)
  })

  it('⚠️ shows the cliff, because a bar with headroom is a different instruction', () => {
    // A threshold of 92 where four clear it and three clear 93 is a knife edge
    // that one member leaving invalidates.
    const g = publishGuidance(base())
    const muscle = g.roles.find((r) => r.positionId === 'P1')
    expect(muscle.eligible).toBe(4)          // 95, 94, 93, 92
    expect(muscle.eligibleOneHigher).toBe(3)
    expect(muscle.cliff).toBe(1)
  })

  it('⚠️ reports how many members were never observed in a role', () => {
    // Absent is not failing (#351), and a role measured on four fewer people
    // carries a correspondingly softer number.
    const r = readings()
    r.P2 = r.P2.slice(0, 8)
    const g = publishGuidance({ ...base(), readings: r })
    expect(g.roles.find((x) => x.positionId === 'P2').readings).toBe(8)
  })

  it('⚠️ names who is closest to qualifying — the table has to be actionable', () => {
    // A faction-wide table nobody can act on is a spreadsheet. "Train 2 points
    // and you can fill this" is the whole point.
    const g = publishGuidance({ ...base(), nearMissWithin: 3 })
    const muscle = g.roles.find((r) => r.positionId === 'P1')
    // Bar is 92; 91, 90 and 89 are within 3.
    expect(muscle.nearMisses.map((m) => m.cpr)).toEqual([91, 90, 89])
    expect(muscle.nearMisses[0].pointsNeeded).toBe(1)
  })

  it('does not offer near-misses for a carry role', () => {
    const g = publishGuidance({ ...base(), nearMissWithin: 3 })
    expect(g.roles.find((r) => r.positionId === 'P4').nearMisses).toEqual([])
  })

  it('⚠️ states what it assumed, so nobody reads it as permanent truth', () => {
    const g = publishGuidance({ ...base(), gap: 0.5, gapIsAssumed: true, rosterSize: 92 })
    expect(g.assumptions.some((a) => /12h|gap/i.test(a))).toBe(true)
    expect(g.assumptions.some((a) => /roster|92/.test(a))).toBe(true)
    expect(g.assumptions.some((a) => /halfway|blend|expected/i.test(a))).toBe(true)
  })

  it('shows both values when the caller priced both crews', () => {
    const g = publishGuidance({
      ...base(),
      values: { floor: { expectedValue: 100 }, expected: { expectedValue: 130 } },
    })
    expect(g.value.floor).toBe(100)
    expect(g.value.expected).toBe(130)
    expect(g.value.uplift).toBeCloseTo(0.3, 6)
  })

  it('⚠️ reports absent rather than zero when a crew was not priced', () => {
    const g = publishGuidance(base())
    expect(g.value.floor).toBeNull()
    expect(g.value.expected).toBeNull()
    expect(g.value.uplift).toBeNull()
  })

  it('⚠️ refuses to publish a crime it cannot crew', () => {
    const g = publishGuidance({ ...base(), chosen: null })
    expect(g.publishable).toBe(false)
    expect(g.roles).toEqual([])
    expect(g.reason).toBe('no-chosen-vector')
  })

  it('orders the table by weight, so the roles that matter are read first', () => {
    const g = publishGuidance(base())
    expect(g.roles.map((r) => r.positionId)).toEqual(['P1', 'P3', 'P2', 'P4'])
    expect(g.roles.map((r) => r.roleName)).toEqual(['Muscle', 'Bomber', 'Engineer', 'Picklock 2'])
  })
})

// ⚠️ THE EXPECTED CREW CANNOT BE WEAKER THAN THE PUBLISHED FLOOR.
//
// Found by MonChoon asking what the floor and ceiling were actually based on.
// `maximalCprVector` is the highest bar with `n` candidates per role — Hall-safe
// for ONE crew — but the search's k=1 rung STARTS there and is then greedily
// raised above it. Using slice 3 as the blend target therefore produced:
//
//     P1 floor=95  ceiling=92  expected=93.5
//
// an expected crew below the minimum we told people to train to, which is not a
// thing that can happen.
describe('publishGuidance — the expected crew', () => {
  const P = ['P1', 'P2', 'P3', 'P4']
  const pool = () => Array.from({ length: 12 }, (_, i) => ({ member_id: `m${i}`, cpr: 95 - i }))
  const readings = () => Object.fromEntries(P.map((p) => [p, pool()]))

  it('⚠️ is never below the floor, even when the chosen bar beats slice 3\'s', () => {
    const g = publishGuidance({
      scenarioName: 'X', positionIds: P, weights: { P1: 40, P2: 30, P3: 20, P4: 10 },
      // The k=1 rung: raised above the Hall-safe vector below it.
      chosen: { P1: 95, P2: 93, P3: 94, P4: 92 },
      ceiling: { P1: 92, P2: 92, P3: 92, P4: 92 },
      readings: readings(), crews: 1,
    })
    for (const r of g.roles) expect(r.expected).toBeGreaterThanOrEqual(r.floor)
  })

  it('blends toward what this role could reach at the chosen crew count', () => {
    // Two crews: the 2nd-highest reading for the role is 94, so a seat could
    // realistically hold 94 while still fielding two crews.
    const g = publishGuidance({
      scenarioName: 'X', positionIds: P, weights: { P1: 40, P2: 30, P3: 20, P4: 10 },
      chosen: { P1: 90, P2: 90, P3: 90, P4: 90 },
      ceiling: { P1: 92, P2: 92, P3: 92, P4: 92 },
      readings: readings(), crews: 2,
    })
    const p1 = g.roles.find((r) => r.positionId === 'P1')
    expect(p1.ceiling).toBe(94)
    expect(p1.expected).toBe(92)        // 90 + 0.5 x (94 - 90)
  })

  it('falls back to the supplied ceiling when no crew count is given', () => {
    const g = publishGuidance({
      scenarioName: 'X', positionIds: P, weights: { P1: 40, P2: 30, P3: 20, P4: 10 },
      chosen: { P1: 80, P2: 80, P3: 80, P4: 80 },
      ceiling: { P1: 90, P2: 90, P3: 90, P4: 90 },
      readings: readings(),
    })
    expect(g.roles.find((r) => r.positionId === 'P1').expected).toBe(85)
  })
})

// ⚠️ #716 — the table must not contradict the number beside it.
//
// Live on tnl: Picklock 2 published `0`, "model used" 83, "can fill" 47 of 69.
// MonChoon: "if it was truly at the floor then wouldn't it have 69 of 69 that
// can fill the crime at the floor?" Exactly right — the guidance and the E(X)
// were describing different crews.
describe('publishGuidance — a carry role reads consistently', () => {
  const P = ['P1', 'P2', 'P3', 'P4']
  const WEIGHTS = { P1: 34.6, P2: 30.0, P3: 32.5, P4: 2.9 }
  const readings = () => {
    const pool = Array.from({ length: 12 }, (_, i) => ({ member_id: `m${i}`, cpr: 95 - i }))
    return Object.fromEntries(P.map((p) => [p, pool.map((r) => ({ ...r }))]))
  }

  it('⚠️ everyone can fill a role scored at the roster floor', () => {
    const r = readings()
    const floor = Math.min(...r.P4.map((x) => x.cpr))
    const g = publishGuidance({
      scenarioName: 'X', positionIds: P, weights: WEIGHTS,
      chosen: { P1: 92, P2: 88, P3: 90, P4: floor },     // carry pinned, as the search now does
      ceiling: { P1: 95, P2: 93, P3: 94, P4: 95 },
      readings: r, crews: 1,
    })
    const carry = g.roles.find((x) => x.positionId === 'P4')
    expect(carry.isCarry).toBe(true)
    expect(carry.published).toBe(0)
    expect(carry.floor).toBe(floor)
    // The number MonChoon expected: everyone with a reading clears the floor.
    expect(carry.eligible).toBe(carry.readings)
  })

  it('⚠️ uses the same weight threshold the search pins on', () => {
    // If the table publishes zero for roles the search did not pin, the two
    // disagree again — which is the whole defect.
    const g = publishGuidance({
      scenarioName: 'X', positionIds: P, weights: WEIGHTS,
      chosen: { P1: 92, P2: 88, P3: 90, P4: 84 },
      ceiling: { P1: 95, P2: 93, P3: 94, P4: 95 }, readings: readings(), crews: 1,
    })
    expect(g.roles.filter((r) => r.isCarry).map((r) => r.positionId)).toEqual(['P4'])
  })
})

// #729 — a threshold that fields no crew is not a high bar, it is a crime you
// have stopped running.
//
// Forge's Break the Bank falls from 3 crews to 0 between a uniform 72 and 75,
// and it is the highest earner on the roster at $9.79M per person-day. The
// per-role "can fill" counts cannot be composed into this by eye: the eligible
// sets OVERLAP, so six roles with nine candidates each may still seat only one
// crew.
describe('crew depth', () => {
  /** n members per role, all at `cpr`, sharing ids across roles when `shared`. */
  const pool = (positions, count, cpr, { shared = false } = {}) =>
    Object.fromEntries(positions.map((p, pi) => [
      p, Array.from({ length: count }, (_, i) => ({
        member_id: shared ? `m${i}` : `m${pi}-${i}`, cpr,
      })),
    ]))

  const POS = ['P1', 'P2', 'P3']
  const base = (over = {}) => publishGuidance({
    scenarioName: 'Test', positionIds: POS,
    weights: { P1: 40, P2: 35, P3: 25 },
    chosen: { P1: 70, P2: 70, P3: 70 },
    readings: pool(POS, 9, 75),
    ...over,
  })

  it('reports how many crews the published vector can field', () => {
    const g = base()
    expect(g.depth.crews).toBe(9)
    expect(g.depth.collapses).toBe(false)
  })

  it('⚠️ counts DISJOINT crews — a shared pool is not nine crews', () => {
    // Nine people who can each fill all three roles seat three crews, not nine.
    // This is the `ocRosterFit.js` gap that its own comment warns about.
    const g = base({ readings: pool(POS, 9, 75, { shared: true }) })
    expect(g.depth.crews).toBe(3)
  })

  it('⚠️ flags a vector that cannot crew the crime at all', () => {
    const thin = pool(POS, 9, 75)
    thin.P2 = [{ member_id: 'x', cpr: 60 }]        // nobody clears 70
    const g = base({ readings: thin })
    expect(g.depth.crews).toBe(0)
    expect(g.depth.collapses).toBe(true)
    expect(g.depth.limitingRoles).toContain('P2')
  })

  it('shows the cliff one CPR point up', () => {
    const rows = pool(POS, 9, 75)
    rows.P3 = [
      ...Array.from({ length: 3 }, (_, i) => ({ member_id: `hi${i}`, cpr: 75 })),
      ...Array.from({ length: 6 }, (_, i) => ({ member_id: `lo${i}`, cpr: 70 })),
    ]
    const g = base({ readings: rows })
    expect(g.depth.crews).toBe(9)
    expect(g.depth.atPlusOne).toBe(3)     // the 70s drop out at 71
  })

  it('⚠️ scores the vector the MODEL used, not the published one', () => {
    // A carry role publishes 0. Counting crews at 0 would say everyone can fill
    // it and report a depth the crime does not have — the #716 defect again.
    const rows = pool(POS, 9, 75)
    rows.P3 = Array.from({ length: 9 }, (_, i) => ({ member_id: `c${i}`, cpr: 40 }))
    const g = base({
      weights: { P1: 55, P2: 43, P3: 2 },          // P3 is a carry
      chosen: { P1: 70, P2: 70, P3: 60 },
      readings: rows,
    })
    expect(g.roles.find((r) => r.positionId === 'P3').published).toBe(0)
    // Nobody clears the 60 the model scored at, so the crime seats nobody.
    expect(g.depth.crews).toBe(0)
    expect(g.depth.collapses).toBe(true)
  })

  it('is absent rather than zero when there are no readings', () => {
    const g = base({ readings: {} })
    expect(g.depth.crews).toBeNull()
    expect(g.depth.collapses).toBe(false)
  })
})
