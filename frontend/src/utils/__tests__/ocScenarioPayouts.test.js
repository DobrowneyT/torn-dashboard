// #440 — pricing endings from the mirrored feed instead of by hand.
//
// The fixture is the REAL Break the Bank data: the derived #390 mapping joined
// to money and respect captured live on 2026-08-13. It is worth using the real
// numbers because they carry the property that confirmed the mapping — a
// monotonic payout ladder — which an invented fixture would not have.
import { describe, expect, it } from 'vitest'
import {
  payoutsFromEndings,
  respectFromEndings,
  pricingQuality,
  payoutSpread,
  paysInItems,
  endingValue,
  isPriceable,
  THIN_SAMPLE_THRESHOLD,
} from '../ocScenarioPayouts'
import { expectedValue } from '../ocExpectedValue'

const BTB = [
  { ending_key: 'goodEnding1', node_id: '_A8S_',  kind: 'good', resolved: true, money_avg: 375830861, respect_avg: 450, observations: 6419 },
  { ending_key: 'goodEnding2', node_id: '_A8S2_', kind: 'good', resolved: true, money_avg: 335785147, respect_avg: 405, observations: 3235 },
  { ending_key: 'goodEnding3', node_id: '_A9S_',  kind: 'good', resolved: true, money_avg: 296249359, respect_avg: 360, observations: 8015 },
  { ending_key: 'goodEnding4', node_id: '_A10S_', kind: 'good', resolved: true, money_avg: 256799033, respect_avg: 315, observations: 3972 },
  { ending_key: 'goodEnding5', node_id: '_B3S_',  kind: 'good', resolved: true, money_avg: 216827645, respect_avg: 270, observations: 2289 },
  { ending_key: 'badEnding1',  node_id: '_A4F_',  kind: 'bad',  resolved: true, money_avg: 0, respect_avg: 0, observations: 1 },
]

// #441 follow-up — money plus the item value the server derived from the
// mirror's per-node item drops (oc.ts, priced against the items catalogue).
describe('endingValue', () => {
  it('adds item value on top of money', () => {
    expect(endingValue({ money_avg: 100, item_value_avg: 50 })).toBe(150)
  })

  it('is real even when money is legitimately zero — Window of Opportunity', () => {
    // The whole point: an ending that pays $0 cash and real antiquities must
    // not read as unpriced just because the money half is zero.
    expect(endingValue({ money_avg: 0, item_value_avg: 70_000_000 })).toBe(70_000_000)
  })

  it('falls back to money alone when there is no item data', () => {
    expect(endingValue({ money_avg: 100 })).toBe(100)
    expect(endingValue({ money_avg: 100, item_value_avg: null })).toBe(100)
  })

  it('is null only when BOTH money and items are absent', () => {
    expect(endingValue({ money_avg: null, item_value_avg: null })).toBeNull()
    expect(endingValue({})).toBeNull()
  })

  it('is real from items alone when money is null (not merely zero)', () => {
    expect(endingValue({ money_avg: null, item_value_avg: 5000 })).toBe(5000)
  })

  it('is 0 for a starved ending regardless of anything else on the row (#473)', () => {
    // Blast from the Past / Counter Offer: the API reports the ending, the
    // diagram draws no terminal for it — confirmed, not merely unknown.
    expect(endingValue({ starved: true, resolved: false, money_avg: null, item_value_avg: null })).toBe(0)
  })
})

describe('isPriceable (#473)', () => {
  it('is true for a resolved ending, a starved one, or both', () => {
    expect(isPriceable({ resolved: true, starved: false })).toBe(true)
    expect(isPriceable({ resolved: false, starved: true })).toBe(true)
  })

  it('is false when neither resolved nor starved', () => {
    expect(isPriceable({ resolved: false, starved: false })).toBe(false)
    expect(isPriceable({})).toBe(false)
    expect(isPriceable(undefined)).toBe(false)
  })
})

describe('payoutsFromEndings', () => {
  it('prices every mapped good ending from the feed', () => {
    const payouts = payoutsFromEndings(BTB)
    expect(payouts.goodEnding1).toBe(375830861)
    expect(payouts.goodEnding5).toBe(216827645)
  })

  it('reproduces the monotonic ladder that confirmed the #390 mapping', () => {
    // ⚠️ Not decoration. Under declaration order — the shortcut #390 rejected —
    // goodEnding3/4 would be $256.8M then $296.2M, breaking this. The ladder is
    // an independent check on the mapping every time the feed is re-read, from
    // a signal (money) unrelated to what derived it (depth + role evidence).
    const payouts = payoutsFromEndings(BTB)
    const ladder = [1, 2, 3, 4, 5].map((i) => payouts[`goodEnding${i}`])
    for (let i = 1; i < ladder.length; i++) {
      expect(ladder[i], `goodEnding${i + 1} should pay less than goodEnding${i}`)
        .toBeLessThan(ladder[i - 1])
    }
  })

  it('forces bad endings to zero rather than leaving them unpriced', () => {
    // They pay nothing by the game's rules. Treating them as missing would make
    // every crime report a lower bound forever.
    expect(payoutsFromEndings(BTB).badEnding1).toBe(0)
  })

  it('omits an unresolved ending instead of pricing it at zero', () => {
    // ⚠️ The distinction the whole module turns on. A 0 says "this outcome pays
    // nothing"; absence says "we do not know", which expectedValue() turns into
    // a lower bound. Getting this backwards understates the crime silently.
    const withUnmapped = [
      ...BTB,
      { ending_key: 'goodEnding6', node_id: null, kind: 'good', resolved: false, money_avg: null, observations: null },
    ]
    const payouts = payoutsFromEndings(withUnmapped)
    expect('goodEnding6' in payouts).toBe(false)
  })

  it('omits a mapped ending the feed has no money for', () => {
    const noStats = [{ ending_key: 'goodEnding1', node_id: '_A8S_', kind: 'good', resolved: true, money_avg: null, observations: null }]
    expect(payoutsFromEndings(noStats)).toEqual({})
  })

  it('does not read a null payout as zero', () => {
    // Number(null) === 0 and Number.isFinite(0) is true. This repo has been
    // bitten by that enough times to test it directly.
    const nulled = [{ ending_key: 'goodEnding1', node_id: '_A8S_', kind: 'good', resolved: true, money_avg: null }]
    expect(payoutsFromEndings(nulled).goodEnding1).toBeUndefined()
  })

  it('prices a $0-money ending from its item value — Window of Opportunity', () => {
    const wop = [{
      ending_key: 'goodEnding1', node_id: '_A8S_', kind: 'good', resolved: true,
      money_avg: 0, item_value_avg: 70_416_072, observations: 3718,
    }]
    expect(payoutsFromEndings(wop).goodEnding1).toBe(70_416_072)
  })

  it('still omits an ending with neither money nor priceable items', () => {
    const bothMissing = [{
      ending_key: 'goodEnding1', node_id: '_C6S_', kind: 'good', resolved: true,
      money_avg: null, item_value_avg: null, observations: 100,
    }]
    expect(payoutsFromEndings(bothMissing)).toEqual({})
  })

  it('prices a starved ending at $0 rather than treating it as missing (#473)', () => {
    const withStarved = [
      ...BTB,
      { ending_key: 'goodEnding35', node_id: null, kind: 'good', resolved: false, starved: true, money_avg: null, observations: null },
    ]
    const payouts = payoutsFromEndings(withStarved)
    expect(payouts.goodEnding35).toBe(0)
    expect('goodEnding35' in payouts).toBe(true)
  })
})

describe('respectFromEndings', () => {
  it('carries respect alongside money — the other half of the outcome', () => {
    const respect = respectFromEndings(BTB)
    expect(respect.goodEnding1).toBe(450)
    expect(respect.goodEnding5).toBe(270)
    // Steps of exactly 45 in the real data, which is its own sanity check.
    expect(respect.goodEnding1 - respect.goodEnding2).toBe(45)
  })
})

describe('expectedValue over feed pricing', () => {
  it('is complete and real for a fully priced crime', () => {
    const probs = { goodEnding1: 0.97, goodEnding2: 0.0098, goodEnding3: 0.0197, goodEnding4: 0.0002, goodEnding5: 0.0001 }
    const ev = expectedValue('Break the Bank', probs, payoutsFromEndings(BTB))
    expect(ev.complete).toBe(true)
    expect(ev.missing).toEqual([])
    // Dominated by the all-pass ending at these CPRs.
    expect(ev.expected).toBeGreaterThan(370_000_000)
    expect(ev.expected).toBeLessThan(376_000_000)
  })

  it('reports a lower bound when an ending is unmapped', () => {
    const partial = payoutsFromEndings(BTB.filter((e) => e.ending_key !== 'goodEnding1'))
    const probs = { goodEnding1: 0.97, goodEnding2: 0.0098, goodEnding3: 0.0197 }
    const ev = expectedValue('Break the Bank', probs, partial)
    expect(ev.complete).toBe(false)
    expect(ev.missing).toContain('goodEnding1')
    // ⚠️ The unpriced ending here is the one carrying 97% of the probability,
    // so the "lower bound" is a tiny fraction of the truth. This is exactly why
    // it must never be presented as the expected value.
    expect(ev.pricedProbability).toBeLessThan(0.05)
  })
})

describe('pricingQuality', () => {
  it('separates unmapped, unpriced and thin — they have different fixes', () => {
    const mixed = [
      BTB[0],
      { ending_key: 'goodEnding2', node_id: null, kind: 'good', resolved: false, money_avg: null, observations: null },
      { ending_key: 'goodEnding3', node_id: '_A9S_', kind: 'good', resolved: true, money_avg: null, observations: null },
      { ending_key: 'goodEnding4', node_id: '_A10S_', kind: 'good', resolved: true, money_avg: 1000, observations: 2 },
    ]
    const q = pricingQuality(mixed)
    expect(q.unmapped).toEqual(['goodEnding2'])   // needs a better probe
    expect(q.unpriced).toEqual(['goodEnding3'])   // needs observations
    expect(q.thin).toEqual(['goodEnding4'])       // has some, not enough
    expect(q.complete).toBe(false)
  })

  it('calls the real Break the Bank data complete', () => {
    const q = pricingQuality(BTB)
    expect(q.complete).toBe(true)
    expect(q.priced).toBe(5)
    expect(q.thin).toEqual([])
    expect(q.observations).toBe(23930)
  })

  it('flags a single-observation average, which the feed really does contain', () => {
    // n runs from 1 to 6,419 on the same crime. An average from one run renders
    // identically to one from six thousand unless something marks it.
    const one = [{ ending_key: 'goodEnding1', node_id: '_A8S_', kind: 'good', resolved: true, money_avg: 770108, observations: 1 }]
    expect(pricingQuality(one).thin).toEqual(['goodEnding1'])
    expect(THIN_SAMPLE_THRESHOLD).toBeGreaterThan(1)
  })

  it('returns null when there are no good endings to judge', () => {
    expect(pricingQuality([])).toBeNull()
    expect(pricingQuality(undefined)).toBeNull()
  })

  it('counts an item-only ending as priced, not unpriced (#441 follow-up)', () => {
    const itemOnly = [
      { ending_key: 'goodEnding1', node_id: '_A8S_', kind: 'good', resolved: true, money_avg: 0, item_value_avg: 70_000_000, observations: 3718 },
    ]
    const q = pricingQuality(itemOnly)
    expect(q.priced).toBe(1)
    expect(q.unpriced).toEqual([])
  })

  it('counts a starved ending as priced, not unmapped (#473)', () => {
    // Distinct from unmapped: unmapped needs a better probe and this one
    // never will resolve — there's no node. It's a confirmed $0, not an
    // open question, so it belongs in `priced`.
    const withStarved = [
      BTB[0],
      { ending_key: 'goodEnding35', node_id: null, kind: 'good', resolved: false, starved: true, money_avg: null, observations: null },
    ]
    const q = pricingQuality(withStarved)
    expect(q.unmapped).toEqual([])
    expect(q.unpriced).toEqual([])
    expect(q.priced).toBe(2)
    expect(q.complete).toBe(true)
    // Not "thin" either — it has no observation count to be thin about.
    expect(q.thin).toEqual([])
  })
})

describe('payoutSpread', () => {
  it('measures the gap a router role decides between', () => {
    // ~$159M between the best and worst ending on Break the Bank. This is the
    // entire argument for per-role sensitivity (#441): a role that never
    // changes success can still be worth this much.
    const spread = payoutSpread(BTB)
    expect(spread.best).toBe(375830861)
    expect(spread.worst).toBe(216827645)
    expect(spread.gap).toBe(159003216)
  })

  it('returns null rather than a zero spread when nothing is priced', () => {
    expect(payoutSpread([{ ending_key: 'g1', kind: 'good', resolved: false }])).toBeNull()
  })

  it('excludes a starved ending from the spread (#473)', () => {
    // The spread is the gap a ROUTER ROLE decides between — real diagram
    // terminals. A starved ending is a data-completeness placeholder, not a
    // designed outcome; including its synthetic $0 would inflate the gap.
    const withStarved = [
      ...BTB,
      { ending_key: 'goodEnding35', node_id: null, kind: 'good', resolved: false, starved: true, money_avg: null },
    ]
    const spread = payoutSpread(withStarved)
    expect(spread.worst).toBe(216827645) // unchanged — not the starved $0
  })
})

describe('paysInItems', () => {
  // ⚠️ Found in the live mirror: several crimes report money 0 for EVERY good
  // ending while still earning respect. Best of the Lot steals cars; the feed
  // prices cash, not items.
  const itemCrime = [
    { ending_key: 'goodEnding1', kind: 'good', resolved: true, money_avg: 0, respect_avg: 120, observations: 500 },
    { ending_key: 'goodEnding2', kind: 'good', resolved: true, money_avg: 0, respect_avg: 90, observations: 300 },
  ]

  it('spots a crime whose whole reward is items', () => {
    expect(paysInItems(itemCrime)).toBe(true)
  })

  it('does not mistake a cash crime for an item crime', () => {
    expect(paysInItems(BTB)).toBe(false)
  })

  it('does not fire when there is simply no data', () => {
    // Unpriced is a different problem with a different fix, and conflating the
    // two would tell someone to judge on respect that we also do not have.
    expect(paysInItems([{ ending_key: 'g1', kind: 'good', resolved: true, money_avg: null, respect_avg: null }]))
      .toBe(false)
    expect(paysInItems([])).toBe(false)
  })

  it('does not fire when the crime genuinely earns nothing at all', () => {
    // Zero money AND zero respect is not "pays in items", it is a dead end.
    const nothing = [{ ending_key: 'g1', kind: 'good', resolved: true, money_avg: 0, respect_avg: 0 }]
    expect(paysInItems(nothing)).toBe(false)
  })

  it('stops firing once the item value is priced (#441 follow-up)', () => {
    // The crime this whole addition exists for: Window of Opportunity's
    // endings pay $0 cash and real antiquities. Once item_value_avg carries
    // that, the crime is priced and this must no longer flag it.
    const nowPriced = [
      { ending_key: 'goodEnding1', kind: 'good', resolved: true, money_avg: 0, item_value_avg: 70_000_000, respect_avg: 290 },
    ]
    expect(paysInItems(nowPriced)).toBe(false)
  })

  it('keeps firing when the items are observed but still unmatched to our catalogue', () => {
    // priceNodeItems() returns 0 (not null) for a node whose drops it saw but
    // could not price — real gap, still worth flagging, distinct from a crime
    // with no item data at all.
    const unmatched = [
      { ending_key: 'goodEnding1', kind: 'good', resolved: true, money_avg: 0, item_value_avg: 0, respect_avg: 290 },
    ]
    expect(paysInItems(unmatched)).toBe(true)
  })
})
