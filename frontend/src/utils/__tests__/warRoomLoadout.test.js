// Enemy loadout observation formatting (#528 Part 2).
import { describe, it, expect } from 'vitest'
import { loadoutEntries, formatLoadoutTooltip, isLoadoutStale, LOADOUT_STALE_MS } from '../warRoomLoadout'

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
