// Pure helpers behind the live chain watch (#): relative→absolute conversion
// and the poll-cadence / near-expiry decisions.
import { describe, expect, it } from 'vitest'
import {
  absTimer, chainTimersToAbsolute, chainPollDue, chainNearExpiry, CHAIN_FORCE_POLL_SEC,
} from '../src/warRoomChain.js'

describe('absTimer / chainTimersToAbsolute', () => {
  const now = 1_785_500_000
  it('converts a relative duration to an absolute epoch', () => {
    expect(absTimer(184, now)).toBe(now + 184)
  })
  it('treats 0 / negative / non-numeric as no active timer (null)', () => {
    expect(absTimer(0, now)).toBeNull()
    expect(absTimer(-5, now)).toBeNull()
    expect(absTimer(undefined, now)).toBeNull()
    expect(absTimer('x', now)).toBeNull()
  })
  it('rewrites timeout+cooldown but leaves absolute start/end untouched', () => {
    const out = chainTimersToAbsolute({ current: 5, timeout: 184, cooldown: 0, start: 1, end: 2 }, now)
    expect(out).toMatchObject({ current: 5, timeout: now + 184, cooldown: null, start: 1, end: 2 })
  })
})

describe('chainPollDue', () => {
  const nowMs = 1_785_500_000_000
  const nowSec = nowMs / 1000
  it('is due when never fetched', () => {
    expect(chainPollDue(null, 5, nowMs)).toBe(true)
    expect(chainPollDue(undefined, 5, nowMs)).toBe(true)
  })
  it('is due once the interval has elapsed, not before (epoch-seconds input)', () => {
    expect(chainPollDue(nowSec - 5, 5, nowMs)).toBe(true)
    expect(chainPollDue(nowSec - 3, 5, nowMs)).toBe(false)
  })
})

describe('chainNearExpiry', () => {
  const nowEpoch = 1_785_500_000
  it('fires only when the timeout is within the force window and still in the future', () => {
    expect(chainNearExpiry(nowEpoch + 4, nowEpoch, CHAIN_FORCE_POLL_SEC)).toBe(true)   // 4s left
    expect(chainNearExpiry(nowEpoch + 30, nowEpoch, CHAIN_FORCE_POLL_SEC)).toBe(false) // plenty
    expect(chainNearExpiry(nowEpoch - 2, nowEpoch, CHAIN_FORCE_POLL_SEC)).toBe(false)  // already gone
    expect(chainNearExpiry(null, nowEpoch, CHAIN_FORCE_POLL_SEC)).toBe(false)          // no chain
  })
})
