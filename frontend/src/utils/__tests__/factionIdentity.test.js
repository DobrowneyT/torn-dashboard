import { describe, it, expect } from 'vitest'
import { apiKeyTitleFor, faviconHrefFor, DEFAULT_FAVICON } from '../factionIdentity'
import { config } from '../../config'

// The Torn API key title/comment (#131): must reflect the current tenant's
// own faction once identity has genuinely resolved from the API-mode
// bootstrap, not a hardcoded 'Forge-Dashboard' shown to every tenant.

describe('apiKeyTitleFor', () => {
  it('brands the key with the resolved tenant display name', () => {
    expect(apiKeyTitleFor({ displayName: 'Mayhem', resolved: true })).toBe('Mayhem-Dashboard')
  })

  it('brands a different tenant correctly (proves it is not hardcoded)', () => {
    expect(apiKeyTitleFor({ displayName: 'Ascension', resolved: true })).toBe('Ascension-Dashboard')
  })

  it('falls back to the static config title when identity is unresolved (legacy mode / not yet loaded)', () => {
    expect(apiKeyTitleFor({ displayName: 'whatever', resolved: false })).toBe(config.apiKey.title)
    expect(apiKeyTitleFor({ displayName: 'whatever' })).toBe(config.apiKey.title)
  })
})

describe('faviconHrefFor', () => {
  it('uses the faction\'s own branding.favicon when the leader has set one', () => {
    expect(faviconHrefFor({ branding: { favicon: '/img/mayhem-icon.ico' } })).toBe('/img/mayhem-icon.ico')
  })

  it('falls back to the shared default when no per-faction favicon is set', () => {
    expect(faviconHrefFor({ branding: {} })).toBe(DEFAULT_FAVICON)
    expect(faviconHrefFor({ branding: { favicon: '' } })).toBe(DEFAULT_FAVICON)
    expect(faviconHrefFor({})).toBe(DEFAULT_FAVICON)
  })
})
