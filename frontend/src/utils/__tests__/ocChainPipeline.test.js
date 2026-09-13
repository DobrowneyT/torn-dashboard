// #712 — chain economics on the crime card.
//
// ⚠️ The number that matters is the scope break-even. Scope is paid once at the
// root and repaid only at the terminal link, only if every link succeeded, so
// the reward stays flat while the probability of collecting it compounds:
// Elaborate is 83.3% standalone but 91.3% PER LINK over two. A reader comparing
// a chain against the standalone line is comparing the wrong number.
import { describe, expect, it, vi } from 'vitest'
import { computeChainEconomics, meanCpr } from '../ocChainPipeline'

const roles = (n) => Array.from({ length: n }, (_, i) => ({ position_id: `P${i + 1}`, role_name: `R${i}`, weight: 100 / n }))
const scenario = (name, n, money) => ({
  name, roles: roles(n),
  endings: [
    { ending_key: 'goodEnding1', kind: 'good', resolved: true, node_id: 'A', money_avg: money,
      reward: money === null ? { money: null, chainsTo: 'Ace in the Hole' } : { money } },
    { ending_key: 'badEnding1', kind: 'bad', resolved: true, node_id: 'F' },
  ],
})

const SCENARIOS = [
  scenario('Stacking the Deck', 4, null),      // pays nothing — the chain IS the reward
  scenario('Ace in the Hole', 5, 500_000_000),
]
const CHAINS = [{ parent: 'Stacking the Deck', child: 'Ace in the Hole', observations: 124 }]

/** 90% success everywhere, so the compounding is easy to check by hand. */
const call = vi.fn(async () => ({
  result: { successChance: 0.9, failureChance: 0.1, goodEnding1: 0.9, badEnding1: 0.1 },
}))

const categoryOf = () => 'elaborate'

describe('meanCpr', () => {
  it('averages the crew on screen', () => {
    expect(meanCpr([60, 70, 80, 90])).toBe(75)
  })
  it('is absent for no crew rather than zero', () => {
    expect(meanCpr([])).toBeNull()
  })
})

describe('computeChainEconomics', () => {
  const run = (over = {}) => computeChainEconomics({
    rootName: 'Stacking the Deck', scenarios: SCENARIOS, chains: CHAINS,
    assumedCpr: 75, categoryOf, call, ...over,
  })

  it('⚠️ returns null for a crime that is not a chain', async () => {
    // Rendering a chain panel on an ordinary crime would tell the reader it has
    // economics it does not have.
    expect(await run({ rootName: 'Ace in the Hole' })).toBeNull()
  })

  it('walks the whole chain from the root', async () => {
    const out = await run()
    expect(out.links.map((l) => l.name)).toEqual(['Stacking the Deck', 'Ace in the Hole'])
    expect(out.confident).toBe(true)      // 124 observations
  })

  it('⚠️ compounds success across links', async () => {
    const out = await run()
    expect(out.chainedSuccess).toBeCloseTo(0.9 * 0.9, 6)
  })

  it('⚠️ values the chain at the terminal payout times the chance of reaching it', async () => {
    const out = await run()
    // reach = 0.9 x 0.9 = 0.81; root pays nothing, terminal pays 0.9 x 500M
    expect(out.value.expected).toBeCloseTo(0.81 * 0.9 * 500_000_000, 0)
    expect(out.value.complete).toBe(true)
  })

  it('⚠️ reports the per-link break-even, not the standalone one', async () => {
    // Elaborate costs 5, pays 6: standalone break-even is 83.3%, but over two
    // links each link must clear (5/6)^(1/2) = 91.3%.
    const out = await run()
    expect(out.scope.breakEvenPerLink).toBeCloseTo(Math.sqrt(5 / 6), 6)
    expect(out.scope.breakEvenPerLink).toBeGreaterThan(5 / 6)
  })

  it('⚠️ compares equivalent per-link success against that break-even', async () => {
    // The natural mistake is comparing the CHAINED probability (0.81) against a
    // per-link break-even (0.913), which makes every chain look doomed.
    const out = await run()
    expect(out.scope.equivalentSuccess).toBeCloseTo(0.9, 6)
    expect(out.scope.sustainable).toBe(false)   // 0.81 x 6 = 4.86 against a cost of 5
  })

  it('⚠️ spends one probability call per link and no more', async () => {
    call.mockClear()
    const out = await run()
    expect(out.probeCalls).toBe(2)
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('⚠️ reuses what the card already knows about the root', async () => {
    call.mockClear()
    const out = await run({
      known: { 'Stacking the Deck': { successChance: 0.5, expectedValue: null } },
    })
    expect(call).toHaveBeenCalledTimes(1)
    expect(out.chainedSuccess).toBeCloseTo(0.5 * 0.9, 6)
  })

  it('⚠️ flags an unobserved edge rather than presenting it as measured', async () => {
    // Only capacityx had seen all five edges; a tenant relying on the known
    // table must be told the link is unverified here.
    const out = await run({ chains: [] })   // falls back to KNOWN_CHAINS
    expect(out.links.map((l) => l.name)).toEqual(['Stacking the Deck', 'Ace in the Hole'])
    expect(out.confident).toBe(false)
  })

  it('⚠️ a terminal link we cannot price makes the chain a LOWER BOUND', async () => {
    // The other side of the same distinction: a parent paying nothing is a
    // known zero, but an unmeasured terminal makes the whole figure a floor.
    // Terminal pays money in principle but we have no figure — and it does NOT
    // chain onward, so this is a genuine measurement gap rather than a known zero.
    const unpricedTerminal = [SCENARIOS[0], {
      name: 'Ace in the Hole', roles: roles(5),
      endings: [
        { ending_key: 'goodEnding1', kind: 'good', resolved: true, node_id: 'A', money_avg: null, reward: { money: null, chainsTo: null } },
        { ending_key: 'badEnding1', kind: 'bad', resolved: true, node_id: 'F' },
      ],
    }]
    const out = await run({ scenarios: unpricedTerminal })
    expect(out.value.complete).toBe(false)
  })

  it('⚠️ reports a link it cannot price rather than valuing it at zero', async () => {
    const out = await run({ scenarios: [SCENARIOS[0]] })   // terminal missing
    expect(out.missing).toEqual(['Ace in the Hole'])
    expect(out.chainedSuccess).toBeNull()
  })
})

// #725 — the downstream crew comes from the ROSTER, not the sliders.
//
// `assumedCpr` was `meanCpr(sliders)`, and the sliders default to 50 until
// somebody drags them. Meanwhile tnl has 81-87 readings per role for Ace in the
// Hole showing a roster that sustains 70-75. The terminal link was priced ~22
// CPR below what the faction can actually field, which made the chain look far
// worse than it is — and the scope verdict is REPORTED, so the number has to be
// right rather than merely alarming.
describe('downstream links priced from their own readings', () => {
  const readings = {
    P1: [{ cpr: 70 }, { cpr: 70 }, { cpr: 70 }, { cpr: 70 }, { cpr: 70 }],
    P2: [{ cpr: 72 }, { cpr: 72 }, { cpr: 72 }, { cpr: 72 }, { cpr: 72 }],
    P3: [{ cpr: 72 }, { cpr: 72 }, { cpr: 72 }, { cpr: 72 }, { cpr: 72 }],
    P4: [{ cpr: 72 }, { cpr: 72 }, { cpr: 72 }, { cpr: 72 }, { cpr: 72 }],
    P5: [{ cpr: 75 }, { cpr: 75 }, { cpr: 75 }, { cpr: 75 }, { cpr: 75 }],
  }
  const seen = []
  const spy = vi.fn(async (name, parameters) => {
    seen.push({ name, parameters })
    return { result: { successChance: 0.9, failureChance: 0.1, goodEnding1: 0.9, badEnding1: 0.1 } }
  })

  const run = (over = {}) => computeChainEconomics({
    rootName: 'Stacking the Deck', scenarios: SCENARIOS, chains: CHAINS,
    assumedCpr: 50, categoryOf, call: spy, ...over,
  })

  it('probes the downstream link at its own maximal vector', async () => {
    seen.length = 0
    const out = await run({ vectorFor: async (name) => (name === 'Ace in the Hole' ? readings : null) })
    const ace = seen.find((s) => s.name === 'Ace in the Hole')
    // ⚠️ Positional, indexed P1..PN — the #390 hazard. 70/72/72/72/75, not 50s.
    expect(ace.parameters).toEqual([70, 72, 72, 72, 75])
    expect(out.crewByName['Ace in the Hole'].source).toBe('roster')
  })

  it('⚠️ falls back to the flat CPR when a link has no readings, and says so', async () => {
    // A tenant that has never run the terminal link must not silently inherit a
    // roster number it does not have.
    seen.length = 0
    const out = await run({ vectorFor: async () => null })
    const ace = seen.find((s) => s.name === 'Ace in the Hole')
    expect(ace.parameters).toEqual([50, 50, 50, 50, 50])
    expect(out.crewByName['Ace in the Hole'].source).toBe('assumed')
  })

  it('falls back when the readings cannot crew the link at all', async () => {
    // Four readings for a five-role crime: Hall's condition fails, so there is
    // no maximal vector to take. Absent beats confidently wrong.
    seen.length = 0
    const thin = { P1: [{ cpr: 70 }], P2: [{ cpr: 70 }], P3: [{ cpr: 70 }], P4: [{ cpr: 70 }], P5: [] }
    const out = await run({ vectorFor: async () => thin })
    expect(out.crewByName['Ace in the Hole'].source).toBe('assumed')
  })

  it('still costs exactly one probe per unknown link', async () => {
    // The call budget is the design constraint — pricing per candidate would
    // multiply it by the chain length.
    spy.mockClear()
    await run({ vectorFor: async () => readings })
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('behaves exactly as before when no resolver is supplied', async () => {
    seen.length = 0
    const out = await run()
    expect(seen.find((s) => s.name === 'Ace in the Hole').parameters).toEqual([50, 50, 50, 50, 50])
    expect(out.crewByName['Ace in the Hole'].source).toBe('assumed')
  })

  it('prices a better downstream crew as a better chain', async () => {
    // The whole point: the pessimism was an artefact of the slider default.
    const weak = vi.fn(async (_n, p) => ({
      result: { successChance: p[0] / 100, failureChance: 1 - p[0] / 100 },
    }))
    const flat = await run({ call: weak })
    const real = await run({ call: weak, vectorFor: async (n) => (n === 'Ace in the Hole' ? readings : null) })
    expect(real.chainedSuccess).toBeGreaterThan(flat.chainedSuccess)
    expect(real.scope.net).toBeGreaterThan(flat.scope.net)
  })
})
