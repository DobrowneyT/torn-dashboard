import { describe, expect, it } from 'vitest'
import { formatDuration } from '../duration.js'

describe('formatDuration', () => {
  it('keeps every shape occupancyReport already relied on', () => {
    // ⚠️ These are the assertions from occupancyReport.test.js. The formatter
    // moved and grew a year branch; its existing callers must not shift.
    expect(formatDuration(45)).toBe('45s')
    expect(formatDuration(600)).toBe('10m')
    expect(formatDuration(4 * 3600)).toBe('4h')
    expect(formatDuration(4 * 3600 + 720)).toBe('4h 12m')
    expect(formatDuration(2 * 86400)).toBe('2d')
    expect(formatDuration(2 * 86400 + 3 * 3600)).toBe('2d 3h')
    expect(formatDuration(-500)).toBe('0s')
    expect(formatDuration(null)).toBe('0s')
  })

  it('picks the unit from the value, so each row reads at its own scale', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(59)).toBe('59s')
    expect(formatDuration(90)).toBe('2m')          // rounds, as it always did
    expect(formatDuration(5_400)).toBe('1h 30m')
    expect(formatDuration(86_400)).toBe('1d')
    expect(formatDuration(1_000_000)).toBe('11d 14h')
  })

  it('reaches years, which is what the Hall of Fame needed', () => {
    const YEAR = 365 * 86_400
    expect(formatDuration(YEAR)).toBe('1y')
    expect(formatDuration(YEAR - 86_400)).toBe('364d')
    // The real board's top two travel times.
    expect(formatDuration(72_489_600)).toBe('2y 109d')
    expect(formatDuration(69_638_400)).toBe('2y 76d')
    // And a mid-table one, which stays in days.
    expect(formatDuration(9_849_600)).toBe('114d')
  })

  it('⚠️ carries a rounded unit instead of rendering 24h or 60m', () => {
    // 23h 36m of a day rounds to 24h. "114d 24h" is not wrong so much as
    // obviously unconsidered, and all three branches used to do it.
    expect(formatDuration(114 * 86_400 + 86_000)).toBe('115d')
    expect(formatDuration(3_599)).toBe('1h')
    expect(formatDuration(86_399)).toBe('24h')
    // A year's worth of days must roll into the year, not read as "1y 365d".
    expect(formatDuration(365 * 86_400 + 86_000)).toBe('1y 1d')
    expect(formatDuration(2 * 365 * 86_400 - 100)).toBe('2y')
  })
})
