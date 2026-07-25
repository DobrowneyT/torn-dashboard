import { describe, it, expect } from 'vitest'
import { parsePushTarget, pushTargetEpoch, pushHeadlineText, formatPushCountdown } from '../pushHeadline'

describe('parsePushTarget', () => {
  it('extracts the epoch from a push headline', () => {
    expect(parsePushTarget('PUSH@1737764700')).toBe(1737764700)
    expect(parsePushTarget('  PUSH@42  ')).toBe(42)
  })
  it('returns null for anything else', () => {
    expect(parsePushTarget('STOP ALL HITS')).toBeNull()
    expect(parsePushTarget('PUSH 2 01:45')).toBeNull()   // the old format is not a countdown
    expect(parsePushTarget('PUSH@')).toBeNull()
    expect(parsePushTarget(null)).toBeNull()
  })
})

describe('pushTargetEpoch', () => {
  it('resolves a later time today', () => {
    const now = new Date('2026-07-25T01:00:00')          // local
    const epoch = pushTargetEpoch('01:45', now)
    expect(epoch).toBe(Math.floor(new Date('2026-07-25T01:45:00').getTime() / 1000))
  })
  it('rolls a past time to tomorrow', () => {
    const now = new Date('2026-07-25T02:00:00')
    const epoch = pushTargetEpoch('01:45', now)
    expect(epoch).toBe(Math.floor(new Date('2026-07-26T01:45:00').getTime() / 1000))
  })
  it('rejects malformed input', () => {
    expect(pushTargetEpoch('25:99')).toBeNull()
    expect(pushTargetEpoch('nope')).toBeNull()
  })
})

describe('pushHeadlineText', () => {
  it('round-trips through parsePushTarget', () => {
    const now = new Date('2026-07-25T01:00:00')
    const text = pushHeadlineText('01:30', now)
    expect(text).toMatch(/^PUSH@\d+$/)
    expect(parsePushTarget(text)).toBe(pushTargetEpoch('01:30', now))
  })
})

describe('formatPushCountdown', () => {
  it('formats minutes:seconds under an hour', () => {
    expect(formatPushCountdown(300)).toBe('PUSH IN 5:00')
    expect(formatPushCountdown(277)).toBe('PUSH IN 4:37')
    expect(formatPushCountdown(9)).toBe('PUSH IN 0:09')
  })
  it('includes hours when over an hour out', () => {
    expect(formatPushCountdown(3877)).toBe('PUSH IN 1:04:37')
  })
  it('says PUSH NOW at or past zero', () => {
    expect(formatPushCountdown(0)).toBe('PUSH NOW')
    expect(formatPushCountdown(-5)).toBe('PUSH NOW')
  })
})
