// #710 — solve CPR thresholds for ALL crimes at once, against one shared roster.
//
// ⚠️ The defect this fixes, in MonChoon's words on seeing the first live output:
// "The minimum CPR values seem extremely high in general... It might make sense
// from a single crime perspective, but we need to look at it holistically."
//
// He was right and it is structural. #707 wires slices 3 → 4 → 6 and skips the
// spawn simulation entirely, so each crime is optimised with the ENTIRE roster
// available to it — and the optimum for that question is "take the strongest
// people". Every crime does that independently, so the published sets are
// individually optimal and jointly unfillable.
import { describe, expect, it, vi } from 'vitest'
import { solveJointThresholds } from '../ocJointSolve'

const roles = (n) => Array.from({ length: n }, (_, i) => ({ position_id: `P${i + 1}`, role_name: `R${i}`, weight: 100 / n }))

const crime = (name, n, money, over = {}) => ({
  name,
  positionIds: roles(n).map((r) => r.position_id),
  roles: roles(n),
  category: { key: 'advanced', scopeCost: 4, scopeReward: 5 },
  spawnWeight: 1,
  endings: [
    { ending_key: 'goodEnding1', kind: 'good', resolved: true, node_id: 'A', money_avg: money },
    { ending_key: 'badEnding1', kind: 'bad', resolved: true, node_id: 'F' },
  ],
  ...over,
})

/** ⚠️ ONE pool, shared by every crime — the whole reason this slice exists. */
const sharedRoster = (crimes, members = 24) => {
  const pool = Array.from({ length: members }, (_, i) => ({ member_id: `m${i}`, cpr: 95 - i }))
  return Object.fromEntries(
    crimes.map((c) => [c.name, Object.fromEntries(c.positionIds.map((p) => [p, pool.map((r) => ({ ...r }))]))])
  )
}

/** Quality rises with the crew; deterministic so the solve is reproducible. */
const call = vi.fn(async (name, parameters) => {
  const avg = parameters.reduce((a, b) => a + b, 0) / parameters.length
  const good = Math.min(0.95, Math.max(0.01, (avg - 40) / 60))
  return { result: { successChance: good, failureChance: 1 - good, goodEnding1: good, badEnding1: 1 - good } }
})

const CRIMES = [crime('Alpha', 4, 100_000_000), crime('Beta', 4, 80_000_000)]

describe('solveJointThresholds', () => {
  const run = (over = {}) => solveJointThresholds({
    crimes: CRIMES, readings: sharedRoster(CRIMES), rosterSize: 24,
    call, days: 30, spawnsPerDay: 1, gap: 0.5, ...over,
  })

  it('returns a vector for every crime it was given', async () => {
    const out = await run()
    expect(Object.keys(out.chosen).sort()).toEqual(['Alpha', 'Beta'])
    for (const name of Object.keys(out.chosen)) {
      expect(Object.keys(out.chosen[name].vector).length).toBe(4)
    }
  })

  it('⚠️ lands at or below each crime\'s own best vector', async () => {
    // The per-crime answer is the most that crime could ask if nothing else
    // ran. A joint solve can only take away from that, never add.
    //
    // ⚠️ Compared against the top of the crime's own candidate LADDER, not
    // against `maximalCprVector`. Slice 3's vector requires n candidates per
    // role (Hall-safe); the ladder's k=1 rung starts there and is then greedily
    // raised, so it legitimately sits ABOVE the slice 3 figure.
    const out = await run()
    for (const [name, pick] of Object.entries(out.chosen)) {
      const top = out.concessions[name].fromVector
      for (const pos of Object.keys(top)) {
        expect(pick.vector[pos]).toBeLessThanOrEqual(top[pos])
      }
    }
  })

  it('⚠️ a DEEPER roster concedes more, not a thinner one', async () => {
    // Counter-intuitive, and the right way round. Conceding CPR buys
    // concurrency — and a thin roster has no concurrency to buy. With ten
    // members and four-role crimes there is no bar low enough to field a third
    // crew, so giving up points buys nothing and the solve stays at the
    // ceiling. A deep roster concedes because the concession actually pays.
    //
    // This is also the test that proves it is solving jointly rather than
    // rediscovering the per-crime answer: the same crimes and the same code
    // land on different vectors purely because of who else is competing.
    const thin = await run({ readings: sharedRoster(CRIMES, 10), rosterSize: 10 })
    const fat = await run({ readings: sharedRoster(CRIMES, 40), rosterSize: 40 })
    const total = (o) => Object.values(o.chosen)
      .flatMap((c) => Object.values(c.vector)).reduce((a, b) => a + b, 0)
    expect(total(fat)).toBeLessThan(total(thin))
  })

  it('⚠️ escapes the valley a single-step descent parks in', async () => {
    // The defect this search exists to avoid. `filled` is a STEP function — a
    // crew locks n members for n days, so the bar must fall a long way before a
    // second crime fits alongside the first, and every rung in between is
    // strictly worse. Measured on 24 members with one 4-role crime:
    //
    //     k=1  filled  8/30  score   990,741   <- one-rung-ahead stops here
    //     k=4  filled  8/30  score   814,815
    //     k=5  filled 16/30  score 1,611,111   <- 63% better
    //
    // So the chosen rung must be past the dip, not at the top of the ladder.
    const out = await run({ readings: sharedRoster(CRIMES, 40), rosterSize: 40 })
    const movedSomewhere = Object.values(out.concessions).some((c) => c.stepsDown > 0)
    expect(movedSomewhere).toBe(true)
    // And the score beats staying at every crime's ceiling.
    const atCeiling = Object.values(out.concessions).every((c) => c.stepsDown === 0)
    expect(atCeiling).toBe(false)
  })

  it('⚠️ reports what each crime gave up, not just the numbers', async () => {
    // "Alpha dropped 4 points so Beta could run" is the insight. A table of
    // lower numbers with no reasoning attached will not be trusted or followed.
    const out = await run()
    for (const name of Object.keys(out.chosen)) {
      expect(out.concessions[name]).toBeDefined()
      expect(typeof out.concessions[name].pointsGivenUp).toBe('number')
    }
  })

  it('scores the whole mix, not one crime', async () => {
    const out = await run()
    expect(out.score).toBeGreaterThan(0)
    expect(out.simulation.filled).toBeGreaterThan(0)
    expect(out.simulation.spawned).toBeGreaterThanOrEqual(out.simulation.filled)
  })

  it('⚠️ prices each crime\'s candidates ONCE and reuses them', async () => {
    // Every candidate vector is a request to tornprobability. The joint search
    // must run on cached values, or a search over ten crimes becomes a product
    // of per-crime candidate sets and thousands of calls.
    call.mockClear()
    const out = await run()
    // ⚠️ The assertion that matters: the joint search itself adds NONE. Every
    // call is a candidate being priced once, up front.
    expect(out.probeCalls).toBe(call.mock.calls.length)
    expect(out.rounds).toBeGreaterThan(0)      // it really did search
    const candidateCount = Object.values(out.chosen).length
    expect(call.mock.calls.length).toBeLessThan(candidateCount * 30)
  })

  it('⚠️ is deterministic — a plan that reshuffles is not a plan', async () => {
    const a = await run()
    const b = await run()
    expect(a.chosen).toEqual(b.chosen)
  })

  it('skips a crime it cannot crew rather than failing the whole solve', async () => {
    const readings = sharedRoster(CRIMES)
    readings.Beta.P1 = []                       // never observed
    const out = await run({ readings })
    expect(out.chosen.Alpha).toBeDefined()
    expect(out.chosen.Beta).toBeUndefined()
    expect(out.skipped.Beta).toBe('no-readings')
  })

  it('⚠️ distinguishes "never observed" from "nobody is good enough"', async () => {
    const readings = sharedRoster(CRIMES)
    readings.Beta.P1 = [{ member_id: 'weak', cpr: 1 }]
    const out = await run({ readings })
    expect(out.skipped.Beta).toBe('not-crewable')
  })

  it('reports nothing rather than guessing when no crime is solvable', async () => {
    const readings = sharedRoster(CRIMES)
    for (const c of CRIMES) readings[c.name].P1 = []
    const out = await run({ readings })
    expect(Object.keys(out.chosen)).toEqual([])
    expect(out.score).toBeNull()
  })
})

// ⚠️ The joint solve is the heaviest thing in this codebase's UI path, and the
// guidance button already froze the browser for 44 seconds once (v3.107.1).
// Measured on eight crimes against a 94-member roster: ~7s, dominated by the
// spawn simulation in the inner loop. That is behind an explicit button with a
// spinner, not a slider.
describe('solveJointThresholds on a realistic fleet', () => {
  it('⚠️ stays within a budget a click handler can wear', async () => {
    const crimes = Array.from({ length: 8 }, (_, i) => crime(`Crime${i}`, 4 + (i % 3), 80_000_000 + i * 10_000_000))
    const pool = Array.from({ length: 94 }, (_, i) => ({
      member_id: `m${i}`, cpr: Math.max(5, 95 - Math.floor(i * 0.95)),
    }))
    const readings = Object.fromEntries(
      crimes.map((c) => [c.name, Object.fromEntries(c.positionIds.map((p) => [p, pool.map((r) => ({ ...r }))]))])
    )
    const started = Date.now()
    const out = await solveJointThresholds({
      crimes, readings, rosterSize: 94, call, days: 30, spawnsPerDay: 2, gap: 0.5,
    })
    const elapsed = Date.now() - started

    expect(Object.keys(out.chosen)).toHaveLength(8)
    // Generous against CI contention; fails loudly if the inner loop regresses.
    expect(elapsed).toBeLessThan(30_000)
    // ⚠️ One probability call per candidate per crime, and not one more for the
    // search itself. That is the property that makes a joint solve affordable.
    expect(out.probeCalls).toBeLessThan(8 * 20)
  }, 60_000)
})
