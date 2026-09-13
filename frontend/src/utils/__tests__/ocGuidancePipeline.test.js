// #707 — chaining the six slices of #688 into one answer for one crime.
//
// ⚠️ Every probe call is a request to tornprobability, a small third-party
// server this codebase already counts calls against. Several of these tests
// count them.
import { describe, expect, it, vi } from 'vitest'
import { computeGuidance, makeProbe } from '../ocGuidancePipeline'

const ROLES = [
  { position_id: 'P1', role_name: 'Muscle', weight: 34.6 },
  { position_id: 'P2', role_name: 'Engineer', weight: 30.0 },
  { position_id: 'P3', role_name: 'Bomber', weight: 32.5 },
  { position_id: 'P4', role_name: 'Picklock 2', weight: 2.9 },
]

const ENDINGS = [
  { ending_key: 'goodEnding1', kind: 'good', resolved: true, node_id: 'A', money_avg: 100_000_000 },
  { ending_key: 'goodEnding2', kind: 'good', resolved: true, node_id: 'B', money_avg: 40_000_000 },
  { ending_key: 'badEnding1', kind: 'bad', resolved: true, node_id: 'F' },
]

const SCENARIO = { name: 'Test Crime', roles: ROLES, endings: ENDINGS }

const readings = (n = 12) => {
  const pool = Array.from({ length: n }, (_, i) => ({ member_id: `m${i}`, cpr: 95 - i }))
  return Object.fromEntries(ROLES.map((r) => [r.position_id, pool.map((x) => ({ ...x }))]))
}

const rosterCpr = (n = 12) => ({ readings: readings(n), roster_size: 40 })
const CATEGORY = { scopeCost: 4, scopeReward: 5 }

/** A raw CalculateSuccess response whose quality rises with the crew. */
const rawFor = (parameters) => {
  const avg = parameters.reduce((a, b) => a + b, 0) / parameters.length
  const good = Math.min(0.95, Math.max(0, (avg - 50) / 50))
  return {
    successChance: good,
    failureChance: 1 - good,
    goodEnding1: good * 0.7,
    goodEnding2: good * 0.3,
    badEnding1: 1 - good,
    // ⚠️ Padding the model does not know, at exactly zero — the shape the live
    // service really returns (verified 2026-09-12).
    goodEnding9: 0,
  }
}

describe('makeProbe', () => {
  it('⚠️ converts a keyed vector to the positional array the API expects', async () => {
    // The API takes parameters indexed P1..PN; the modules work in keyed
    // vectors. Getting this wrong produces a plausible number for a crew
    // nobody is running — the #390 hazard, in a new place.
    const calls = []
    const probe = makeProbe({
      scenario: SCENARIO,
      call: async (name, parameters) => { calls.push(parameters); return rawFor(parameters) },
    })
    await probe({ P3: 80, P1: 95, P4: 60, P2: 70 })
    expect(calls[0]).toEqual([95, 70, 80, 60])
  })

  it('prices the response with the same payout logic the Simulator uses', async () => {
    const probe = makeProbe({ scenario: SCENARIO, call: async (n, p) => rawFor(p) })
    const out = await probe({ P1: 100, P2: 100, P3: 100, P4: 100 })
    // good = 0.95 → 0.665 x 100M + 0.285 x 40M
    expect(out.expectedValue).toBeCloseTo(0.665 * 100_000_000 + 0.285 * 40_000_000, 0)
    expect(out.successChance).toBeCloseTo(0.95, 6)
  })

  it('⚠️ reports an unpriceable crew as absent, never as zero', async () => {
    const probe = makeProbe({
      scenario: { ...SCENARIO, endings: [] },      // no payout coverage at all
      call: async (n, p) => rawFor(p),
    })
    const out = await probe({ P1: 90, P2: 90, P3: 90, P4: 90 })
    expect(out.expectedValue).toBeNull()
  })

  it('survives the probability service being unreachable', async () => {
    const probe = makeProbe({ scenario: SCENARIO, call: async () => { throw new Error('502') } })
    const out = await probe({ P1: 90, P2: 90, P3: 90, P4: 90 })
    expect(out.expectedValue).toBeNull()
    expect(out.successChance).toBeNull()
  })
})

describe('computeGuidance', () => {
  const run = (over = {}) => computeGuidance({
    scenario: SCENARIO, rosterCpr: rosterCpr(), category: CATEGORY,
    call: async (n, p) => rawFor(p),
    now: () => '2026-09-12T00:00:00.000Z',
    ...over,
  })

  it('produces a publishable table end to end', async () => {
    const out = await run()
    expect(out.guidance.publishable).toBe(true)
    expect(out.guidance.roles).toHaveLength(4)
    expect(out.guidance.roles[0].roleName).toBe('Muscle')     // ordered by weight
    expect(out.guidance.roles.find((r) => r.positionId === 'P4').published).toBe(0)
  })

  it('⚠️ stays inside a call budget', async () => {
    const call = vi.fn(async (n, p) => rawFor(p))
    const out = await run({ call })
    expect(call.mock.calls.length).toBeLessThanOrEqual(10)
    expect(out.probeCalls).toBe(call.mock.calls.length)
  })

  it('⚠️ prices BOTH the floor and the expected crew', async () => {
    // The floor is what we publish; the expected crew is what turns up. A table
    // showing only the floor understates the crime.
    const out = await run()
    expect(out.guidance.value.floor).toBeGreaterThan(0)
    expect(out.guidance.value.expected).toBeGreaterThan(out.guidance.value.floor)
    expect(out.guidance.value.uplift).toBeGreaterThan(0)
  })

  it('⚠️ says "never observed" rather than "impossible"', async () => {
    // forge's current state on several roles. A measurement gap must not render
    // as an infeasible crime (#351).
    const r = rosterCpr()
    r.readings.P3 = []
    const out = await run({ rosterCpr: r })
    expect(out.guidance.publishable).toBe(false)
    expect(out.reason).toBe('no-readings')
    expect(out.limitingRoles).toEqual(['P3'])
  })

  it('distinguishes a roster that is simply not good enough', async () => {
    const r = rosterCpr()
    r.readings.P3 = [{ member_id: 'weak', cpr: 5 }]
    const out = await run({ rosterCpr: r })
    expect(out.guidance.publishable).toBe(false)
    expect(out.reason).toBe('not-crewable')
  })

  it('⚠️ does not invent a table when the probability service is down', async () => {
    const out = await run({ call: async () => { throw new Error('502') } })
    expect(out.guidance.publishable).toBe(false)
    expect(out.reason).toBe('no-expected-value')
  })

  it('carries the assumptions through to the table', async () => {
    const out = await run({ gap: 0.5, gapIsAssumed: true })
    expect(out.guidance.assumptions.some((a) => /12h/.test(a))).toBe(true)
    expect(out.guidance.assumptions.some((a) => /40/.test(a))).toBe(true)
  })

  it('is deterministic for the same roster', async () => {
    const a = await run()
    const b = await run()
    expect(a.guidance).toEqual(b.guidance)
  })
})

// ⚠️ A chain crime pays no money or items at all — every good ending spawns the
// NEXT crime. Stacking the Deck → Ace in the Hole is the documented case, and
// the Simulator reported it as "4 endings unpriced", which reads as a data gap
// and sends somebody hunting a number that does not exist.
describe('computeGuidance — chain crimes', () => {
  const CHAINED = {
    name: 'Stacking the Deck',
    roles: ROLES,
    endings: [
      { ending_key: 'goodEnding1', kind: 'good', resolved: true, node_id: 'A', money_avg: null, reward: { money: null, chainsTo: 'Ace in the Hole' } },
      { ending_key: 'goodEnding2', kind: 'good', resolved: true, node_id: 'B', money_avg: null, reward: { money: null, chainsTo: 'Ace in the Hole' } },
      { ending_key: 'badEnding1', kind: 'bad', resolved: true, node_id: 'F' },
    ],
  }

  it('⚠️ names the crime it chains into instead of calling it unpriced', async () => {
    const call = vi.fn(async (n, p) => rawFor(p))
    const out = await computeGuidance({
      scenario: CHAINED, rosterCpr: rosterCpr(), category: CATEGORY, call,
      now: () => '2026-09-13T00:00:00.000Z',
    })
    expect(out.reason).toBe('chains')
    expect(out.chainsTo).toBe('Ace in the Hole')
  })

  it('⚠️ spends NO probability calls on it', async () => {
    // Detected before the search: probing a crime with no money of its own
    // burns calls on a small third-party server to learn nothing.
    const call = vi.fn(async (n, p) => rawFor(p))
    await computeGuidance({
      scenario: CHAINED, rosterCpr: rosterCpr(), category: CATEGORY, call,
      now: () => '2026-09-13T00:00:00.000Z',
    })
    expect(call).not.toHaveBeenCalled()
  })

  it('still prices a crime that chains AND pays', async () => {
    // If a chain link ever pays something of its own, that is a real number and
    // must not be discarded by the shortcut above.
    const both = {
      ...CHAINED,
      endings: [
        { ending_key: 'goodEnding1', kind: 'good', resolved: true, node_id: 'A', money_avg: 5_000_000, reward: { money: 5_000_000, chainsTo: 'Ace in the Hole' } },
        { ending_key: 'badEnding1', kind: 'bad', resolved: true, node_id: 'F' },
      ],
    }
    const out = await computeGuidance({
      scenario: both, rosterCpr: rosterCpr(), category: CATEGORY,
      call: async (n, p) => rawFor(p), now: () => '2026-09-13T00:00:00.000Z',
    })
    expect(out.reason).not.toBe('chains')
  })
})
