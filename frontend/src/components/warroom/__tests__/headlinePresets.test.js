import { describe, it, expect } from 'vitest'
import { PUSH_HEADLINE_PRESETS, REVIVE_HEADLINE_PRESETS, surgeHeadlinePreset } from '../HeadlineBanner'

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

describe('revive-surge headline presets (#359)', () => {
  it('has its own copy, distinct from the status presets', () => {
    // A revive surge fires BEFORE the push lands. Reusing "we're being pushed —
    // retaliate" would have a faction spend its chain on a push that has not
    // started, which is the opposite of the intended call.
    expect(REVIVE_HEADLINE_PRESETS.enemy.text).not.toBe(PUSH_HEADLINE_PRESETS.enemy.text)
    expect(REVIVE_HEADLINE_PRESETS.our.text).not.toBe(PUSH_HEADLINE_PRESETS.our.text)
  })

  it('warns rather than alarms on the incoming side', () => {
    // Not yet danger: nothing has happened, they are getting ready.
    expect(REVIVE_HEADLINE_PRESETS.enemy.tone).toBe('warn')
    expect(REVIVE_HEADLINE_PRESETS.our.tone).toBe('go')
  })
})

describe('surgeHeadlinePreset', () => {
  it('routes by kind', () => {
    expect(surgeHeadlinePreset('revive', 'enemy')).toBe(REVIVE_HEADLINE_PRESETS.enemy)
    expect(surgeHeadlinePreset('status', 'enemy')).toBe(PUSH_HEADLINE_PRESETS.enemy)
  })

  it('falls back to the status set when no kind is given', () => {
    // An alert from a server predating #359 carries no kind, and must still
    // one-tap to the preset it always did.
    expect(surgeHeadlinePreset(undefined, 'enemy')).toBe(PUSH_HEADLINE_PRESETS.enemy)
    expect(surgeHeadlinePreset(null, 'our')).toBe(PUSH_HEADLINE_PRESETS.our)
  })

  it('returns null for a direction it does not know', () => {
    expect(surgeHeadlinePreset('status', 'sideways')).toBeNull()
    expect(surgeHeadlinePreset('revive', undefined)).toBeNull()
  })
})
