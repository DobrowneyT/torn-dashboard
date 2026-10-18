import { describe, expect, it } from 'vitest'
import {
  createKeySlots, allocate, classifyFailure, retryDelayMs, backlogGrowing, LOG_GONE_CODE,
} from '../src/events/eventAttackLogs.js'
import { TornApiError, TornUnavailableError } from '../src/scraper/tornClient.js'

describe('createKeySlots', () => {
  it('⚠️ never lets a key past its per-minute budget', () => {
    const slots = createKeySlots(() => 10)
    for (let i = 0; i < 10; i++) slots.use('a', 1_000 + i)
    expect(slots.free('a', 2_000)).toBe(0)
    // A sliding minute: the first call ages out, freeing exactly one.
    expect(slots.free('a', 61_000)).toBe(1)
  })

  it('rests a rate-limited key for a whole minute', () => {
    const slots = createKeySlots(() => 10)
    slots.pause('a', 0)
    expect(slots.free('a', 59_000)).toBe(0)
    expect(slots.free('a', 60_000)).toBe(10)
  })

  it('reads the budget live, so a flag change applies at once', () => {
    let cap = 10
    const slots = createKeySlots(() => cap)
    cap = 3
    expect(slots.free('a', 0)).toBe(3)
  })
})

describe('allocate', () => {
  it('spreads calls round-robin and respects each key', () => {
    const free = (k: string) => ({ a: 2, b: 1, c: 0 } as Record<string, number>)[k]
    expect(allocate(['a', 'b', 'c'], free, 10)).toEqual(['a', 'b', 'a'])
  })
  it('stops at what was asked for', () => {
    expect(allocate(['a', 'b'], () => 10, 3)).toEqual(['a', 'b', 'a'])
  })
})

describe('classifyFailure', () => {
  it('⚠️ an expired log is gone for good', () => {
    expect(classifyFailure(new TornApiError(LOG_GONE_CODE, 'Incorrect log ID'))).toEqual({ kind: 'gone' })
  })
  it('separates the key, the rate limit, and an outage', () => {
    expect(classifyFailure(new TornApiError(2, 'Incorrect key')).kind).toBe('bad-key')
    expect(classifyFailure(new TornApiError(5, 'Too many requests')).kind).toBe('rate-limited')
    expect(classifyFailure(new TornApiError(9, 'API disabled')).kind).toBe('outage')
    expect(classifyFailure(new TornUnavailableError('HTTP 502', 502)).kind).toBe('outage')
    expect(classifyFailure(new Error('weird')).kind).toBe('retry')
  })
})

describe('retryDelayMs', () => {
  it('doubles from two minutes and caps at an hour', () => {
    expect(retryDelayMs(1)).toBe(120_000)
    expect(retryDelayMs(2)).toBe(240_000)
    expect(retryDelayMs(20)).toBe(3_600_000)
  })
})

describe('backlogGrowing', () => {
  const at = (min: number, backlog: number) => ({ at: min * 60_000, backlog })
  it('⚠️ flags a backlog that keeps climbing', () => {
    expect(backlogGrowing([at(0, 10), at(3, 20), at(6, 40), at(9, 80)], 9 * 60_000)).toBe(true)
  })
  it('does not flag a burst being caught up on', () => {
    expect(backlogGrowing([at(0, 10), at(3, 200), at(6, 120), at(9, 60)], 9 * 60_000)).toBe(false)
  })
  it('does not flag on too little history, or an empty backlog', () => {
    expect(backlogGrowing([at(0, 10), at(1, 20)], 60_000)).toBe(false)
    expect(backlogGrowing([at(0, 0), at(3, 0), at(6, 0)], 6 * 60_000)).toBe(false)
  })
})
