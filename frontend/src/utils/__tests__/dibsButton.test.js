import { describe, expect, it } from 'vitest'
import { dibsButtonState } from '../dibsButton.js'

describe('dibsButtonState', () => {
  const ME = '2250591'

  it('offers a claim on a free target', () => {
    expect(dibsButtonState(null, ME)).toMatchObject({ label: 'Dibs', action: 'claim', taken: false })
  })

  it('⚠️ makes your own claim a TOGGLE, not a second button', () => {
    // The old War Room put a separate "Release" link beside the name: a second
    // thing to aim at mid-chain, for the exact inverse of the action that got
    // you there.
    expect(dibsButtonState({ claimed_by: ME, claimed_name: 'Me' }, ME))
      .toMatchObject({ label: '✓ Yours', action: 'release', mine: true })
  })

  it('names the holder of someone else\'s claim', () => {
    expect(dibsButtonState({ claimed_by: 999, claimed_name: 'Thug' }, ME))
      .toMatchObject({ label: 'Thug', taken: true, mine: false })
  })

  it('⚠️ is inert on someone else\'s claim for a non-admin', () => {
    expect(dibsButtonState({ claimed_by: 999, claimed_name: 'Thug' }, ME).action).toBe('none')
  })

  it('⚠️ lets an admin release someone else\'s claim from the same control', () => {
    // This capability already existed as the Release link and is enforced
    // server-side; it must survive the move to a toggle.
    const s = dibsButtonState({ claimed_by: 999, claimed_name: 'Thug' }, ME, { isAdmin: true })
    expect(s.action).toBe('release')
    expect(s.title).toContain('admin')
  })

  it('⚠️ an admin\'s OWN claim still reads as theirs, not as an override', () => {
    expect(dibsButtonState({ claimed_by: ME, claimed_name: 'Me' }, ME, { isAdmin: true }))
      .toMatchObject({ label: '✓ Yours', mine: true })
  })

  it('reads both row shapes — REST and the userscript index', () => {
    expect(dibsButtonState({ claimed_by: 999, claimed_name: 'Thug' }, ME).label).toBe('Thug')
    expect(dibsButtonState({ by: 999, name: 'Thug' }, ME).label).toBe('Thug')
  })

  it('compares ids across the string/number boundary', () => {
    expect(dibsButtonState({ by: 2250591 }, '2250591').mine).toBe(true)
    expect(dibsButtonState({ by: '2250591' }, 2250591).mine).toBe(true)
  })

  it('⚠️ treats a row with no holder id as free, not as claimed by 0', () => {
    // Number(null) is 0, and a phantom holder would make the target
    // permanently unclaimable.
    expect(dibsButtonState({ claimed_by: null }, ME).action).toBe('claim')
    expect(dibsButtonState({}, ME).action).toBe('claim')
  })

  it('falls back to "Claimed" when the holder has no name', () => {
    expect(dibsButtonState({ by: 999 }, ME).label).toBe('Claimed')
  })
})
