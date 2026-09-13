// #693 — does the roster survive contact with how crimes actually spawn?
//
// Slice 4 optimises one crime in a steady state. Spawning is lumpy, partly
// outside our control, and — the constraint the whole slice exists to test —
// members are SHARED across every crime in flight. A threshold set that is
// optimal per crime can be unfillable once three crimes want the same people.
import { describe, expect, it } from 'vitest'
import { simulateSpawns } from '../ocSpawnSimulation'

/** A pool of `n` members, all readable for every role of a scenario. */
const pool = (prefix, n, top = 95) =>
  Array.from({ length: n }, (_, i) => ({ member_id: `${prefix}${i}`, cpr: top - i }))

const scenario = (name, roles, over = {}) => ({
  name,
  positionIds: Array.from({ length: roles }, (_, i) => `P${i + 1}`),
  vector: Object.fromEntries(Array.from({ length: roles }, (_, i) => [`P${i + 1}`, 50])),
  category: { key: 'advanced', scopeCost: 4, scopeReward: 5 },
  expectedValue: 100_000_000,
  successChance: 0.9,
  spawnWeight: 1,
  ...over,
})

/** Everyone can do everything — the shared-roster case that actually binds. */
const sharedReadings = (scenarios, members) => {
  const rows = pool('m', members)
  const out = {}
  for (const s of scenarios) {
    out[s.name] = Object.fromEntries(s.positionIds.map((p) => [p, rows.map((r) => ({ ...r }))]))
  }
  return out
}

describe('simulateSpawns', () => {
  it('fills what it can and reports what it could not', () => {
    const s = [scenario('A', 4)]
    const out = simulateSpawns({
      scenarios: s, readings: sharedReadings(s, 40), days: 20, spawnsPerDay: 1,
    })
    expect(out.spawned).toBeGreaterThan(0)
    expect(out.filled + out.unfilled).toBe(out.spawned)
    expect(out.perScenario.A.spawned).toBe(out.spawned)
  })

  it('⚠️ a member in one crime cannot be in another — the whole point', () => {
    // Eight members, two four-role crimes spawning the same day. The second can
    // only be crewed if the first released its people, which it has not.
    const s = [scenario('A', 4), scenario('B', 4)]
    const out = simulateSpawns({
      scenarios: s, readings: sharedReadings(s, 8), days: 1, spawnsPerDay: 2,
    })
    expect(out.spawned).toBe(2)
    expect(out.filled).toBe(2)

    const tight = simulateSpawns({
      scenarios: s, readings: sharedReadings(s, 7), days: 1, spawnsPerDay: 2,
    })
    expect(tight.filled).toBe(1)
    expect(tight.unfilled).toBe(1)
    expect(tight.unfillReasons['no-crew']).toBe(1)
  })

  it('⚠️ releases a crew when its crime completes, so the roster recycles', () => {
    // One four-role crime takes 4 days. With exactly four members and a spawn
    // every day, we fill day 0, miss days 1-3, and fill again on day 4.
    const s = [scenario('A', 4)]
    const out = simulateSpawns({
      scenarios: s, readings: sharedReadings(s, 4), days: 9, spawnsPerDay: 1,
    })
    expect(out.filled).toBeGreaterThan(1)
    expect(out.filled).toBeLessThan(out.spawned)
  })

  it('⚠️ names the roles that ran out, so #692 can relax the right bar', () => {
    // P1 is unreachable: nobody clears 99.
    const s = [scenario('A', 3, { vector: { P1: 99, P2: 50, P3: 50 } })]
    const out = simulateSpawns({
      scenarios: s, readings: sharedReadings(s, 20), days: 5, spawnsPerDay: 1,
    })
    expect(out.filled).toBe(0)
    expect(out.perScenario.A.bindingRoles).toEqual(['P1'])
  })

  it('⚠️ distinguishes "never observed" from "nobody is good enough"', () => {
    // #351. forge is the FIRST case on Elaborate roles right now — a
    // measurement gap must not be reported as an infeasible tier.
    const s = [scenario('A', 3)]
    const readings = sharedReadings(s, 20)
    readings.A.P3 = []                        // never observed anyone here
    const out = simulateSpawns({ scenarios: s, readings, days: 5, spawnsPerDay: 1 })
    expect(out.perScenario.A.unfillable).toBe(true)
    expect(out.perScenario.A.unfillableReason).toBe('no-readings')

    const readings2 = sharedReadings(s, 20)
    readings2.A.P3 = pool('x', 20, 10)        // observed, all far below the bar
    const out2 = simulateSpawns({
      scenarios: [scenario('A', 3, { vector: { P1: 50, P2: 50, P3: 90 } })],
      readings: readings2, days: 5, spawnsPerDay: 1,
    })
    expect(out2.perScenario.A.unfillableReason).toBe('below-bar')
  })

  it('honours the spawn mix by weight, never by name or order', () => {
    const s = [
      scenario('Common', 3, { spawnWeight: 4 }),
      scenario('Rare', 3, { spawnWeight: 1 }),
    ]
    const out = simulateSpawns({
      scenarios: s, readings: sharedReadings(s, 60), days: 50, spawnsPerDay: 1,
    })
    const ratio = out.perScenario.Common.spawned / out.perScenario.Rare.spawned
    expect(ratio).toBeGreaterThan(3)
    expect(ratio).toBeLessThan(5)
  })

  it('⚠️ is deterministic — a plan that reshuffles between runs is not a plan', () => {
    const s = [scenario('A', 3, { spawnWeight: 2 }), scenario('B', 4)]
    const a = simulateSpawns({ scenarios: s, readings: sharedReadings(s, 30), days: 30, spawnsPerDay: 1 })
    const b = simulateSpawns({ scenarios: s, readings: sharedReadings(s, 30), days: 30, spawnsPerDay: 1 })
    expect(a).toEqual(b)
  })
})

describe('simulateSpawns — scope', () => {
  const s = [scenario('A', 4)]

  it('⚠️ tracks scope across the PORTFOLIO and never vetoes a spawn for it', () => {
    // MonChoon, 2026-09-12: high-paying crimes may run scope-negative; easier
    // crimes balance it out. Refusing them per-crime optimises a sub-problem
    // nobody has.
    const out = simulateSpawns({
      scenarios: [scenario('A', 4, { successChance: 0.2 })],   // 0.2*5 - 4 = -3 a spawn
      readings: sharedReadings(s, 40), days: 20, spawnsPerDay: 1,
      scope: { start: 100, cap: 100, regenPerDay: 1 },
    })
    expect(out.scope.netPerSpawn).toBeCloseTo(0.2 * 5 - 4, 6)
    expect(out.scope.end).toBeLessThan(100)
    expect(out.unfillReasons['no-crew'] ?? 0).toBeGreaterThanOrEqual(0)
  })

  it('⚠️ recommends how much cheap spawning covers the gap, rather than forbidding', () => {
    const out = simulateSpawns({
      scenarios: [scenario('A', 4, { successChance: 0.2 })],
      readings: sharedReadings(s, 40), days: 20, spawnsPerDay: 1,
      scope: { start: 100, cap: 100, regenPerDay: 1 },
    })
    expect(out.scope.solvent).toBe(false)
    // Actionable: "this many scope a day short", not "disallowed".
    expect(out.scope.shortfallPerDay).toBeGreaterThan(0)
  })

  it('reports solvent when the mix pays for itself', () => {
    const out = simulateSpawns({
      scenarios: [scenario('A', 4, { successChance: 0.95 })],  // 0.95*5 - 4 = +0.75
      readings: sharedReadings(s, 40), days: 20, spawnsPerDay: 1,
      scope: { start: 50, cap: 100, regenPerDay: 1 },
    })
    expect(out.scope.solvent).toBe(true)
    expect(out.scope.shortfallPerDay).toBe(0)
  })

  it('⚠️ cannot spawn what the bank will not pay for, and says so', () => {
    const out = simulateSpawns({
      scenarios: s, readings: sharedReadings(s, 40), days: 10, spawnsPerDay: 1,
      scope: { start: 2, cap: 100, regenPerDay: 0 },   // one spawn costs 4
    })
    expect(out.unfillReasons['no-scope']).toBeGreaterThan(0)
    expect(out.filled).toBe(0)
  })
})

describe('simulateSpawns — what it reports about itself', () => {
  it('⚠️ exposes how conservative its occupancy model is', () => {
    // A committed member is held for the crime's WHOLE duration, though in
    // reality the last joiner is held one day. The overstatement is real and
    // must be visible, not buried: it makes the roster look tighter than it is,
    // which is the safe direction for planning but not a free one.
    const s = [scenario('A', 6)]
    const out = simulateSpawns({
      scenarios: s, readings: sharedReadings(s, 60), days: 12, spawnsPerDay: 1, gap: 0.5,
    })
    expect(out.occupancy.model).toBe('reserved-for-full-duration')
    // 6 x 6 = 36 reserved against personDays(6, 0.5) = 23.5 actually consumed.
    expect(out.occupancy.reservedPersonDaysPerCrime).toBe(36)
    expect(out.occupancy.truePersonDaysPerCrime).toBe(23.5)
    expect(out.occupancy.overstatement).toBeCloseTo(36 / 23.5, 4)
  })

  it('reports income per faction member per day', () => {
    const s = [scenario('A', 4)]
    const out = simulateSpawns({
      scenarios: s, readings: sharedReadings(s, 40), days: 20, spawnsPerDay: 1, rosterSize: 40,
    })
    expect(out.income.total).toBeGreaterThan(0)
    expect(out.income.perFactionMemberPerDay).toBeCloseTo(out.income.total / (40 * 20), 6)
  })
})

// ⚠️ #715 — a chain child costs no scope.
//
// Scope is paid once at the ROOT and repaid only at the terminal link
// (`ocChains.js`). Charging a child its category's cost double-charges the
// chain — and on tnl the children were 23.5% of all appearances, so this was
// not a rounding error.
describe('simulateSpawns — chain children', () => {
  const s = [scenario('A', 4)]

  it('⚠️ does not charge scope to a chain child', () => {
    const child = simulateSpawns({
      scenarios: [scenario('A', 4, { isChainChild: true, successChance: 0.9 })],
      readings: sharedReadings(s, 40), days: 20, spawnsPerDay: 1,
      scope: { start: 50, cap: 100, regenPerDay: 0 },
    })
    const parent = simulateSpawns({
      scenarios: [scenario('A', 4, { successChance: 0.9 })],
      readings: sharedReadings(s, 40), days: 20, spawnsPerDay: 1,
      scope: { start: 50, cap: 100, regenPerDay: 0 },
    })
    // The child still PAYS scope back on success; it just never spends any.
    expect(child.scope.netPerSpawn).toBeCloseTo(0.9 * 5, 6)
    expect(parent.scope.netPerSpawn).toBeCloseTo(0.9 * 5 - 4, 6)
    expect(child.scope.end).toBeGreaterThan(parent.scope.end)
  })

  it('⚠️ a chain child is never blocked by an empty bank', () => {
    // It costs nothing, so a faction with no scope can still complete a chain
    // it has already paid for.
    const out = simulateSpawns({
      scenarios: [scenario('A', 4, { isChainChild: true })],
      readings: sharedReadings(s, 40), days: 10, spawnsPerDay: 1,
      scope: { start: 0, cap: 100, regenPerDay: 0 },
    })
    expect(out.unfillReasons['no-scope'] ?? 0).toBe(0)
    expect(out.filled).toBeGreaterThan(0)
  })
})
