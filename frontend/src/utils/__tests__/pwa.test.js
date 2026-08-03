import { describe, it, expect } from 'vitest'
import { isStandalone, isIos, installAffordance, isInstallDismissed, markInstallDismissed } from '../pwa'

describe('isStandalone', () => {
  it('is true when display-mode: standalone matches', () => {
    const win = { matchMedia: (q) => ({ matches: q === '(display-mode: standalone)' }), navigator: {} }
    expect(isStandalone(win)).toBe(true)
  })
  it('is true for iOS navigator.standalone', () => {
    const win = { matchMedia: () => ({ matches: false }), navigator: { standalone: true } }
    expect(isStandalone(win)).toBe(true)
  })
  it('is false in a normal browser tab', () => {
    const win = { matchMedia: () => ({ matches: false }), navigator: { standalone: false } }
    expect(isStandalone(win)).toBe(false)
  })
  it('is false when no window is available', () => {
    expect(isStandalone(undefined)).toBe(false)
  })
})

describe('isIos', () => {
  it('detects an iPhone', () => {
    expect(isIos({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' })).toBe(true)
  })
  it('detects iPadOS masquerading as macOS with touch', () => {
    expect(isIos({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', maxTouchPoints: 5 })).toBe(true)
  })
  it('is false for a real desktop Mac (no touch)', () => {
    expect(isIos({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', maxTouchPoints: 0 })).toBe(false)
  })
  it('is false for Android/Chrome', () => {
    expect(isIos({ userAgent: 'Mozilla/5.0 (Linux; Android 14)', maxTouchPoints: 5 })).toBe(false)
  })
})

describe('installAffordance', () => {
  it('shows nothing once installed', () => {
    expect(installAffordance({ standalone: true, ios: true, hasPrompt: true })).toBe('none')
  })
  it('shows the Install button when a prompt was captured', () => {
    expect(installAffordance({ standalone: false, ios: false, hasPrompt: true })).toBe('button')
  })
  it('shows iOS instructions on iOS with no prompt', () => {
    expect(installAffordance({ standalone: false, ios: true, hasPrompt: false })).toBe('ios')
  })
  it('shows nothing on a desktop browser with no prompt available', () => {
    expect(installAffordance({ standalone: false, ios: false, hasPrompt: false })).toBe('none')
  })
  it('shows nothing once the user dismissed the prompt', () => {
    expect(installAffordance({ standalone: false, ios: false, hasPrompt: true, dismissed: true })).toBe('none')
  })
})

describe('install dismissal persistence', () => {
  it('round-trips through a storage stub', () => {
    const store = new Map()
    const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }
    expect(isInstallDismissed(storage)).toBe(false)
    markInstallDismissed(storage)
    expect(isInstallDismissed(storage)).toBe(true)
  })
  it('never throws when storage is unavailable', () => {
    const storage = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    expect(() => markInstallDismissed(storage)).not.toThrow()
    expect(isInstallDismissed(storage)).toBe(false)
  })
})
