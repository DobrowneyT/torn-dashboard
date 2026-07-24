import { describe, it, expect } from 'vitest'
import { PUSH_HEADLINE_PRESETS } from '../HeadlineBanner'

// #209: the surge banner one-taps PUSH_HEADLINE_PRESETS[surgeAlert.direction],
// where direction is 'enemy' | 'our' (from the #208 detector). These keys and
// tones are the contract that keeps the one-tap wired to the right preset.
describe('push-headline presets (#209)', () => {
  it('has a defensive (enemy) and offensive (our) preset keyed by surge direction', () => {
    expect(Object.keys(PUSH_HEADLINE_PRESETS).sort()).toEqual(['enemy', 'our'])
  })

  it('defensive is danger-toned, offensive is go-toned, both with copy', () => {
    expect(PUSH_HEADLINE_PRESETS.enemy.tone).toBe('danger')
    expect(PUSH_HEADLINE_PRESETS.our.tone).toBe('go')
    expect(PUSH_HEADLINE_PRESETS.enemy.text.length).toBeGreaterThan(0)
    expect(PUSH_HEADLINE_PRESETS.our.text.length).toBeGreaterThan(0)
    expect(PUSH_HEADLINE_PRESETS.enemy.text).not.toBe(PUSH_HEADLINE_PRESETS.our.text)
  })
})
