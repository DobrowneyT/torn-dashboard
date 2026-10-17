import { describe, expect, it, vi } from 'vitest'
import { hashTargetFor, translatePathToHash } from '../pathToHashRoute'

const at = (pathname, extra = {}) => ({
  origin: 'https://forge.monchoon.me', pathname, search: '', hash: '', ...extra,
})

describe('hashTargetFor (#969)', () => {
  it('⚠️ sends the Discord bot\'s sign-up link to the hash route', () => {
    // The link the bot has posted all along, which used to land on the home page.
    expect(hashTargetFor(at('/members/chain-watch')))
      .toBe('https://forge.monchoon.me/#/members/chain-watch')
  })

  it('leaves the root alone', () => {
    expect(hashTargetFor(at('/'))).toBeNull()
    expect(hashTargetFor(at('/index.html'))).toBeNull()
  })

  it('⚠️ an existing hash wins', () => {
    expect(hashTargetFor(at('/members/chain-watch', { hash: '#/rw/war-room' }))).toBeNull()
  })

  it('treats an empty hash as no hash', () => {
    expect(hashTargetFor(at('/oc', { hash: '#' }))).toBe('https://forge.monchoon.me/#/oc')
    expect(hashTargetFor(at('/oc', { hash: '#/' }))).toBe('https://forge.monchoon.me/#/oc')
  })

  it('keeps the query string', () => {
    expect(hashTargetFor(at('/events', { search: '?tab=report' })))
      .toBe('https://forge.monchoon.me/#/events?tab=report')
  })

  it('drops a trailing slash', () => {
    expect(hashTargetFor(at('/members/chain-watch/')))
      .toBe('https://forge.monchoon.me/#/members/chain-watch')
  })

  it('leaves a real file alone', () => {
    expect(hashTargetFor(at('/favicon.ico'))).toBeNull()
    expect(hashTargetFor(at('/sw.js'))).toBeNull()
  })
})

describe('translatePathToHash', () => {
  it('⚠️ replaces rather than pushes, so Back does not bounce', () => {
    const win = { location: at('/members/chain-watch'), history: { replaceState: vi.fn() } }
    translatePathToHash(win)
    expect(win.history.replaceState).toHaveBeenCalledWith(
      null, '', 'https://forge.monchoon.me/#/members/chain-watch')
  })

  it('does nothing at the root', () => {
    const win = { location: at('/'), history: { replaceState: vi.fn() } }
    translatePathToHash(win)
    expect(win.history.replaceState).not.toHaveBeenCalled()
  })
})
