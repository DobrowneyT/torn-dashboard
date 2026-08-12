// Faction identity resolution (#393).
//
// The bug this pins: `getFactionId()` read at MODULE SCOPE runs before
// /api/bootstrap answers, so it returns the config.js fallback — Forge's id.
// On Forge that is accidentally correct; on every other tenant it silently
// filtered the tenant's own data away, and RW Payout Management reported
// "No contribution data available for this war" on wars that had synced fine.
//
// ⚠️ Every fixture here uses a NON-FORGE faction id on purpose. The existing
// payout tests use 10739 throughout, which is precisely why they passed
// against the bug: with Forge's id as the fixture, "resolved correctly" and
// "fell back to Forge" are indistinguishable.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const FORGE_ID = 10739      // the fallback baked into config.js
const TNL_ID = 6731         // a real other tenant — must never equal FORGE_ID

async function freshModule({ bootstrap }) {
  vi.resetModules()
  vi.doMock('../apiClient', () => ({ apiBootstrap: bootstrap }))
  return import('../factionIdentity')
}

beforeEach(() => { vi.resetModules() })
afterEach(() => { vi.doUnmock('../apiClient'); vi.restoreAllMocks() })

describe('the fallback', () => {
  it('is Forge, which is why an early read is invisible on Forge', () => {
    // Not asserting this is good — asserting it is TRUE, so the reason the
    // trap is dangerous is written down in a place that fails if it changes.
    expect(TNL_ID).not.toBe(FORGE_ID)
  })
})

describe('getFactionId after bootstrap', () => {
  it('returns the tenant it resolved, not the fallback', async () => {
    const mod = await freshModule({
      bootstrap: vi.fn().mockResolvedValue({
        ok: true,
        faction: { torn_faction_id: TNL_ID, display_name: 'TNL', slug: 'tnl' },
      }),
    })
    await mod.loadFactionIdentity()
    expect(mod.getFactionId()).toBe(TNL_ID)
    expect(mod.getFactionId()).not.toBe(FORGE_ID)
  })

  it('reports identity as resolved', async () => {
    const mod = await freshModule({
      bootstrap: vi.fn().mockResolvedValue({
        ok: true,
        faction: { torn_faction_id: TNL_ID, display_name: 'TNL', slug: 'tnl' },
      }),
    })
    expect(mod.isFactionIdentityResolved()).toBe(false)   // before
    await mod.loadFactionIdentity()
    expect(mod.isFactionIdentityResolved()).toBe(true)    // after
  })
})

describe('getFactionId BEFORE bootstrap — the trap', () => {
  it('falls back to Forge, which is wrong for every other tenant', async () => {
    // This is the actual defect, pinned as behaviour rather than left implicit.
    // A caller that stores THIS value has pinned itself to Forge for the life
    // of the page.
    const mod = await freshModule({ bootstrap: vi.fn(() => new Promise(() => {})) })
    expect(mod.getFactionId()).toBe(FORGE_ID)
    expect(mod.isFactionIdentityResolved()).toBe(false)
  })

  it('says so loudly in dev instead of failing silently', async () => {
    // Silence is what let this ship twice (#249, then #393).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mod = await freshModule({ bootstrap: vi.fn(() => new Promise(() => {})) })
    mod.getFactionIdentity()
    if (import.meta.env?.DEV) {
      expect(warn).toHaveBeenCalled()
      expect(String(warn.mock.calls[0][0])).toMatch(/before .*bootstrap/i)
    }
  })

  it('stops warning once identity has resolved', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mod = await freshModule({
      bootstrap: vi.fn().mockResolvedValue({
        ok: true,
        faction: { torn_faction_id: TNL_ID, display_name: 'TNL', slug: 'tnl' },
      }),
    })
    await mod.loadFactionIdentity()
    warn.mockClear()
    mod.getFactionIdentity()
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('bootstrap failure', () => {
  it('falls back rather than throwing, so the login screen still renders', async () => {
    // The fallback exists for a reason — it must not be removed as a "fix".
    const mod = await freshModule({ bootstrap: vi.fn().mockRejectedValue(new Error('offline')) })
    await mod.loadFactionIdentity()
    expect(mod.getFactionId()).toBe(FORGE_ID)
    // …but it must not claim to be resolved, so callers that care can tell.
    expect(mod.isFactionIdentityResolved()).toBe(false)
  })

  it('treats a not-ok bootstrap the same way', async () => {
    const mod = await freshModule({ bootstrap: vi.fn().mockResolvedValue({ ok: false }) })
    await mod.loadFactionIdentity()
    expect(mod.isFactionIdentityResolved()).toBe(false)
  })
})

describe('no module-scope capture survives anywhere in src', () => {
  // The guard that actually prevents recurrence. The tests above prove the
  // FUNCTION behaves; this proves no CALLER reintroduces the trap, which is
  // the thing that shipped twice.
  //
  // Scans real source rather than trusting review: #249 fixed the literals and
  // review did not notice that two replacements landed at module scope.
  it('finds no top-level `const X = getFactionId()`', () => {
    const srcDir = path.resolve(__dirname, '../..')
    const offenders = []

    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === '__tests__' || entry.name === 'node_modules') continue
          walk(full)
        } else if (/\.(js|jsx)$/.test(entry.name)) {
          fs.readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
            // Top-level only: `const` in column 0. Indented ones sit inside a
            // function or component, which is the correct usage.
            if (/^const\s+\w+\s*=\s*getFactionId\s*\(/.test(line)) {
              offenders.push(path.relative(srcDir, full) + ':' + (i + 1))
            }
          })
        }
      }
    }
    walk(srcDir)

    expect(
      offenders,
      'Identity captured at module scope resolves BEFORE /api/bootstrap and ' +
      'silently returns the Forge fallback — correct on Forge, wrong on every ' +
      'other tenant. Read it inside the component instead. (#393)'
    ).toEqual([])
  })
})
