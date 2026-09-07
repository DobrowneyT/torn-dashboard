import { describe, expect, it } from 'vitest'
import { validateLoadoutPayload, LOADOUT_MAX_BYTES, BONUS_MAX } from '../src/warRoomLoadout.js'

/**
 * The #616 additions to the loadout payload: weapon bonuses, and the quality
 * tokens Torn paints on the wrapper.
 *
 * ⚠️ The governing rule for all three fields is that they are BEST-EFFORT.
 * #528 established it for `item_id` — a gear-hiding script can strip the
 * `<img>` the id comes from, and that must not block a capture. The same holds
 * here twice over: armour carries no glow at all, and an ordinary weapon
 * carries no bonuses. A validator that required them would reject the majority
 * of real captures.
 */

const base = (weapons: Record<string, unknown>) => ({
  target_id: 90200,
  loadout: { weapons, armor: { chest: { name: 'Combat Vest' } } },
})

describe('#616 weapon bonuses', () => {
  it('accepts a weapon carrying specials, keeping Torn’s own words', () => {
    const res = validateLoadoutPayload(base({
      primary: {
        name: 'P90',
        bonuses: [{ title: 'Slow', description: '26% chance to Slow opponent reducing Speed by 25% (x3)' }],
      },
    }))
    expect(res.ok).toBe(true)
    expect((res as any).value.loadout.weapons.primary.bonuses).toEqual([
      { title: 'Slow', description: '26% chance to Slow opponent reducing Speed by 25% (x3)' },
    ])
  })

  it('accepts a weapon with no bonuses at all — ordinary, not broken', () => {
    const res = validateLoadoutPayload(base({ primary: { name: 'Fists' } }))
    expect(res.ok).toBe(true)
    expect((res as any).value.loadout.weapons.primary.bonuses).toBeUndefined()
  })

  it('⚠️ refuses a bonus with a blank title — that is Torn’s EMPTY slot', () => {
    // `bonus-attachment-blank-bonus-25` renders with an empty title and
    // description. The userscript skips them, and so must this: storing one
    // would put a nameless bonus on the row that renders as a phantom special.
    const res = validateLoadoutPayload(base({
      primary: { name: 'Metal Nunchaku', bonuses: [{ title: '   ' }] },
    }))
    expect(res.ok).toBe(false)
    expect((res as any).error).toMatch(/bonus needs a title/)
  })

  it('keeps a bonus whose description is absent, rather than rejecting it', () => {
    const res = validateLoadoutPayload(base({
      primary: { name: 'Crowbar', bonuses: [{ title: 'Plunder' }] },
    }))
    expect(res.ok).toBe(true)
    expect((res as any).value.loadout.weapons.primary.bonuses).toEqual([{ title: 'Plunder' }])
  })

  it('rejects a bonus list that is not an array, and one that is absurdly long', () => {
    expect(validateLoadoutPayload(base({ primary: { name: 'P90', bonuses: 'Slow' } })).ok).toBe(false)
    const many = Array.from({ length: BONUS_MAX + 1 }, (_, i) => ({ title: `B${i}` }))
    const res = validateLoadoutPayload(base({ primary: { name: 'P90', bonuses: many } }))
    expect(res.ok).toBe(false)
    expect((res as any).error).toMatch(/more than/)
  })
})

describe('#616 quality tokens', () => {
  it('stores glow and colour as observed, without interpreting either', () => {
    // The defender's P90 in the 2026-09-07 capture carried BOTH:
    // `glow-yellow___B37GS orange___A_oX6`. Which is the real tier is not yet
    // settled, so both are kept verbatim and neither becomes a boolean.
    const res = validateLoadoutPayload(base({
      primary: { name: 'P90', glow: 'yellow', colour: 'orange' },
    }))
    expect(res.ok).toBe(true)
    expect((res as any).value.loadout.weapons.primary).toMatchObject({ glow: 'yellow', colour: 'orange' })
  })

  it('accepts the default glow, which is what an ordinary weapon carries', () => {
    const res = validateLoadoutPayload(base({ primary: { name: 'Fists', glow: 'default' } }))
    expect(res.ok).toBe(true)
  })

  it('⚠️ refuses anything that is not a simple token', () => {
    // The class is `glow-yellow___B37GS`; only the token is meant to arrive
    // here. Letting a hashed class through would store a value that changes
    // whenever Torn rebuilds their bundle, so every comparison against it would
    // quietly start failing.
    for (const bad of ['yellow___B37GS', 'glow-yellow', '<script>', '']) {
      const res = validateLoadoutPayload(base({ primary: { name: 'P90', glow: bad } }))
      expect(res.ok, String(bad)).toBe(false)
    }
  })

  it('armour needs no glow — Torn paints none on it', () => {
    const res = validateLoadoutPayload({
      target_id: 90200,
      loadout: { weapons: {}, armor: { chest: { name: 'Combat Vest' }, helmet: { name: 'Combat Helmet' } } },
    })
    expect(res.ok).toBe(true)
  })
})

describe('#616 payload size', () => {
  it('⚠️ a full real-world capture still fits the byte cap', () => {
    // Modelled on the 2026-09-07 capture: four weapon slots, each with the
    // maximum bonuses observed and Torn's longest real description, plus five
    // armour slots. The cap exists to bound what an untrusted client can post;
    // it must not be so tight that an honest capture trips it, which is exactly
    // what adding bonuses risked.
    const longDesc = '26% chance to Slow opponent reducing Speed by 25% (x3)'
    const weapon = (name: string) => ({
      name,
      item_id: 12345,
      glow: 'yellow',
      colour: 'orange',
      bonuses: [
        { title: 'Assassinate', description: longDesc },
        { title: 'Extra Magazines x2', description: longDesc },
        { title: '100mW Laser', description: longDesc },
        { title: 'Recoil Pad', description: longDesc },
      ],
    })
    const res = validateLoadoutPayload({
      target_id: 90200,
      loadout: {
        weapons: {
          primary: weapon('SIG 552'), secondary: weapon('China Lake'),
          melee: weapon('Metal Nunchaku'), temporary: weapon('Melatonin'),
        },
        armor: {
          helmet: { name: 'Combat Helmet' }, chest: { name: 'Liquid Body Armor' },
          pants: { name: 'Combat Pants' }, boots: { name: 'Combat Boots' },
          gloves: { name: 'Combat Gloves' },
        },
      },
    })
    expect(res.ok, (res as any).error).toBe(true)
    const size = Buffer.byteLength(JSON.stringify((res as any).value.loadout), 'utf8')
    expect(size).toBeLessThan(LOADOUT_MAX_BYTES)
  })
})
