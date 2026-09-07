import { describe, expect, it } from 'vitest'
import { assistBadgeState, attackUrl } from '../assistBadge.js'

/** A #617 per-target counts row, with every kind at zero unless named. */
const counts = (over = {}) => ({
  target_id: 1, help_wanted: 0, smoke_wanted: 0, tear_wanted: 0,
  help_raised_at: null, smoke_raised_at: null, tear_raised_at: null,
  ...over,
  ...Object.fromEntries(
    Object.keys(over)
      .filter(k => k.endsWith('_wanted'))
      .map(k => [k.replace('_wanted', '_raised_at'), new Date().toISOString()])
  ),
})

describe('assistBadgeState', () => {
  const ME = '2250591'

  it('falls through to dibsButtonState when there is no active assist', () => {
    const st = assistBadgeState(null, null, 90200, ME)
    expect(st).toMatchObject({ mode: 'dibs', label: 'Dibs', action: 'claim', href: null })
  })

  it('⚠️ an active assist morphs the SAME badge rather than adding a second indicator', () => {
    const dib = { claimed_by: 999, claimed_name: 'Thug' } // dibbed too — must not show through
    const st = assistBadgeState(dib, counts({ smoke_wanted: 1 }), 90200, ME)
    expect(st.mode).toBe('assist')
    expect(st.label).toBe('Smoke')
    expect(st.icon).toBe('cloud-fog')
    expect(st.href).toBe('https://www.torn.com/page.php?sid=attack&user2ID=90200')
    expect(st.title).toContain('Smoke')
    expect(st.action).toBeNull()
  })

  it('shows each kind with its own Lucide icon name — a real component reference, not an emoji, cannot survive this pure module', () => {
    expect(assistBadgeState(null, counts({ smoke_wanted: 1 }), 1, ME).icon).toBe('cloud-fog')
    expect(assistBadgeState(null, counts({ tear_wanted: 1 }), 1, ME).icon).toBe('droplet')
    expect(assistBadgeState(null, counts({ help_wanted: 1 }), 1, ME).icon).toBe('life-buoy')
  })

  it('⚠️ #617: names nobody, because a count is everyone who asked', () => {
    // Replaces "reads \"you\" in the title when the current user is the
    // requester". There is no requester on the row any more: the count is a
    // sum, so there is no one person to name, and naming any one of them
    // would be printing an arbitrary pick as fact.
    const st = assistBadgeState(null, counts({ help_wanted: 2 }), 5, ME)
    expect(st.mine).toBe(false)
    expect(st.title).not.toMatch(/\byou\b|requested by/)
  })

  it('⚠️ #617: kinds coexist — shows the most urgent, and the rest in the title', () => {
    // help outranks smoke outranks tear: a body needed in a losing fight is
    // what a lead scanning the board has to see first. Nothing is hidden,
    // though — the title carries every live kind.
    const st = assistBadgeState(null, counts({ smoke_wanted: 3, help_wanted: 1 }), 1, ME)
    expect(st.label).toBe('Help')
    expect(st.icon).toBe('life-buoy')
    expect(st.title).toContain('Smoke ×3')
    expect(st.kinds.map(k => k.kind)).toEqual(['help', 'smoke'])
  })

  it('the assist takes priority over dibs even when the SAME user holds the dib', () => {
    const dib = { claimed_by: ME, claimed_name: 'Me' }
    const st = assistBadgeState(dib, counts({ help_wanted: 1 }), 1, ME)
    expect(st.mode).toBe('assist')
  })

  it('⚠️ #617: a row whose counts are all zero is not a request', () => {
    // The delta ships zeroed rows on purpose — reaching zero is how a client
    // clears a badge — so the row being PRESENT can no longer mean a live
    // request, the way it did under #523.
    const dib = { claimed_by: ME, claimed_name: 'Me' }
    const st = assistBadgeState(dib, counts({}), 1, ME)
    expect(st.mode).toBe('dibs')
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
  it('carries the count through so a caller can render it', () => {
    expect(assistBadgeState(null, counts({ smoke_wanted: 3 }), 1, 9).wanted).toBe(3)
  })

  it('⚠️ says nothing about a count of one — "Smoke ×1" is noise on the overwhelming majority of requests', () => {
    const one = assistBadgeState(null, counts({ smoke_wanted: 1 }), 1, 9)
    expect(one.label).toBe('Smoke')
    expect(one.title).not.toMatch(/×/)
  })

  it('shows the multiple on both the label and the title', () => {
    const three = assistBadgeState(null, counts({ smoke_wanted: 3 }), 1, 9)
    expect(three.label).toBe('Smoke ×3')
    expect(three.title).toMatch(/Smoke ×3/)
  })

  it('⚠️ #617: an unusable count reads as ZERO, not as one', () => {
    // Inverts #591's "treats a missing or unusable count as one, never as
    // zero". That rule existed because the ROW was the request, so a row with
    // no readable count still meant somebody was asking. Since #617 the COUNT
    // is the request: rounding garbage up to 1 would invent a request nobody
    // made and send someone to a fight that is over.
    for (const bad of [undefined, null, 'x', 0, -2]) {
      const st = assistBadgeState(null, counts({ smoke_wanted: bad, help_wanted: 2 }), 1, 9)
      expect(st.kinds.some(k => k.kind === 'smoke'), String(bad)).toBe(false)
    }
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
