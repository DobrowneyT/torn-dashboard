import { describe, expect, it } from 'vitest'
import {
  secondsUntil, formatCountdown, isAttackable, availabilityKey,
} from '../grudgeCountdown.js'

const NOW = Date.UTC(2026, 9, 4, 12, 0, 0)
const atSec = (offset) => Math.floor(NOW / 1000) + offset

describe('secondsUntil', () => {
  it('counts down from a Torn epoch in SECONDS', () => {
    expect(secondsUntil(atSec(600), NOW)).toBe(600)
  })

  it('⚠️ never goes negative — a passed deadline is zero', () => {
    // A negative countdown renders as "-3m 00s", which reads as a bug.
    expect(secondsUntil(atSec(-500), NOW)).toBe(0)
  })

  it('⚠️ treats 0 and missing as NO deadline, not as "out now"', () => {
    // Torn sends until: 0 for a state with no end. Reading that as a deadline
    // that has passed would mark a traveller as attackable.
    expect(secondsUntil(0, NOW)).toBeNull()
    expect(secondsUntil(null, NOW)).toBeNull()
    expect(secondsUntil(undefined, NOW)).toBeNull()
  })
})

describe('formatCountdown', () => {
  it('⚠️ zero-pads below an hour so the column does not jitter', () => {
    expect(formatCountdown(724)).toBe('12m 04s')
    expect(formatCountdown(65)).toBe('1m 05s')
  })
  it('drops to hours and days as it grows', () => {
    expect(formatCountdown(3720)).toBe('1h 02m')
    expect(formatCountdown(280_000)).toBe('3d 5h')
  })
  it('says "now" at zero rather than "0m 00s"', () => {
    expect(formatCountdown(0)).toBe('now')
  })
  it('is null when there is nothing to count', () => {
    expect(formatCountdown(null)).toBeNull()
  })
})

describe('isAttackable', () => {
  it('says yes for Okay', () => {
    expect(isAttackable({ status_state: 'Okay' }, NOW)).toBe(true)
  })

  it('⚠️ says yes once a hospital timer has RUN OUT on an open page', () => {
    // The server still says Hospital — it refreshes every fifteen minutes —
    // but the clock says they are out. That is the case this page exists for.
    expect(isAttackable({ status_state: 'Hospital', status_until: atSec(-1) }, NOW)).toBe(true)
  })

  it('says no while they are still in hospital', () => {
    expect(isAttackable({ status_state: 'Hospital', status_until: atSec(600) }, NOW)).toBe(false)
  })

  it('⚠️ says no for travelling and jail, which have no "timer ran out" rescue', () => {
    expect(isAttackable({ status_state: 'Traveling', status_until: atSec(-100) }, NOW)).toBe(false)
    expect(isAttackable({ status_state: 'Jail', status_until: atSec(-100) }, NOW)).toBe(false)
  })

  it('says no when we have never read a state', () => {
    expect(isAttackable({}, NOW)).toBe(false)
    expect(isAttackable(null, NOW)).toBe(false)
  })
})

describe('availabilityKey', () => {
  it('puts attackable targets first', () => {
    expect(availabilityKey({ status_state: 'Okay' }, NOW)).toBe(0)
  })

  it('orders the rest by how soon they are out', () => {
    const soon = availabilityKey({ status_state: 'Hospital', status_until: atSec(60) }, NOW)
    const later = availabilityKey({ status_state: 'Hospital', status_until: atSec(600) }, NOW)
    expect(soon).toBeLessThan(later)
  })

  it('⚠️ sinks a target with no deadline instead of treating it as "now"', () => {
    // Unknown is not available. Sorting it to the top puts a question mark at
    // the head of a list people act on in a hurry.
    const unknown = availabilityKey({ status_state: 'Traveling' }, NOW)
    const far = availabilityKey({ status_state: 'Hospital', status_until: atSec(99999) }, NOW)
    expect(unknown).toBeGreaterThan(far)
  })
})
