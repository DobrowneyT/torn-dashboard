// The header version chip (#394).
//
// Pure string assembly, kept out of Header.jsx because frontend tests here run
// in node with no jsdom — there is nothing to render a component into.
import { describe, it, expect } from 'vitest'
import { versionLabel } from '../versionLabel'

describe('versionLabel', () => {
  it('shows the version and the tenant, because the version alone is ambiguous', () => {
    // Five deployments run the same build. "3.19.1" does not say which one.
    const l = versionLabel({ running: '3.19.1', slug: 'tnl' })
    expect(l.text).toBe('v3.19.1')
    expect(l.copyText).toBe('3.19.1 / tnl')
    expect(l.stale).toBe(false)
  })

  it('carries both versions when the tab is behind the server', () => {
    const l = versionLabel({ running: '3.18.1', serving: '3.19.1', slug: 'tnl' })
    expect(l.stale).toBe(true)
    expect(l.text).toContain('3.18.1')
    expect(l.text).toContain('3.19.1')
    // The copy string is what lands in a bug report, so it must carry the skew.
    expect(l.copyText).toBe('3.18.1 / tnl (server 3.19.1)')
  })

  it('is not stale when the versions match', () => {
    expect(versionLabel({ running: '3.19.1', serving: '3.19.1', slug: 'tnl' }).stale).toBe(false)
  })

  it('is not stale when the server version is unknown', () => {
    // /api/health unreachable. No information is not the same as out of date —
    // an outage must not paint every tab amber.
    expect(versionLabel({ running: '3.19.1', serving: null, slug: 'tnl' }).stale).toBe(false)
    expect(versionLabel({ running: '3.19.1', slug: 'tnl' }).stale).toBe(false)
  })

  it('returns null when the running version is unknown', () => {
    // Never "vundefined". With no version there is no claim to make, so the
    // chip renders nothing at all.
    for (const running of [undefined, null, '']) {
      expect(versionLabel({ running, slug: 'tnl' })).toBeNull()
    }
  })

  it('omits the slug rather than guessing it', () => {
    // Identity resolves asynchronously, and its fallback is Forge. A bug report
    // stamped with the wrong tenant is worse than one stamped with none.
    const l = versionLabel({ running: '3.19.1', slug: '' })
    expect(l.text).toBe('v3.19.1')
    expect(l.copyText).toBe('3.19.1')
    expect(l.copyText).not.toContain('forge')
    expect(versionLabel({ running: '3.19.1' }).copyText).toBe('3.19.1')
  })

  it('omits the slug when identity has not resolved, even if one is passed', () => {
    const l = versionLabel({ running: '3.19.1', slug: 'forge', resolved: false })
    expect(l.copyText).toBe('3.19.1')
  })

  it('includes the slug once identity has resolved', () => {
    expect(versionLabel({ running: '3.19.1', slug: 'mayhem', resolved: true }).copyText)
      .toBe('3.19.1 / mayhem')
  })

  it('describes itself for a tooltip and a screen reader', () => {
    expect(versionLabel({ running: '3.19.1', slug: 'tnl' }).title).toMatch(/copy/i)
    expect(versionLabel({ running: '3.18.1', serving: '3.19.1', slug: 'tnl' }).title)
      .toMatch(/reload|update|newer/i)
  })
})
