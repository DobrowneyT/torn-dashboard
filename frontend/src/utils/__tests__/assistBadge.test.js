import { describe, expect, it } from 'vitest'
import { assistBadgeState, attackUrl } from '../assistBadge.js'

describe('assistBadgeState', () => {
  const ME = '2250591'

  it('falls through to dibsButtonState when there is no active assist', () => {
    const st = assistBadgeState(null, null, 90200, ME)
    expect(st).toMatchObject({ mode: 'dibs', label: 'Dibs', action: 'claim', href: null })
  })

  it('⚠️ an active assist morphs the SAME badge rather than adding a second indicator', () => {
    const dib = { claimed_by: 999, claimed_name: 'Thug' } // dibbed too — must not show through
    const assist = { requester_id: 1300, requester_name: 'Scout', kind: 'smoke', created_at: new Date().toISOString() }
    const st = assistBadgeState(dib, assist, 90200, ME)
    expect(st.mode).toBe('assist')
    expect(st.label).toBe('🚬')
    expect(st.href).toBe('https://www.torn.com/page.php?sid=attack&user2ID=90200')
    expect(st.title).toContain('Smoke')
    expect(st.title).toContain('Scout')
    expect(st.action).toBeNull()
  })

  it('shows each kind with its own icon', () => {
    const at = new Date().toISOString()
    expect(assistBadgeState(null, { requester_id: 1, kind: 'smoke', created_at: at }, 1, ME).label).toBe('🚬')
    expect(assistBadgeState(null, { requester_id: 1, kind: 'tear', created_at: at }, 1, ME).label).toBe('💨')
    expect(assistBadgeState(null, { requester_id: 1, kind: 'help', created_at: at }, 1, ME).label).toBe('🆘')
  })

  it('reads "you" in the title when the current user is the requester', () => {
    const st = assistBadgeState(null, { requester_id: ME, kind: 'help', created_at: new Date().toISOString() }, 5, ME)
    expect(st.mine).toBe(true)
    expect(st.title).toContain('you')
  })

  it('reads both row shapes — REST and a userscript-style index entry', () => {
    const at = new Date().toISOString()
    const rest = assistBadgeState(null, { requester_id: 999, requester_name: 'Rival', kind: 'tear', created_at: at }, 1, ME)
    const script = assistBadgeState(null, { by: 999, name: 'Rival', kind: 'tear', at }, 1, ME)
    expect(rest.title).toBe(script.title)
  })

  it('the assist takes priority over dibs even when the SAME user holds both', () => {
    const dib = { claimed_by: ME, claimed_name: 'Me' }
    const assist = { requester_id: ME, kind: 'help', created_at: new Date().toISOString() }
    const st = assistBadgeState(dib, assist, 1, ME)
    expect(st.mode).toBe('assist')
  })

  it('is inert (no href) once the assist clears — reverts to the normal dibs control', () => {
    const dib = { claimed_by: ME, claimed_name: 'Me' }
    const st = assistBadgeState(dib, null, 1, ME)
    expect(st).toMatchObject({ mode: 'dibs', action: 'release', mine: true, href: null })
  })
})

describe('attackUrl', () => {
  it('builds the attack-page URL for a valid id', () => {
    expect(attackUrl(90200)).toBe('https://www.torn.com/page.php?sid=attack&user2ID=90200')
  })

  it('is null for a missing/invalid id', () => {
    expect(attackUrl(null)).toBeNull()
    expect(attackUrl('not-a-number')).toBeNull()
    expect(attackUrl(0)).toBeNull()
  })
})
