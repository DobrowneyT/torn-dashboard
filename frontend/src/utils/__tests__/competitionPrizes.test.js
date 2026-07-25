import { describe, it, expect } from 'vitest'
import { formatPrize, prizeTableRows, buildPrizes, buildPrizePayload, ordinal } from '../competitionPrizes.js'

describe('formatPrize', () => {
  it('formats a cash prize with thousands separators', () => {
    expect(formatPrize({ kind: 'cash', amount: 10000000 })).toBe('$10,000,000')
  })
  it('shows a text prize verbatim', () => {
    expect(formatPrize({ kind: 'text', text: 'Bragging rights' })).toBe('Bragging rights')
  })
  it('is empty for a missing slot', () => {
    expect(formatPrize(null)).toBe('')
  })
})

describe('ordinal', () => {
  it('renders placement ordinals', () => {
    expect([1, 2, 3, 4, 11, 21, 22, 23].map(ordinal))
      .toEqual(['1st', '2nd', '3rd', '4th', '11th', '21st', '22nd', '23rd'])
  })
})

describe('prizeTableRows', () => {
  it('labels placement prizes by rank', () => {
    expect(prizeTableRows({
      prize_kind: 'placement',
      prizes: [{ kind: 'cash', amount: 10000000 }, { kind: 'text', text: 'Silver' }],
    })).toEqual([
      { place: '1st', prize: '$10,000,000' },
      { place: '2nd', prize: 'Silver' },
    ])
  })
  it('is empty when there are no prizes', () => {
    expect(prizeTableRows({ prize_kind: 'placement', prizes: [] })).toEqual([])
    expect(prizeTableRows({ prize_kind: 'placement' })).toEqual([])
  })
  it('renders a flat prize as a single "everyone" row (#240)', () => {
    expect(prizeTableRows({ prize_kind: 'flat', prizes: [{ kind: 'cash', amount: 5000000 }] }))
      .toEqual([{ place: 'Everyone', prize: '$5,000,000' }])
  })
  it('is empty when a flat competition has no slot (#240)', () => {
    expect(prizeTableRows({ prize_kind: 'flat', prizes: [] })).toEqual([])
  })
})

describe('buildPrizePayload (#240)', () => {
  it('emits a placement payload with all slots', () => {
    expect(buildPrizePayload('placement', [{ kind: 'cash', amount: '100' }, { kind: 'text', text: 'x' }]))
      .toEqual({ prize_kind: 'placement', prizes: [{ kind: 'cash', amount: 100 }, { kind: 'text', text: 'x' }] })
  })
  it('emits a flat payload capped to a single slot', () => {
    expect(buildPrizePayload('flat', [{ kind: 'cash', amount: '100' }, { kind: 'cash', amount: '200' }]))
      .toEqual({ prize_kind: 'flat', prizes: [{ kind: 'cash', amount: 100 }] })
  })
})

describe('buildPrizes', () => {
  it('coerces cash amounts to numbers and drops empty/blank slots', () => {
    expect(buildPrizes([
      { kind: 'cash', amount: '10000000' },
      { kind: 'text', text: 'Bragging rights' },
      { kind: 'cash', amount: '' },   // blank → dropped
      { kind: 'text', text: '   ' },   // blank → dropped
    ])).toEqual([
      { kind: 'cash', amount: 10000000 },
      { kind: 'text', text: 'Bragging rights' },
    ])
  })
  it('returns an empty array for no slots', () => {
    expect(buildPrizes([])).toEqual([])
  })
})
