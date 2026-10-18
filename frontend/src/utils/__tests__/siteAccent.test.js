// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { accentScale, siteAccentFor, applySiteAccent, ACCENT_STEPS } from '../siteAccent'

const live = { phase: 'live', theme_color: '#f97316', site_accent: true }

// WCAG relative luminance contrast, for "can white text sit on the button?".
function contrast(a, b) {
  const lum = (t) => {
    const [r, g, b2] = t.split(' ').map(Number).map((c) => {
      const s = c / 255
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b2
  }
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe('accentScale', () => {
  it('keeps the event colour itself as 500', () => {
    expect(accentScale('#f97316')[500]).toBe('249 115 22')
  })

  it('runs light to dark, every step', () => {
    const s = accentScale('#f97316')
    const sum = (t) => t.split(' ').map(Number).reduce((a, b) => a + b, 0)
    const sums = ACCENT_STEPS.map((k) => sum(s[k]))
    expect([...sums].sort((a, b) => b - a)).toEqual(sums)
  })

  it('⚠️ white button text stays readable on the 600 shade (Halloween orange)', () => {
    expect(contrast(accentScale('#f97316')[600], '255 255 255')).toBeGreaterThanOrEqual(3)
  })

  it('refuses a bad colour', () => {
    expect(accentScale('orange')).toBeNull()
    expect(accentScale(null)).toBeNull()
  })
})

describe('siteAccentFor', () => {
  it('only while the event is LIVE and allows it', () => {
    expect(siteAccentFor(live)).not.toBeNull()
    expect(siteAccentFor({ ...live, phase: 'upcoming' })).toBeNull()
    expect(siteAccentFor({ ...live, site_accent: false })).toBeNull()
    expect(siteAccentFor(null)).toBeNull()
  })
})

describe('applySiteAccent', () => {
  it('sets the scale on <html>, and ⚠️ removes every trace when the event ends', () => {
    const root = document.createElement('html')
    applySiteAccent(live, root)
    expect(root.style.getPropertyValue('--accent-600')).not.toBe('')
    expect(root.dataset.eventAccent).toBe('#f97316')
    applySiteAccent(null, root)
    for (const k of ACCENT_STEPS) expect(root.style.getPropertyValue(`--accent-${k}`)).toBe('')
    expect(root.dataset.eventAccent).toBeUndefined()
  })
})
