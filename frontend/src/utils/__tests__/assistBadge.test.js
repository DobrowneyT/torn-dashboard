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
    expect(st.label).toBe('Smoke')
    expect(st.icon).toBe('cloud-fog')
    expect(st.href).toBe('https://www.torn.com/page.php?sid=attack&user2ID=90200')
    expect(st.title).toContain('Smoke')
    expect(st.title).toContain('Scout')
    expect(st.action).toBeNull()
  })

  it('shows each kind with its own Lucide icon name — a real component reference, not an emoji, cannot survive this pure module', () => {
    const at = new Date().toISOString()
    expect(assistBadgeState(null, { requester_id: 1, kind: 'smoke', created_at: at }, 1, ME).icon).toBe('cloud-fog')
    expect(assistBadgeState(null, { requester_id: 1, kind: 'tear', created_at: at }, 1, ME).icon).toBe('droplet')
    expect(assistBadgeState(null, { requester_id: 1, kind: 'help', created_at: at }, 1, ME).icon).toBe('life-buoy')
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

// #591: a request is a COUNT, not a flag. Two people still owe you a smoke is
// a different fact from one, and the badge is where a lead reads it.
describe('the assist count', () => {
  const assist = (over = {}) => ({ requester_id: 7, requester_name: 'Ally', kind: 'smoke', wanted: 1, ...over })

  it('carries the count through so a caller can render it', () => {
    expect(assistBadgeState(null, assist({ wanted: 3 }), 1, 9).wanted).toBe(3)
  })

  it('⚠️ says nothing about a count of one — "Smoke ×1" is noise on the overwhelming majority of requests', () => {
    const one = assistBadgeState(null, assist({ wanted: 1 }), 1, 9)
    expect(one.label).toBe('Smoke')
    expect(one.title).not.toMatch(/×/)
  })

  it('shows the multiple on the label and spells it out in the title', () => {
    const three = assistBadgeState(null, assist({ wanted: 3 }), 1, 9)
    expect(three.label).toBe('Smoke ×3')
    expect(three.title).toMatch(/3 still needed/)
  })

  it('treats a missing or unusable count as one, never as zero', () => {
    // A row from before this column existed, and a garbage value, must not
    // render as "×0" — which would read as "nobody is asking", the opposite
    // of what a live row means.
    for (const bad of [undefined, null, 'x', 0, -2]) {
      const st = assistBadgeState(null, assist({ wanted: bad }), 1, 9)
      expect(st.wanted, String(bad)).toBe(1)
      expect(st.label).toBe('Smoke')
    }
  })

  it('reads the userscript index shape too', () => {
    expect(assistBadgeState(null, { by: 7, name: 'Ally', kind: 'help', wanted: 2 }, 1, 9).label).toBe('Help ×2')
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
