import { describe, it, expect } from 'vitest'
import { maskKeyHint } from '../keyMask.js'

describe('maskKeyHint (#264)', () => {
  it('masks a last-4 hint', () => {
    expect(maskKeyHint('3456')).toBe('••••3456')
  })

  it('returns null when there is no hint (no key on file)', () => {
    expect(maskKeyHint(null)).toBeNull()
    expect(maskKeyHint(undefined)).toBeNull()
    expect(maskKeyHint('')).toBeNull()
  })
})
