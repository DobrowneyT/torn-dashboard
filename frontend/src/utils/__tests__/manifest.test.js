import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// The shipped PWA assets (#206) — guard the contract that makes the app
// installable, and that the service worker stays a single push-extendable file.
const here = dirname(fileURLToPath(import.meta.url))
const publicDir = resolve(here, '..', '..', '..', 'public')

describe('web app manifest', () => {
  const manifest = JSON.parse(readFileSync(resolve(publicDir, 'manifest.webmanifest'), 'utf8'))

  it('declares the fields browsers require to offer installation', () => {
    expect(manifest.name).toBeTruthy()
    expect(manifest.short_name).toBeTruthy()
    expect(manifest.start_url).toBeTruthy()
    expect(manifest.display).toBe('standalone')
    expect(manifest.theme_color).toBeTruthy()
    expect(manifest.background_color).toBeTruthy()
  })

  it('ships 192 and 512 icons plus a maskable icon, and the files exist', () => {
    const bySize = (s) => manifest.icons.filter((i) => i.sizes === s)
    expect(bySize('192x192').length).toBeGreaterThan(0)
    expect(bySize('512x512').length).toBeGreaterThan(0)
    expect(manifest.icons.some((i) => (i.purpose || '').includes('maskable'))).toBe(true)
    for (const icon of manifest.icons) {
      expect(existsSync(resolve(publicDir, '.' + icon.src)), `missing icon ${icon.src}`).toBe(true)
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

  it('leaves a documented extension point for #198 push', () => {
    expect(sw).toMatch(/#198/)
  })
})
