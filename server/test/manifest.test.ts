// Per-tenant PWA manifest (follow-up to #206): each faction API serves its own
// name/icons so an installed app isn't branded as the shared default.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'
import { buildManifest } from '../src/manifest.js'

describe('buildManifest (pure)', () => {
  it('uses the tenant display name and default icons when no logo is set', () => {
    const m = buildManifest({ display_name: 'Capacity X Dashboard', branding: {} })
    expect(m.name).toBe('Capacity X Dashboard')
    expect(m.short_name).toBe('Capacity')            // first word, ≤12 chars
    expect(m.display).toBe('standalone')
    expect(m.start_url).toBe('/?source=pwa')
    expect(m.icons).toEqual([
      { src: '/icons/pwa-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/pwa-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ])
  })

  it('prefers a branding tag for short_name', () => {
    expect(buildManifest({ display_name: 'The Next Level', branding: { tag: 'TNL' } }).short_name).toBe('TNL')
  })

  it('points icons at the tenant logo when one is set', () => {
    const m = buildManifest({ display_name: 'Forge', branding: { logo: '/api/branding/logo?v=9' } })
    expect(m.icons).toEqual([
      { src: '/api/branding/logo?v=9', sizes: '192x192', purpose: 'any' },
      { src: '/api/branding/logo?v=9', sizes: '512x512', purpose: 'any' },
      { src: '/api/branding/logo?v=9', sizes: '512x512', purpose: 'maskable' },
    ])
  })

  it('never breaks on a missing display name', () => {
    expect(buildManifest({ display_name: '', branding: null }).name).toBe('Faction Dashboard')
  })
})

describe('GET /api/manifest.webmanifest', () => {
  let stack: TestStack
  beforeAll(async () => { stack = await startTestStack() }, 30000)
  afterAll(async () => { await stack?.close() })

  it('serves the tenant manifest publicly (no auth) with the manifest content type', async () => {
    const res = await fetch(`${stack.baseUrl}/api/manifest.webmanifest`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/manifest+json')
    const body = (await res.json()) as any
    expect(body.name).toBe(TEST_FACTION.displayName)
    expect(body.scope).toBe('/')
    expect(Array.isArray(body.icons)).toBe(true)
  })
})
