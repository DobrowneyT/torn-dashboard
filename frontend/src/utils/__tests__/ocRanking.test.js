// #444/#448 — ranking crimes by what they are worth per week.
//
// The theme throughout: a crime we know nothing about must never rank as
// worthless, and a crime that cannot be sustained must not rank on its money.
import { describe, expect, it } from 'vitest'
import {
  spawnsPerWeek, categoryOf, rankCrime, rankCrimes, sortRanking, MIN_RUNS_FOR_RATE,
} from '../ocRanking'

const NOW = 1_760_000_000
const WEEK = 7 * 86400

/** Break the Bank shape: advanced (scope 4), five priced good endings. */
const btb = (over = {}) => ({
  name: 'Break the Bank',
  endings: [
    { ending_key: 'goodEnding1', kind: 'good', resolved: true, money_avg: 400_000_000, respect_avg: 450, observations: 6419 },
    { ending_key: 'goodEnding2', kind: 'good', resolved: true, money_avg: 200_000_000, respect_avg: 405, observations: 3235 },
  ],
  item_reward: null,
  spawn_history: { runs: 20, first_at: NOW - 10 * WEEK, last_at: NOW },
  ...over,
})

describe('spawnsPerWeek', () => {
  it('measures the rate from our own history', () => {
    const s = spawnsPerWeek({ runs: 20, first_at: NOW - 10 * WEEK }, NOW)
    expect(s.rate).toBeCloseTo(2)
    expect(s.confident).toBe(true)
  })

  it('flags a thin history rather than treating it as a rate', () => {
    // ⚠️ A crime run twice has no meaningful weekly rate. Presenting one would
    // let it outrank a crime we actually run, on noise.
    const s = spawnsPerWeek({ runs: 2, first_at: NOW - 8 * WEEK }, NOW)
    expect(s.confident).toBe(false)
    expect(MIN_RUNS_FOR_RATE).toBeGreaterThan(2)
  })

  it('returns null for a crime we have never run', () => {
    // Not a rate of 0 — that is a measurement we have not made.
    expect(spawnsPerWeek({ runs: 0, first_at: null }, NOW)).toBeNull()
    expect(spawnsPerWeek(null, NOW)).toBeNull()
  })

  it('never divides by less than a week', () => {
    // A crime first run an hour ago would otherwise report hundreds per week.
    const s = spawnsPerWeek({ runs: 3, first_at: NOW - 3600 }, NOW)
    expect(s.rate).toBeLessThanOrEqual(3)
  })
})

describe('categoryOf', () => {
  it('uses the name-authoritative resolver', () => {
    // Break the Bank is difficulty 8 but configured Advanced.
    expect(categoryOf({ name: 'Break the Bank', difficulty: 8 })).toBe('advanced')
  })
})

describe('rankCrime', () => {
  it('carries scope cost and the break-even for the crime\'s category', () => {
    const row = rankCrime(btb(), 0.95, { now: NOW })
    expect(row.scopeCost).toBe(4)
    expect(row.breakEven).toBeCloseTo(0.8)
    expect(row.sustainable).toBe(true)
  })

  it('⚠️ marks a crime below its break-even as unsustainable', () => {
    // Advanced needs 80%. At 75% this crime drains scope no matter what it
    // pays, and the ranking must be able to say so separately from the money.
    const row = rankCrime(btb(), 0.75, { now: NOW })
    expect(row.sustainable).toBe(false)
    expect(row.netScope).toBeLessThan(0)
  })

  it('ranks on money per SCOPE, not money per run', () => {
    // The scarce input is scope. 0.95 x mean(400M, 200M) = 285M over 4 scope.
    const row = rankCrime(btb(), 0.95, { now: NOW })
    expect(row.cashPerRun).toBeCloseTo(285_000_000, -3)
    expect(row.moneyPerScope).toBeCloseTo(285_000_000 / 4, -3)
  })

  it('adds item value for a crime that pays in items (#448)', () => {
    const itemCrime = btb({
      endings: [
        { ending_key: 'goodEnding1', kind: 'good', resolved: true, money_avg: 0, respect_avg: 120, observations: 500 },
      ],
      item_reward: { avg_value: 50_000_000, runs: 12, unpriced_rows: 0 },
    })
    const row = rankCrime(itemCrime, 0.9, { now: NOW })
    expect(row.cashPerRun).toBe(0)
    expect(row.itemPerRun).toBeCloseTo(45_000_000)
    // ⚠️ Without the item side this crime would total 0 and rank last, on a
    // number measuring half its reward.
    expect(row.totalPerRun).toBeCloseTo(45_000_000)
    expect(row.paysInItems).toBe(true)
  })

  it('leaves item value null for a crime we have never completed', () => {
    // "No history" must not read as "drops nothing".
    const row = rankCrime(btb({ item_reward: null }), 0.9, { now: NOW })
    expect(row.itemPerRun).toBeNull()
    expect(row.itemRuns).toBe(0)
  })

  it('reports nulls, not zeros, when there is no success chance', () => {
    // ⚠️ The #351 rule at the row level. A crime the ranking endpoint could not
    // price must sink in both sort directions, which only nulls achieve.
    const row = rankCrime(btb(), undefined, { now: NOW })
    expect(row.successChance).toBeNull()
    expect(row.cashPerRun).toBeNull()
    expect(row.moneyPerScope).toBeNull()
    expect(row.incomePerWeek).toBeNull()
    expect(row.sustainable).toBeNull()
  })

  it('leaves income per week null when the spawn rate is unknown', () => {
    const row = rankCrime(btb({ spawn_history: null }), 0.95, { now: NOW })
    expect(row.totalPerRun).not.toBeNull()
    expect(row.incomePerWeek).toBeNull()
  })

  it('combines value per run with the spawn rate for income per week', () => {
    const row = rankCrime(btb(), 0.95, { now: NOW })
    // 285M per run x 2 runs/week
    expect(row.incomePerWeek).toBeCloseTo(570_000_000, -4)
  })

  it('reports how much of the pricing is missing', () => {
    const partial = btb({
      endings: [
        { ending_key: 'goodEnding1', kind: 'good', resolved: true, money_avg: 400_000_000, observations: 100 },
        { ending_key: 'goodEnding2', kind: 'good', resolved: false, money_avg: null, observations: null },
      ],
    })
    const row = rankCrime(partial, 0.95, { now: NOW })
    expect(row.pricingComplete).toBe(false)
    expect(row.unpricedEndings).toBe(1)
  })
})

describe('rankCrimes', () => {
  it('maps success chances onto scenarios by name', () => {
    const rows = rankCrimes([btb()], { 'Break the Bank': 0.95 }, { now: NOW })
    expect(rows[0].successChance).toBeCloseTo(0.95)
  })

  it('handles a crime the endpoint could not compute', () => {
    const rows = rankCrimes([btb()], {}, { now: NOW })
    expect(rows[0].successChance).toBeNull()
  })
})

describe('sortRanking', () => {
  const rows = [
    { name: 'A', moneyPerScope: 100 },
    { name: 'B', moneyPerScope: null },
    { name: 'C', moneyPerScope: 300 },
  ]

  it('⚠️ sinks unknowns to the bottom in BOTH directions', () => {
    // The #351 rule. A crime with no data must not top an ascending sort by
    // being treated as zero, nor a descending one by being treated as huge.
    expect(sortRanking(rows, 'moneyPerScope', 'desc').map((r) => r.name)).toEqual(['C', 'A', 'B'])
    expect(sortRanking(rows, 'moneyPerScope', 'asc').map((r) => r.name)).toEqual(['A', 'C', 'B'])
  })

  it('breaks ties between unknowns by name, so the order is stable', () => {
    const many = [{ name: 'Z', x: null }, { name: 'A', x: null }]
    expect(sortRanking(many, 'x', 'desc').map((r) => r.name)).toEqual(['A', 'Z'])
  })

  it('sorts strings too', () => {
    expect(sortRanking(rows, 'name', 'asc').map((r) => r.name)).toEqual(['A', 'B', 'C'])
  })

  it('does not mutate the input', () => {
    const original = [...rows]
    sortRanking(rows, 'moneyPerScope', 'desc')
    expect(rows).toEqual(original)
  })
})

describe('unpriced item drops', () => {
  it('⚠️ surfaces drops with no price at all, so the row reads as understated', () => {
    // An item in neither market nor sell price contributes zero. That makes the
    // crime's value an UNDERSTATEMENT, not an estimate, and the table has to be
    // able to say so — otherwise it silently ranks the crime too low.
    const row = rankCrime(
      btb({ item_reward: { avg_value: 5_000_000, runs: 8, unpriced_rows: 3 } }),
      0.95,
      { now: NOW }
    )
    expect(row.unpricedItemRows).toBe(3)
  })

  it('is 0 for a crime whose drops are all priced', () => {
    const row = rankCrime(
      btb({ item_reward: { avg_value: 5_000_000, runs: 8, unpriced_rows: 0 } }),
      0.95,
      { now: NOW }
    )
    expect(row.unpricedItemRows).toBe(0)
  })
})

// #585 — crimes whose real payout is one or two crimes downstream.
describe('rankCrimes with chains', () => {
  const CHAINS = [
    { parent: 'Manifest Cruelty', child: 'Gone Fission', observations: 8 },
    { parent: 'Gone Fission', child: 'Crane Reaction', observations: 7 },
  ]

  // Difficulty 8/9/10 all resolve to elaborate (cost 5, reward 6).
  const SCENARIOS = [
    { name: 'Manifest Cruelty', difficulty: 8, endings: [], spawn_history: { runs: 10, first_at: 0 } },
    { name: 'Gone Fission', difficulty: 9, endings: [], spawn_history: { runs: 8, first_at: 0 } },
    {
      name: 'Crane Reaction', difficulty: 10, endings: [],
      spawn_history: { runs: 7, first_at: 0 },
      item_reward: { avg_value: 1_350_000_000, runs: 7, unpriced_rows: 0 },
    },
  ]

  // TNL's own observed rates.
  const SUCCESS = { 'Manifest Cruelty': 0.8, 'Gone Fission': 0.875, 'Crane Reaction': 0.429 }

  const byName = (rows) => Object.fromEntries(rows.map((r) => [r.name, r]))

  it('⚠️ a chain parent stops reporting $0', () => {
    // The whole issue. Manifest Cruelty and Gone Fission pay nothing of their
    // own; the money is all at Crane Reaction, two crimes downstream. Today the
    // parent carries no value at all — null rather than 0, since the #351 rule
    // correctly refuses to call an unpriced crime worthless — and either way it
    // never ranks on the $1.35B sitting at the end of its own chain.
    const before = byName(rankCrimes(SCENARIOS, SUCCESS))
    expect(before['Manifest Cruelty'].totalPerRun).toBeNull()

    const after = byName(rankCrimes(SCENARIOS, SUCCESS, { chains: CHAINS }))
    expect(after['Manifest Cruelty'].totalPerRun).toBeCloseTo(
      0.8 * 0.875 * 0.429 * 1_350_000_000, -3,
    )
  })

  it('⚠️ a chain child is marked unspawnable so the ranking can drop it', () => {
    // Crane Reaction has 0 standalone runs against 7 spawned. Ranking it as a
    // choice offers a decision nobody can make, and counting it separately
    // double-counts the pipeline.
    const rows = byName(rankCrimes(SCENARIOS, SUCCESS, { chains: CHAINS }))
    expect(rows['Crane Reaction'].spawnable).toBe(false)
    expect(rows['Gone Fission'].spawnable).toBe(false)
    expect(rows['Manifest Cruelty'].spawnable).toBe(true)
  })

  it('⚠️ re-derives scope over the whole chain, which is where it turns negative', () => {
    // 80.0% x 87.5% x 42.9% = 30.0%, against a 94.1%/link break-even. The chain
    // is excellent money and a scope drain at the same time — the two figures
    // genuinely point opposite ways and neither one alone is the answer.
    const row = byName(rankCrimes(SCENARIOS, SUCCESS, { chains: CHAINS }))['Manifest Cruelty']
    expect(row.chainedSuccess).toBeCloseTo(0.30, 2)
    expect(row.breakEven).toBeCloseTo(0.9410, 4)
    expect(row.netScope).toBeCloseTo(-3.2, 1)
    expect(row.sustainable).toBe(false)
    expect(row.moneyPerScope).toBeGreaterThan(80_000_000)
  })

  it('compares the per-link geometric mean, not the raw chained probability', () => {
    // Comparing 30% against a 94.1% per-link bar is the natural mistake and it
    // makes every chain look far worse than it is.
    const row = byName(rankCrimes(SCENARIOS, SUCCESS, { chains: CHAINS }))['Manifest Cruelty']
    expect(row.equivalentSuccess).toBeCloseTo(Math.cbrt(0.8 * 0.875 * 0.429), 6)
    expect(row.equivalentSuccess).toBeGreaterThan(row.chainedSuccess)
  })

  it('names the links and reports how well evidenced the chain is', () => {
    const row = byName(rankCrimes(SCENARIOS, SUCCESS, { chains: CHAINS }))['Manifest Cruelty']
    expect(row.chainLinks).toEqual(['Manifest Cruelty', 'Gone Fission', 'Crane Reaction'])
    expect(row.chainConfident).toBe(true)
    expect(row.chainSource).toBe('observed')
  })

  it('⚠️ prices a chain for a faction that has never run one', () => {
    // Ascension had observed no chains at all. Without the known-chains
    // fallback it would price Manifest Cruelty at $0 purely for never having
    // run it — the bug, reproduced by inexperience rather than by data.
    const rows = byName(rankCrimes(SCENARIOS, SUCCESS, { chains: [] }))
    expect(rows['Manifest Cruelty'].totalPerRun).toBeGreaterThan(400_000_000)
    expect(rows['Manifest Cruelty'].chainConfident).toBe(false)
    expect(rows['Manifest Cruelty'].chainSource).toBe('known')
  })

  it('leaves a standalone crime exactly as it was', () => {
    // A one-link chain IS the standalone case; the arithmetic must reduce to it
    // rather than shifting every unchained crime by a rounding error.
    const solo = [{ name: 'Pet Project', difficulty: 7, endings: [], spawn_history: { runs: 9, first_at: 0 } }]
    const success = { 'Pet Project': 0.9 }
    const before = rankCrimes(solo, success)[0]
    const after = rankCrimes(solo, success, { chains: CHAINS })[0]
    expect(after.totalPerRun).toBe(before.totalPerRun)
    expect(after.netScope).toBe(before.netScope)
    expect(after.breakEven).toBe(before.breakEven)
    expect(after.spawnable).toBe(true)
    expect(after.chainLinks).toBeNull()
  })

  it('behaves exactly as before when no chains are supplied', () => {
    const withOpt = rankCrimes(SCENARIOS, SUCCESS)
    expect(withOpt.every((r) => r.spawnable === undefined)).toBe(true)
  })
})
