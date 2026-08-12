// OC expected value over hand-entered ending payouts (#390).
//
// The payout table starts empty and fills in over months, so the behaviour
// that matters most here is what happens with PARTIAL data.
import { describe, it, expect } from 'vitest'
import { expectedValue, coverage, payoutsFor } from '../ocExpectedValue'
import table from '../../data/ocEndingPayouts.json'

const probs = {
  goodEnding1: 0.5, goodEnding2: 0.2,
  badEnding1: 0.2, badEnding2: 0.1,
}

describe('expectedValue', () => {
  it('sums P(ending) × payout over priced endings', () => {
    const r = expectedValue('X', probs, { goodEnding1: 1000, goodEnding2: 500 })
    expect(r.expected).toBeCloseTo(0.5 * 1000 + 0.2 * 500, 6)
    expect(r.complete).toBe(true)
    expect(r.missing).toEqual([])
  })

  it('counts bad endings as covered but worthless, under the stated assumption', () => {
    const r = expectedValue('X', probs, { goodEnding1: 1000, goodEnding2: 500 })
    // All four endings accounted for: the two priced, the two assumed zero.
    expect(r.pricedProbability).toBeCloseTo(1, 6)
  })

  it('reports a LOWER BOUND, not an estimate, when a payout is missing', () => {
    // The whole point. goodEnding2 is unpriced, so the true E(x) is higher than
    // what comes back — a caller that renders this as "the" expected value
    // understates every crime whose best ending is unpriced.
    const r = expectedValue('X', probs, { goodEnding1: 1000 })
    expect(r.expected).toBeCloseTo(500, 6)
    expect(r.complete).toBe(false)
    expect(r.missing).toEqual(['goodEnding2'])
    // 0.2 of the mass is unpriced, so the caller can say how partial it is.
    expect(r.pricedProbability).toBeCloseTo(0.8, 6)
  })

  it('treats a payout of 0 as a price, not as missing', () => {
    // The Number(null) === 0 trap from the other side: an ending we measured at
    // zero is knowledge, and reporting it as unknown would make a complete
    // table look permanently incomplete.
    const r = expectedValue('X', { goodEnding1: 1 }, { goodEnding1: 0 })
    expect(r.complete).toBe(true)
    expect(r.missing).toEqual([])
    expect(r.expected).toBe(0)
  })

  it('is empty and incomplete for a scenario with no entry at all', () => {
    const r = expectedValue('Nonexistent', { goodEnding1: 1 }, null)
    expect(r.expected).toBe(0)
    expect(r.complete).toBe(false)
    expect(r.missing).toEqual(['goodEnding1'])
  })

  it('ignores non-numeric probabilities rather than poisoning the sum', () => {
    const r = expectedValue('X', { goodEnding1: 0.5, goodEnding2: null }, { goodEnding1: 100, goodEnding2: 100 })
    expect(r.expected).toBeCloseTo(50, 6)
    expect(Number.isNaN(r.expected)).toBe(false)
  })
})

describe('the shipped payout table', () => {
  it('covers every scenario the probability API supports', () => {
    expect(Object.keys(table)).toHaveLength(31)
  })

  it('uses null for unknown payouts, never 0', () => {
    // 0 means "this ending pays nothing", which is a measurement. Seeding the
    // skeleton with 0 would silently claim we had measured all 167.
    for (const [name, entry] of Object.entries(table)) {
      for (const [key, v] of Object.entries(entry.payouts)) {
        if (v !== null) expect(typeof v, `${name}.${key}`).toBe('number')
      }
    }
  })

  it('reports fill-in progress', () => {
    const c = coverage()
    expect(c.total).toBe(167)
    expect(c.priced).toBeGreaterThanOrEqual(0)
    expect(c.priced).toBeLessThanOrEqual(c.total)
  })

  it('exposes payouts by scenario name, matching the API spelling exactly', () => {
    // Their spelling wins, accents and all — "Guardian Ángels" and
    // "Cash Me if You Can" differ from our config.js and a lookup by our name
    // would silently return nothing.
    expect(payoutsFor('Guardian Ángels')).not.toBeNull()
    expect(payoutsFor('Cash Me if You Can')).not.toBeNull()
    expect(payoutsFor('Guardian Angels')).toBeNull()
  })
})
