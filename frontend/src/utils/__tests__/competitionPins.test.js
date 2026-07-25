import { describe, it, expect } from 'vitest'
import { ownRowMode, lotteryOwnStatus } from '../competitionPins.js'

describe('ownRowMode', () => {
  const top = [{ rank: 1 }, { rank: 2 }, { rank: 3 }, { rank: 4 }, { rank: 5 }]
  it('is "none" when the caller has no standing', () => {
    expect(ownRowMode(top, null)).toBe('none')
  })
  it('highlights in place when the caller is within the shown rows', () => {
    expect(ownRowMode(top, { rank: 3, value: 1900 })).toBe('highlight')
    expect(ownRowMode(top, { rank: 5, value: 1500 })).toBe('highlight')
  })
  it('appends a you-row when the caller is outside the shown rows', () => {
    expect(ownRowMode(top, { rank: 14, value: 1240 })).toBe('append')
  })
  it('appends when the caller ranks past a short top list', () => {
    expect(ownRowMode([{ rank: 1 }, { rank: 2 }], { rank: 3, value: 10 })).toBe('append')
  })
})

describe('lotteryOwnStatus', () => {
  const comp = { threshold_comparator: 'gte', threshold_value: 10000 }
  it('says "no data yet" when the caller has no standing', () => {
    expect(lotteryOwnStatus(null, comp)).toEqual({ text: 'no data yet', qualified: null })
  })
  it('reports a qualifying score against a gte threshold', () => {
    expect(lotteryOwnStatus({ value: 12000, qualified: true }, comp))
      .toEqual({ text: '12,000 · qualified (≥ 10,000)', qualified: true })
  })
  it('reports a non-qualifying score', () => {
    expect(lotteryOwnStatus({ value: 8400, qualified: false }, comp))
      .toEqual({ text: '8,400 · not yet (≥ 10,000)', qualified: false })
  })
  it('renders a lte threshold with the right comparator', () => {
    expect(lotteryOwnStatus({ value: 5, qualified: true }, { threshold_comparator: 'lte', threshold_value: 10 }))
      .toEqual({ text: '5 · qualified (≤ 10)', qualified: true })
  })
})
