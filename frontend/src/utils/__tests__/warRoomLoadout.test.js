// Enemy loadout observation formatting (#528 Part 2).
import { describe, it, expect } from 'vitest'
import { loadoutEntries, formatLoadoutTooltip, isLoadoutStale, LOADOUT_STALE_MS, rankedLoadoutEntries, isNotableWeapon, usesNeedles, formatBonusLine} from '../warRoomLoadout'

describe('loadoutEntries', () => {
  it('flattens weapons and armor into a stable, labelled order', () => {
    const loadout = {
      weapons: { melee: { name: 'Bat' }, primary: { name: 'AK-47', item_id: 1 } },
      armor: { chest: { name: 'Combat Vest' }, helmet: { name: 'Riot Helmet' } },
    }
    const entries = loadoutEntries(loadout)
    expect(entries.map((e) => e.label)).toEqual(['Primary', 'Melee', 'Helmet', 'Chest'])
    expect(entries[0]).toMatchObject({ slot: 'primary', name: 'AK-47', itemId: 1 })
    expect(entries[1].itemId).toBeNull() // never required — no <img> id for this slot
  })

  it('is empty for a loadout with no captured slots, or none at all', () => {
    expect(loadoutEntries({ weapons: {}, armor: {} })).toEqual([])
    expect(loadoutEntries(null)).toEqual([])
    expect(loadoutEntries(undefined)).toEqual([])
  })
})

describe('formatLoadoutTooltip', () => {
  it('lists every slot plus who observed it and when', () => {
    const row = {
      loadout: { weapons: { primary: { name: 'AK-47' } }, armor: { chest: { name: 'Combat Vest' } } },
      observed_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      observed_by_name: 'Scout',
    }
    const text = formatLoadoutTooltip(row)
    expect(text).toContain('Primary: AK-47')
    expect(text).toContain('Chest: Combat Vest')
    expect(text).toMatch(/Observed 5m ago by Scout/)
  })

  it('is empty with no row, no loadout, or an empty loadout', () => {
    expect(formatLoadoutTooltip(null)).toBe('')
    expect(formatLoadoutTooltip({})).toBe('')
    expect(formatLoadoutTooltip({ loadout: { weapons: {}, armor: {} } })).toBe('')
  })
})

describe('isLoadoutStale', () => {
  it('is not stale just after capture, stale past the threshold', () => {
    expect(isLoadoutStale({ observed_at: new Date().toISOString() })).toBe(false)
    const old = new Date(Date.now() - LOADOUT_STALE_MS - 1000).toISOString()
    expect(isLoadoutStale({ observed_at: old })).toBe(true)
  })

  it('treats an unparseable/missing timestamp as stale — never confidently fresh with no data', () => {
    expect(isLoadoutStale({})).toBe(true)
    expect(isLoadoutStale(null)).toBe(true)
  })
})

// #616: specials, quality and needles. Fixtures use values from the real
// mid-fight capture of 2026-09-07 (defender Just53's P90 and Crowbar).
describe('#616 notable weapons, needles and specials', () => {
  const cap = (weapons, armor = {}) => ({ weapons, armor })

  it('⚠️ ranks notable weapons first WITHOUT dropping the ordinary ones', () => {
    // "Default on, collapsible" — a hard filter would make "genuinely
    // unarmoured" and "not captured yet" look identical to a lead.
    const { notable, ordinary, all } = rankedLoadoutEntries(cap({
      primary: { name: 'P90', glow: 'yellow', colour: 'orange', bonuses: [{ title: 'Slow' }] },
      secondary: { name: 'Fists', glow: 'default' },
      melee: { name: 'Crowbar', glow: 'yellow', bonuses: [{ title: 'Plunder' }] },
    }, { chest: { name: 'Combat Vest' } }))

    expect(notable.map(e => e.name)).toEqual(['P90', 'Crowbar'])
    expect(ordinary.map(e => e.name)).toEqual(['Fists', 'Combat Vest'])
    expect(all).toHaveLength(4)   // nothing lost
  })

  it('treats a bonus OR a non-default glow as notable', () => {
    expect(isNotableWeapon({ name: 'X', bonuses: [{ title: 'Plunder' }] })).toBe(true)
    expect(isNotableWeapon({ name: 'X', glow: 'yellow' })).toBe(true)
    expect(isNotableWeapon({ name: 'X', colour: 'orange' })).toBe(true)
    expect(isNotableWeapon({ name: 'X', glow: 'default' })).toBe(false)
    expect(isNotableWeapon({ name: 'X' })).toBe(false)
  })

  it('⚠️ armour is never notable — Torn paints no quality on it', () => {
    // Armour arrives as <area title> names only: no glow class, no bonuses.
    // Everything is listed, and a rare-armour list is a later hard-coded
    // follow-up rather than something inferable from what we capture today.
    const { notable, ordinary } = rankedLoadoutEntries(cap({}, {
      chest: { name: 'Liquid Body Armor' }, helmet: { name: 'Combat Helmet' },
    }))
    expect(notable).toHaveLength(0)
    expect(ordinary.map(e => e.name)).toEqual(['Combat Helmet', 'Liquid Body Armor'])
  })

  it('detects a needle in the temp slot', () => {
    expect(usesNeedles(cap({ temporary: { name: 'Melatonin' } }))).toBe(true)
    expect(usesNeedles(cap({ temporary: { name: 'Pepper Spray' } }))).toBe(false)
  })

  it('⚠️ an absent temp slot is NOT evidence that they do not use needles', () => {
    // Rollers are only holding one for part of a fight, so a miss means "not
    // caught mid-injection". usesNeedles() returning false must never be
    // rendered as a "no needles" claim.
    expect(usesNeedles(cap({}))).toBe(false)
    expect(usesNeedles(null)).toBe(false)
  })

  it('puts specials on the weapon that carries them, and flags needles', () => {
    const text = formatLoadoutTooltip({
      loadout: cap({
        primary: { name: 'P90', bonuses: [{ title: 'Slow' }] },
        temporary: { name: 'Melatonin' },
      }),
      observed_at: new Date().toISOString(),
    })
    expect(text).toContain('Primary: P90 (Slow)')
    expect(text).toContain('needles')
  })
})

describe('formatBonusLine (#929)', () => {
  it('joins bonuses with their percentages, comma-delimited', () => {
    expect(formatBonusLine([
      { title: 'Focus', percent: 16 },
      { title: '30mW Laser', percent: 4 },
    ])).toBe('Focus 16%, 30mW Laser 4%')
  })

  /**
   * ⚠️ The case that would print "Disarm NaN%". Disarm's description carries no
   * figure at all, and attachments are frequently flat ("+1.00 Accuracy").
   */
  it('renders a bonus with no percentage as its bare title', () => {
    expect(formatBonusLine([
      { title: 'Focus', percent: 16 },
      { title: 'Reflex Sight' },
      { title: 'Disarm', description: "Disables an opponent's weapon" },
    ])).toBe('Focus 16%, Reflex Sight, Disarm')
  })

  /** ⚠️ Absent is not zero: "0%" reads as useless rather than unmeasured. */
  it('keeps a real zero rather than dropping it', () => {
    expect(formatBonusLine([{ title: 'Nothing', percent: 0 }])).toBe('Nothing 0%')
  })

  it('drops a fractional percentage through unchanged', () => {
    expect(formatBonusLine([{ title: 'Half', percent: 2.5 }])).toBe('Half 2.5%')
  })

  it('returns an empty string when there is nothing to say', () => {
    // ⚠️ So the caller can skip the row rather than render a blank line under
    // every ordinary weapon.
    expect(formatBonusLine([])).toBe('')
    expect(formatBonusLine(null)).toBe('')
    expect(formatBonusLine(undefined)).toBe('')
  })

  it('ignores a bonus with no title at all', () => {
    expect(formatBonusLine([{ title: '', percent: 5 }, { title: 'Burn', percent: 37 }])).toBe('Burn 37%')
  })

  it('ignores a non-numeric percentage rather than printing it', () => {
    expect(formatBonusLine([{ title: 'Burn', percent: 'loads' }])).toBe('Burn')
  })
})

/**
 * ⚠️ The percentage has to come from the DESCRIPTION when the capture carries
 * no `percent` field — which is every observation taken before userscript
 * 1.52.0, i.e. all 1,301 forge captures that existed when this shipped. Without
 * the fallback the War Room shows bare titles for a month of data we already
 * hold, until every member updates their script.
 *
 * A probe proved this was unguarded: removing the fallback broke no test.
 */
describe('bonus percentage from a stored description (#929 follow-up)', () => {
  it('derives the percentage for a capture that predates the percent field', () => {
    // Verbatim from a real forge observation (a Jackhammer, 2026-10-09).
    expect(formatBonusLine([
      { title: 'Recoil Pad', description: '+25% ammo conservation' },
      { title: 'Skeet Choke', description: '+6% damage' },
      { title: 'Powerful', description: '16% increased damage' },
    ])).toBe('Recoil Pad 25%, Skeet Choke 6%, Powerful 16%')
  })

  it('derives it for the specials that state their figure mid-sentence', () => {
    expect(formatBonusLine([
      { title: 'Eviscerate', description: 'Eviscerates opponent causing them 15% extra damage on further hits' },
      { title: 'Penetrate', description: 'Ignores 26% of armor mitigation' },
    ])).toBe('Eviscerate 15%, Penetrate 26%')
  })

  /** ⚠️ A penalty must not be presented as the bonus. */
  it('shows no figure when the only percentage is a penalty', () => {
    expect(formatBonusLine([
      { title: 'Deadly Accuracy', description: '+1.75 Accuracy -30% Dexterity' },
    ])).toBe('Deadly Accuracy')
  })

  it('shows no figure for a flat value or a worded effect', () => {
    expect(formatBonusLine([
      { title: 'Sight', description: '+1.50 Accuracy' },
      { title: 'Disarm', description: "Disables an opponent's weapon upon a hand or arm hit for 3 turns" },
    ])).toBe('Sight, Disarm')
  })

  /**
   * ⚠️ The RECORDED value wins over the derived one. It is what the capture
   * actually observed, and if Torn ever rewords a description the stored figure
   * stays the historical record rather than being re-derived from new prose.
   */
  it('prefers a recorded percent over the description', () => {
    expect(formatBonusLine([
      { title: 'Burn', percent: 37, description: '99% chance to Burn' },
    ])).toBe('Burn 37%')
  })

  it('falls back when the recorded percent is not a usable number', () => {
    expect(formatBonusLine([
      { title: 'Burn', percent: null, description: '37% chance to Burn' },
    ])).toBe('Burn 37%')
  })
})
