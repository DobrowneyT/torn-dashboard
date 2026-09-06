import { describe, expect, it } from 'vitest'
import {
  KNOWN_CHAINS,
  MIN_OBSERVATIONS_FOR_CHAIN,
  buildChainIndex,
  chainFrom,
  chainConfident,
  chainedSuccess,
  chainedValue,
  chainBreakEven,
  chainedScope,
} from '../ocChains'

/** The real fleet chains, as derived from previous_crime_id across all tenants. */
const REAL_EDGES = [
  { parent: 'Stacking the Deck', child: 'Ace in the Hole', observations: 124 },
  { parent: 'Lock Stock', child: 'Hostile Takeover', observations: 34 },
  { parent: 'Manifest Cruelty', child: 'Gone Fission', observations: 8 },
  { parent: 'Gone Fission', child: 'Crane Reaction', observations: 7 },
  { parent: 'No Reserve', child: 'Bidding War', observations: 45 },
]

const ELABORATE = {
  'Manifest Cruelty': 'elaborate',
  'Gone Fission': 'elaborate',
  'Crane Reaction': 'elaborate',
  'Stacking the Deck': 'elaborate',
  'Ace in the Hole': 'elaborate',
}

describe('buildChainIndex', () => {
  it('finds the child of an observed parent', () => {
    const idx = buildChainIndex(REAL_EDGES)
    expect(idx.edge('Stacking the Deck')).toMatchObject({
      child: 'Ace in the Hole', observations: 124, source: 'observed',
    })
  })

  it('⚠️ falls back to the known table for a chain this faction has never run', () => {
    // Ascension had observed NO chains at all; Forge and Mayhem only No Reserve.
    // Without the fallback those factions price Manifest Cruelty at $0 purely
    // because they have not yet made the mistake of running it — which is the
    // exact bug this issue exists to fix.
    const idx = buildChainIndex([])
    expect(idx.edge('Manifest Cruelty')).toMatchObject({ child: 'Gone Fission', source: 'known' })
    expect(idx.edge('Gone Fission')).toMatchObject({ child: 'Crane Reaction', source: 'known' })
  })

  it('lets our own history win over the known table', () => {
    // If Torn rewires a chain, our data is what should notice — a hardcoded
    // table that outranks observation would keep asserting the old shape.
    const idx = buildChainIndex([{ parent: 'Lock Stock', child: 'Something New', observations: 12 }])
    expect(idx.edge('Lock Stock')).toMatchObject({ child: 'Something New', source: 'observed' })
  })

  it('marks a crime that only ever appears as a reward', () => {
    const idx = buildChainIndex(REAL_EDGES)
    expect(idx.isChild('Ace in the Hole')).toBe(true)
    expect(idx.isChild('Crane Reaction')).toBe(true)
    // Gone Fission is both: spawned by Manifest Cruelty, spawns Crane Reaction.
    expect(idx.isChild('Gone Fission')).toBe(true)
    expect(idx.isChild('Stacking the Deck')).toBe(false)
  })

  it('sums repeated observations of the same edge', () => {
    // Per-tenant rows for one edge are the same fact counted twice.
    const idx = buildChainIndex([
      { parent: 'No Reserve', child: 'Bidding War', observations: 45 },
      { parent: 'No Reserve', child: 'Bidding War', observations: 62 },
    ])
    expect(idx.edge('No Reserve').observations).toBe(107)
  })

  it('⚠️ keeps one child per parent and flags the contradiction rather than branching', () => {
    // Every parent in the real data maps to exactly one child. A second name
    // means a Torn change or bad data; modelling a branching chain would invent
    // a mechanic the game does not have.
    const idx = buildChainIndex([
      { parent: 'Lock Stock', child: 'Hostile Takeover', observations: 34 },
      { parent: 'Lock Stock', child: 'Impostor', observations: 2 },
    ])
    expect(idx.edge('Lock Stock')).toMatchObject({ child: 'Hostile Takeover', contested: 'Impostor' })
  })

  it('ignores malformed edges instead of creating a half-edge', () => {
    const idx = buildChainIndex([{ parent: 'Lock Stock' }, { child: 'Orphan' }, null])
    expect(idx.edge('Lock Stock')).toMatchObject({ source: 'known' })
  })
})

describe('chainFrom', () => {
  const idx = buildChainIndex(REAL_EDGES)

  it('walks a two-hop chain to its payout', () => {
    expect(chainFrom('Manifest Cruelty', idx).map((l) => l.name))
      .toEqual(['Manifest Cruelty', 'Gone Fission', 'Crane Reaction'])
  })

  it('returns a single link for a crime that spawns nothing', () => {
    // The standalone case IS a one-link chain, so no caller needs to ask
    // "is this a chain" before doing the arithmetic.
    expect(chainFrom('Pet Project', idx).map((l) => l.name)).toEqual(['Pet Project'])
  })

  it('⚠️ terminates on a cycle rather than hanging the page', () => {
    // The edges are scraped. A wrong number is recoverable; a frozen render is
    // the worse failure.
    const cyclic = buildChainIndex([
      { parent: 'A', child: 'B', observations: 5 },
      { parent: 'B', child: 'A', observations: 5 },
    ])
    expect(chainFrom('A', cyclic).map((l) => l.name)).toEqual(['A', 'B'])
  })
})

describe('chainConfident', () => {
  const idx = buildChainIndex(REAL_EDGES)

  it('trusts a well-observed chain', () => {
    expect(chainConfident(chainFrom('Stacking the Deck', idx))).toBe(true)
  })

  it('does not trust an edge that only comes from the hardcoded table', () => {
    expect(chainConfident(chainFrom('Manifest Cruelty', buildChainIndex([])))).toBe(false)
  })

  it('does not trust a chain observed fewer times than the floor', () => {
    const thin = buildChainIndex([{ parent: 'A', child: 'B', observations: MIN_OBSERVATIONS_FOR_CHAIN - 1 }])
    expect(chainConfident(chainFrom('A', thin))).toBe(false)
  })

  it('calls a crime with no chain at all confident', () => {
    // Nothing is being asserted, so there is nothing to doubt.
    expect(chainConfident(chainFrom('Pet Project', idx))).toBe(true)
  })
})

describe('chainedSuccess', () => {
  const links = chainFrom('Manifest Cruelty', buildChainIndex(REAL_EDGES))

  it('multiplies every link, because the reward needs all of them', () => {
    // TNL's own observed rates.
    const p = chainedSuccess(links, {
      'Manifest Cruelty': 0.8, 'Gone Fission': 0.875, 'Crane Reaction': 0.429,
    })
    expect(p).toBeCloseTo(0.30, 3)
  })

  it('⚠️ returns null when any link is unknown, never a partial product', () => {
    // A product over the links we happen to know is a different quantity that
    // would read as this one — and it always reads HIGHER, so it would make an
    // unsustainable chain look affordable.
    expect(chainedSuccess(links, { 'Manifest Cruelty': 0.8, 'Gone Fission': 0.875 })).toBeNull()
  })

  it('is just the crime own chance for a standalone', () => {
    expect(chainedSuccess([{ name: 'Pet Project' }], { 'Pet Project': 0.9 })).toBe(0.9)
  })
})

describe('chainedValue', () => {
  const idx = buildChainIndex(REAL_EDGES)
  const links = chainFrom('Manifest Cruelty', idx)

  it('⚠️ surfaces the payout the parent currently reports as $0', () => {
    // The whole point of the issue. Crane Reaction pays ~$1.35B; Manifest
    // Cruelty and Gone Fission pay nothing at all, and rank as $0 crimes today.
    const v = chainedValue(
      links,
      { 'Manifest Cruelty': 0.8, 'Gone Fission': 0.875, 'Crane Reaction': 0.429 },
      { 'Manifest Cruelty': 0, 'Gone Fission': 0, 'Crane Reaction': 1_350_000_000 },
    )
    expect(v.expected).toBeCloseTo(0.8 * 0.875 * 0.429 * 1_350_000_000, -3)
    expect(v.expected).toBeGreaterThan(400_000_000)
  })

  it('weights each link by the chance of reaching AND completing it', () => {
    // General form: a chain whose middle link pays is priced correctly even
    // though no chain we have today has that shape.
    const v = chainedValue(
      [{ name: 'A', child: 'B' }, { name: 'B', child: null }],
      { A: 0.5, B: 0.5 },
      { A: 100, B: 200 },
    )
    expect(v.expected).toBe(0.5 * 100 + 0.25 * 200)
  })

  it('reduces to success x value for a standalone crime', () => {
    const v = chainedValue([{ name: 'Solo', child: null }], { Solo: 0.6 }, { Solo: 1000 })
    expect(v.expected).toBe(600)
  })

  it('⚠️ reports incomplete when the terminal link has no price', () => {
    // A chain ending in an unpriced crime is a lower bound, exactly like
    // expectedValue()'s partial sum — and must not present as the real number.
    const v = chainedValue(
      [{ name: 'A', child: 'B' }, { name: 'B', child: null }],
      { A: 0.9, B: 0.9 },
      { A: 0 },
    )
    expect(v.complete).toBe(false)
  })

  it('⚠️ separates a crime that pays nothing from one we have not priced', () => {
    // Number(null) is 0 and Number.isFinite(0) is true, so the obvious coercion
    // reports "no prices for this crime" as "this crime pays nothing" — the trap
    // expectedValue() guards with `== null`. An explicit 0 is a measurement and
    // keeps the chain complete; a missing entry makes it a lower bound.
    const known = chainedValue(
      [{ name: 'A', child: 'B' }, { name: 'B', child: null }],
      { A: 0.9, B: 0.9 },
      { A: 0, B: 500 },
    )
    expect(known.complete).toBe(true)
    expect(known.expected).toBeCloseTo(0.81 * 500, 6)

    const unpriced = chainedValue(
      [{ name: 'A', child: 'B' }, { name: 'B', child: null }],
      { A: 0.9, B: 0.9 },
      { B: 500 },
    )
    expect(unpriced.complete).toBe(false)
    expect(unpriced.expected).toBeCloseTo(0.81 * 500, 6)
  })

  it('returns null when a link we must walk through has no success chance', () => {
    const v = chainedValue(
      [{ name: 'A', child: 'B' }, { name: 'B', child: null }],
      { B: 0.9 },
      { B: 500 },
    )
    expect(v).toBeNull()
  })
})

describe('chainBreakEven', () => {
  it('⚠️ climbs steeply with chain length, because the reward does not', () => {
    // The finding that inverted the framing on #585 and #602. Elaborate pays a
    // flat 6 however long the chain is, while the chance of collecting it
    // compounds — so a longer chain is strictly worse on scope.
    expect(chainBreakEven(5, 6, 1)).toBeCloseTo(0.8333, 4)
    expect(chainBreakEven(5, 6, 2)).toBeCloseTo(0.9129, 4)
    expect(chainBreakEven(5, 6, 3)).toBeCloseTo(0.9410, 4)
  })

  it('matches the standalone break-even for a one-link chain', () => {
    // ocScope.breakEvenSuccess is cost/reward; this must agree with it exactly
    // or the two screens would disagree about the same crime.
    expect(chainBreakEven(4, 5, 1)).toBeCloseTo(4 / 5, 10)
    expect(chainBreakEven(3, 4, 1)).toBeCloseTo(3 / 4, 10)
  })

  it('refuses nonsense rather than returning a number', () => {
    expect(chainBreakEven(5, 0, 2)).toBeNull()
    expect(chainBreakEven(5, 6, 0)).toBeNull()
    expect(chainBreakEven(NaN, 6, 2)).toBeNull()
  })
})

describe('chainedScope', () => {
  const idx = buildChainIndex(REAL_EDGES)

  it('⚠️ prices TNL real three-link chain as the scope drain it is', () => {
    // 80.0% x 87.5% x 42.9% = 30.0% against a 94.1%/link break-even. The payoff
    // links are the WEAKEST ones, which is the worst possible shape: the
    // compounding penalty lands hardest exactly where the chain is worst.
    const s = chainedScope(
      chainFrom('Manifest Cruelty', idx),
      { 'Manifest Cruelty': 0.8, 'Gone Fission': 0.875, 'Crane Reaction': 0.429 },
      ELABORATE,
    )
    expect(s.links).toBe(3)
    expect(s.cost).toBe(5)
    expect(s.reward).toBe(6)
    expect(s.chainedSuccess).toBeCloseTo(0.30, 3)
    expect(s.net).toBeCloseTo(-3.2, 1)
    expect(s.sustainable).toBe(false)
  })

  it('⚠️ compares the per-link geometric mean against the per-link break-even', () => {
    // Comparing the raw chained probability against a per-link break-even is
    // the natural mistake and it makes every chain look doomed.
    const s = chainedScope(
      chainFrom('Stacking the Deck', idx),
      { 'Stacking the Deck': 0.8, 'Ace in the Hole': 0.683 },
      ELABORATE,
    )
    expect(s.equivalentSuccess).toBeCloseTo(Math.sqrt(0.8 * 0.683), 6)
    expect(s.breakEvenPerLink).toBeCloseTo(0.9129, 4)
    expect(s.equivalentSuccess).toBeLessThan(s.breakEvenPerLink)
  })

  it('agrees with ocScope for a standalone crime', () => {
    const s = chainedScope([{ name: 'Solo', child: null }], { Solo: 0.9 }, { Solo: 'elaborate' })
    expect(s.net).toBeCloseTo(0.9 * 6 - 5, 10)
    expect(s.breakEvenPerLink).toBeCloseTo(5 / 6, 10)
  })

  it('⚠️ takes cost from the root and reward from the terminal link', () => {
    // Not the same category in general, and taking both from one end is wrong
    // in opposite directions depending which end you pick.
    const s = chainedScope(
      [{ name: 'Cheap', child: 'Rich' }, { name: 'Rich', child: null }],
      { Cheap: 1, Rich: 1 },
      { Cheap: 'simple', Rich: 'elaborate' },
    )
    expect(s.cost).toBe(2)
    expect(s.reward).toBe(6)
  })

  it('returns null for an unknown category rather than assuming a cost', () => {
    expect(chainedScope([{ name: 'X', child: null }], { X: 0.9 }, { X: 'nonsense' })).toBeNull()
  })

  it('keeps the scope shape when success is unknown', () => {
    // Cost and reward are facts about the category and stay useful even when
    // the crew is unknown; only the crew-dependent figures go null.
    const s = chainedScope(chainFrom('Stacking the Deck', idx), {}, ELABORATE)
    expect(s.cost).toBe(5)
    expect(s.breakEvenPerLink).toBeCloseTo(0.9129, 4)
    expect(s.net).toBeNull()
    expect(s.sustainable).toBeNull()
  })
})

describe('KNOWN_CHAINS', () => {
  it('holds the five edges verified across the fleet', () => {
    expect(KNOWN_CHAINS).toEqual({
      'No Reserve': 'Bidding War',
      'Lock Stock': 'Hostile Takeover',
      'Stacking the Deck': 'Ace in the Hole',
      'Manifest Cruelty': 'Gone Fission',
      'Gone Fission': 'Crane Reaction',
    })
  })

  it('is frozen, so a caller cannot quietly teach the app a chain that does not exist', () => {
    expect(Object.isFrozen(KNOWN_CHAINS)).toBe(true)
  })
})
