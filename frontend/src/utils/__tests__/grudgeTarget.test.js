import { describe, expect, it } from 'vitest'
import { parseTargetId } from '../grudgeTarget.js'

/**
 * ⚠️ These cases are deliberately the SAME as `server/test/grudges.test.ts`.
 * The client copy exists only so the form can object while you type; the
 * server is the authority. Pinning both to one list is what stops them
 * drifting into disagreeing about what a valid link is.
 */
describe('parseTargetId', () => {
  it('reads a pasted profile link', () => {
    expect(parseTargetId('https://www.torn.com/profiles.php?XID=2576356')).toBe('2576356')
    expect(parseTargetId('torn.com/profiles.php?XID=2576356&tab=info')).toBe('2576356')
    expect(parseTargetId('/profiles.php?sid=UserList&XID=90210')).toBe('90210')
  })

  it('⚠️ matches XID case-insensitively', () => {
    expect(parseTargetId('https://www.torn.com/profiles.php?xid=2576356')).toBe('2576356')
  })

  it('reads a bare id', () => {
    expect(parseTargetId('2576356')).toBe('2576356')
    expect(parseTargetId('  2576356  ')).toBe('2576356')
  })

  it('refuses what it cannot resolve rather than guessing', () => {
    expect(parseTargetId('')).toBeNull()
    expect(parseTargetId(null)).toBeNull()
    expect(parseTargetId('Likor')).toBeNull()
    // ⚠️ A FACTION link, not a profile link. Accepting this would add a
    // faction id as if it were a player.
    expect(parseTargetId('https://www.torn.com/factions.php?step=profile&ID=123')).toBeNull()
  })
})
