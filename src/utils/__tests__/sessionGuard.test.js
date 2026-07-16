import { describe, it, expect } from 'vitest'
import { checkStoredSession } from '../sessionGuard'

// Saved sessions minted before the 2.0 consolidated-key rollout (d68d854)
// never passed through the API-key disclosure, so their keys never joined
// the rotation pool. checkStoredSession is the gate that retires them: a
// stored user whose consentVersion doesn't match the current one must be
// sent back through the login (and its disclosure) exactly once.

describe('checkStoredSession', () => {
  const CURRENT = '2.0'

  it('accepts a session whose consentVersion matches the current one', () => {
    const result = checkStoredSession({ id: 1, consentVersion: '2.0' }, CURRENT)
    expect(result.ok).toBe(true)
  })

  it('rejects a pre-consolidation session with no consentVersion at all', () => {
    const result = checkStoredSession({ id: 1, name: 'OldTimer', apiKey: 'k'.repeat(16) }, CURRENT)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/log in/i)
  })

  it('rejects a session stored under an older consentVersion', () => {
    const result = checkStoredSession({ id: 1, consentVersion: '1.0' }, CURRENT)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/log in/i)
  })

  it('rejects garbage saved data instead of throwing', () => {
    expect(checkStoredSession(null, CURRENT).ok).toBe(false)
    expect(checkStoredSession('not-an-object', CURRENT).ok).toBe(false)
    expect(checkStoredSession(42, CURRENT).ok).toBe(false)
  })
})
