import { describe, expect, it } from 'vitest'
import { ffRedHigh, FF_RED_HIGH_DEFAULT } from '../src/displaySettings.js'

describe('ffRedHigh (#995)', () => {
  it('uses a set value above 3', () => {
    expect(ffRedHigh(5)).toBe(5)
    expect(ffRedHigh('5.5')).toBe(5.5)
  })
  it('⚠️ falls back for unset, junk, or a value at/below green (3)', () => {
    expect(ffRedHigh(undefined)).toBe(FF_RED_HIGH_DEFAULT)
    expect(ffRedHigh('six')).toBe(FF_RED_HIGH_DEFAULT)
    expect(ffRedHigh(3)).toBe(FF_RED_HIGH_DEFAULT)
    expect(ffRedHigh(null)).toBe(FF_RED_HIGH_DEFAULT)
  })
})
