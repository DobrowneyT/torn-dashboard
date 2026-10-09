import { describe, expect, it } from 'vitest'
import { validateLoadoutPayload, LOADOUT_MAX_BYTES, BONUS_MAX, STAT_MAX } from '../src/warRoomLoadout.js'

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

/**
 * #929 — damage, accuracy and the bonus percentage.
 *
 * ⚠️ Same best-effort rule as everything above. A temporary (a needle) has no
 * damage row at all and armour has no stats, so absence is ordinary; a
 * validator that required them would reject most real captures.
 */
describe('weapon stats and bonus percentages (#929)', () => {
  it('accepts the fractional figures Torn actually renders', () => {
    // ⚠️ NOT rounded. These are Torn's computed values for that item INSTANCE,
    // with its attachments and quality tier folded in — rounding would discard
    // the only thing that makes them more useful than the item name.
    const res = validateLoadoutPayload(base({
      primary: { name: 'ArmaLite M-15A4', damage: 76.54, accuracy: 61.37 },
    }))
    expect(res.ok, (res as any).error).toBe(true)
    expect((res.value as any).loadout.weapons.primary).toMatchObject({ damage: 76.54, accuracy: 61.37 })
  })

  it('accepts a weapon with no stats at all', () => {
    const res = validateLoadoutPayload(base({ temporary: { name: 'Tyrosine' } }))
    expect(res.ok, (res as any).error).toBe(true)
    expect((res.value as any).loadout.weapons.temporary).toEqual({ name: 'Tyrosine' })
  })

  it('refuses a negative or absurd stat', () => {
    expect(validateLoadoutPayload(base({ primary: { name: 'X', damage: -1 } })).ok).toBe(false)
    expect(validateLoadoutPayload(base({ primary: { name: 'X', accuracy: STAT_MAX + 1 } })).ok).toBe(false)
  })

  it('refuses a stat that is not a number', () => {
    expect(validateLoadoutPayload(base({ primary: { name: 'X', damage: 'lots' } })).ok).toBe(false)
  })

  it('keeps a bonus percentage beside its description', () => {
    const res = validateLoadoutPayload(base({
      secondary: {
        name: 'Flamethrower',
        bonuses: [{ title: 'Burn', description: '37% chance to Burn opponent causing 90% damage over 3 turns', percent: 37 }],
      },
    }))
    expect(res.ok, (res as any).error).toBe(true)
    // ⚠️ BOTH. The percentage is a chance on "37% chance to Burn" and a
    // magnitude on "84% increased Heart damage", so it cannot replace the
    // description — only sit beside it.
    expect((res.value as any).loadout.weapons.secondary.bonuses[0])
      .toEqual({ title: 'Burn', description: '37% chance to Burn opponent causing 90% damage over 3 turns', percent: 37 })
  })

  /**
   * ⚠️ The case that must not be mistaken for a parse failure. Disarm carries
   * no percentage in its description at all, and attachments are frequently
   * flat values ("+0.75 Accuracy").
   */
  it('accepts a bonus with no percentage', () => {
    const res = validateLoadoutPayload(base({
      primary: { name: 'X', bonuses: [{ title: 'Disarm', description: "Disables an opponent's weapon" }] },
    }))
    expect(res.ok, (res as any).error).toBe(true)
    expect((res.value as any).loadout.weapons.primary.bonuses[0]).not.toHaveProperty('percent')
  })

  it('refuses a nonsense percentage', () => {
    expect(validateLoadoutPayload(base({
      primary: { name: 'X', bonuses: [{ title: 'Burn', percent: -5 }] },
    })).ok).toBe(false)
    expect(validateLoadoutPayload(base({
      primary: { name: 'X', bonuses: [{ title: 'Burn', percent: 'loads' }] },
    })).ok).toBe(false)
  })

  it('still refuses a field nobody declared', () => {
    expect(validateLoadoutPayload(base({ primary: { name: 'X', crit: 4 } })).ok).toBe(false)
  })

  /**
   * ⚠️ MEASURED. A realistic nine-slot capture with every #929 field populated
   * came to 1,176 bytes — the ceiling's old comment claimed "a few hundred",
   * which is how a cap stops being the multiple it reads as.
   */
  it('a fully populated realistic capture sits well inside the ceiling', () => {
    const res = validateLoadoutPayload({
      target_id: 90200,
      loadout: {
        weapons: {
          primary: { name: 'ArmaLite M-15A4', item_id: 391, glow: 'yellow', colour: 'orange', damage: 76.54, accuracy: 61.37,
            bonuses: [
              { title: '30mW Laser', description: '+4% critical hit rate', percent: 4 },
              { title: 'Reflex Sight', description: '+1.00 Accuracy' },
              { title: 'Focus', description: '16% increased hit chance for every miss', percent: 16 },
            ] },
          secondary: { name: 'Flamethrower', glow: 'default', damage: 67.5, accuracy: 42.7,
            bonuses: [{ title: 'Burn', description: '37% chance to Burn opponent causing 90% damage over 3 turns', percent: 37 }] },
          melee: { name: 'Macana', glow: 'orange', damage: 66.11, accuracy: 73.76,
            bonuses: [
              { title: 'Cupid', description: '84% increased Heart damage', percent: 84 },
              { title: 'Achilles', description: '50% increased Foot damage', percent: 50 },
            ] },
          temporary: { name: 'Tyrosine', glow: 'default' },
        },
        armor: {
          helmet: { name: 'Assault Helmet' }, chest: { name: 'Dune Armour' }, pants: { name: 'Combat Pants' },
          boots: { name: 'Combat Boots' }, gloves: { name: 'Combat Gloves' },
        },
      },
    })
    expect(res.ok, (res as any).error).toBe(true)
    const size = Buffer.byteLength(JSON.stringify((res.value as any).loadout), 'utf8')
    expect(size).toBeLessThan(LOADOUT_MAX_BYTES / 2)
  })

  it('still refuses a payload stuffed past the ceiling', () => {
    const bonuses = Array.from({ length: BONUS_MAX }, () => ({
      title: 'T'.repeat(100), description: 'd'.repeat(200), percent: 100,
    }))
    const weapons = Object.fromEntries(['primary', 'secondary', 'melee', 'temporary'].map((s) => [s,
      { name: 'N'.repeat(100), damage: 999, accuracy: 999, bonuses }]))
    // ⚠️ Every field here is individually legal; the WHOLE payload is not. That
    // gap is deliberate — per-field limits describe one honest value, the
    // ceiling describes an honest capture.
    expect(validateLoadoutPayload({ target_id: 90200, loadout: { weapons } }).ok).toBe(false)
  })
})
