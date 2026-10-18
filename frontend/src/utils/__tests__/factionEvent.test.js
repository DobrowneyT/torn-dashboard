import { describe, expect, it } from 'vitest'
import {
  landingPathFor, eventIsVisible, tctInputToMs, msToTctInput, formatTct, halloweenDefaults,
} from '../factionEvent'

describe('landingPathFor (#969)', () => {
  it('lands on the event while it is live', () => {
    expect(landingPathFor({ phase: 'live' })).toBe('/events')
  })

  it('⚠️ lands on /dashboard otherwise — never on `/`, which would loop', () => {
    expect(landingPathFor({ phase: 'upcoming' })).toBe('/dashboard')
    expect(landingPathFor(null)).toBe('/dashboard')
  })
})

describe('eventIsVisible', () => {
  it('shows upcoming and live events, hides nothing-or-ended', () => {
    expect(eventIsVisible({ phase: 'upcoming' })).toBe(true)
    expect(eventIsVisible({ phase: 'live' })).toBe(true)
    expect(eventIsVisible({ phase: 'ended' })).toBe(false)
    expect(eventIsVisible(null)).toBe(false)
  })
})

describe('⚠️ TCT input conversion', () => {
  it('reads a datetime-local value as TCT (UTC), not local time', () => {
    expect(tctInputToMs('2026-10-25T10:00')).toBe(Date.UTC(2026, 9, 25, 10))
  })

  it('round-trips', () => {
    const ms = Date.UTC(2026, 10, 1, 16)
    expect(tctInputToMs(msToTctInput(ms))).toBe(ms)
  })

  it('is null for an empty or bad value', () => {
    expect(tctInputToMs('')).toBeNull()
    expect(tctInputToMs('not a date')).toBeNull()
  })

  it('formats as TCT', () => {
    expect(formatTct(Date.UTC(2026, 9, 25, 10))).toBe('25 Oct 10:00 TCT')
    expect(formatTct(null)).toBe('—')
  })
})

describe('halloweenDefaults', () => {
  it('follows the decisions on #967', () => {
    const d = halloweenDefaults(Date.UTC(2026, 9, 17))
    expect(d.starts_at).toBe(Date.UTC(2026, 9, 25, 10))
    expect(d.daily_from).toBe(Date.UTC(2026, 9, 26, 0))
    expect(d.min_ends_at).toBe(Date.UTC(2026, 10, 1, 16))
    expect(d.ends_with_chain).toBe(true)
    expect(d.theme_color).toBe('#f97316')
  })

  it('⚠️ is derived from the year, so next October is right too', () => {
    expect(halloweenDefaults(Date.UTC(2027, 5, 1)).starts_at).toBe(Date.UTC(2027, 9, 25, 10))
  })

  it('suggests next year once this year\'s event is over', () => {
    expect(halloweenDefaults(Date.UTC(2026, 10, 20)).starts_at).toBe(Date.UTC(2027, 9, 25, 10))
  })
})
