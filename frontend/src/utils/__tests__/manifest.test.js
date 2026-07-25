import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// The shipped PWA assets. The manifest itself is now generated per-tenant by the
// faction API (see server/src/manifest.ts + its test); here we guard the static
// pieces the SPA ships: the default icon files the manifest points at, and that
// the service worker stays a single push-extendable file.
const here = dirname(fileURLToPath(import.meta.url))
const publicDir = resolve(here, '..', '..', '..', 'public')

describe('default PWA icons', () => {
  it('ships the 192, 512 and maskable tiles the manifest references', () => {
    for (const icon of ['pwa-icon-192.png', 'pwa-icon-512.png', 'pwa-maskable-512.png', 'apple-touch-icon.png']) {
      expect(existsSync(resolve(publicDir, 'icons', icon)), `missing icon ${icon}`).toBe(true)
    }
  })
})

describe('service worker', () => {
  const sw = readFileSync(resolve(publicDir, 'sw.js'), 'utf8')

  it('handles fetch for app-shell caching', () => {
    expect(sw).toMatch(/addEventListener\(\s*['"]fetch['"]/)
  })

  it('never intercepts the API', () => {
    expect(sw).toMatch(/\/api\//)
  })

  it('has a push handler for War Room notifications (#207)', () => {
    expect(sw).toMatch(/addEventListener\(\s*['"]push['"]/)
  })
})
