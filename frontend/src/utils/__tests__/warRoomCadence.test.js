import { describe, expect, it } from 'vitest'
import { clampCadence } from '../warRoomCadence.js'

describe('clampCadence — 0 means off', () => {
  // ⚠️ The bug: `Number(x) || fallback`. Zero is falsy, so a deliberate 0 came
  // back as the default and the field reverted in front of the operator — no
  // error, nothing logged, just a setting that would not stick.

  it('⚠️ keeps a typed 0 as 0', () => {
    expect(clampCadence('0', 30, 5)).toBe(0)
    expect(clampCadence(0, 30, 5)).toBe(0)
    expect(clampCadence('0', 5, 1)).toBe(0)
  })

  it('treats a negative as off rather than as a floor', () => {
    expect(clampCadence('-10', 30, 5)).toBe(0)
  })

  it('⚠️ raises a below-floor positive to the floor, never to 0', () => {
    // Someone typing 2 wants polling, just faster than we will safely do.
    // Collapsing that to "off" would silently do the opposite of the ask.
    expect(clampCadence('2', 30, 5)).toBe(5)
    expect(clampCadence('1', 5, 1)).toBe(1)
  })

  it('passes a valid value through untouched', () => {
    expect(clampCadence('45', 30, 5)).toBe(45)
    expect(clampCadence('600', 30, 5)).toBe(600)
  })

  it('caps at the maximum', () => {
    expect(clampCadence('9999', 30, 5)).toBe(600)
  })

  it('floors a fraction so 0.9 cannot round up past the floor', () => {
    expect(clampCadence('5.9', 30, 5)).toBe(5)
    expect(clampCadence('0.9', 30, 5)).toBe(0)
  })

  it('⚠️ treats a CLEARED input as the default, not as off', () => {
    // Off has to be typed. An empty box is someone mid-edit, and turning the
    // poller off because they selected-all and paused would be a nasty
    // surprise during a chain.
    expect(clampCadence('', 30, 5)).toBe(30)
    expect(clampCadence('   ', 30, 5)).toBe(30)
    expect(clampCadence(null, 30, 5)).toBe(30)
    expect(clampCadence(undefined, 30, 5)).toBe(30)
  })

  it('falls back rather than storing NaN for junk', () => {
    expect(clampCadence('abc', 30, 5)).toBe(30)
  })
})
