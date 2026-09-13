// #715 — the spawn mix, measured rather than assumed.
//
// ⚠️ The finding that prompted this, from tnl's `crimes` table on 2026-09-13:
// 23.5% of "spawns" were chain CHILDREN. Every one of Hostile Takeover's and
// Ace in the Hole's lifetime runs came from a parent — they appeared as rewards,
// never as decisions.
import { describe, expect, it } from 'vitest'
import { observedSpawnMix, MIN_SPAWNS_FOR_MIX } from '../ocSpawnMix'

/** tnl's real 30-day figures. */
const TNL = {
  window_days: 30,
  by_crime: [
    { name: 'Lock Stock', spawns: 25, from_chain: 0 },
    { name: 'Hostile Takeover', spawns: 21, from_chain: 21 },
    { name: 'Window of Opportunity', spawns: 12, from_chain: 0 },
    { name: 'Blast from the Past', spawns: 12, from_chain: 0 },
    { name: 'Clinical Precision', spawns: 11, from_chain: 0 },
    { name: 'Manifest Cruelty', spawns: 11, from_chain: 0 },
    { name: 'Stacking the Deck', spawns: 10, from_chain: 0 },
    { name: 'Break the Bank', spawns: 8, from_chain: 0 },
    { name: 'Ace in the Hole', spawns: 7, from_chain: 7 },
    { name: 'Cleared for Takeoff', spawns: 2, from_chain: 0 },
  ],
}

describe('observedSpawnMix', () => {
  it('⚠️ excludes chain children from the mix entirely', () => {
    const m = observedSpawnMix(TNL)
    expect(m.chainChildren.sort()).toEqual(['Ace in the Hole', 'Hostile Takeover'])
    expect(m.weightByName['Hostile Takeover']).toBeUndefined()
    expect(m.weightByName['Ace in the Hole']).toBeUndefined()
  })

  it('⚠️ counts DECISIONS per day, not appearances', () => {
    // 119 rows total, 28 of them chained → 91 real decisions over 30 days.
    const m = observedSpawnMix(TNL)
    expect(m.chosenSpawns).toBe(91)
    expect(m.spawnsPerDay).toBeCloseTo(91 / 30, 6)
    // Not the 3.97 a naive count gives — that includes crimes nobody chose.
    expect(m.spawnsPerDay).toBeLessThan(3.97)
  })

  it('weights the choosable crimes by how often they are actually chosen', () => {
    const m = observedSpawnMix(TNL)
    expect(m.weightByName['Lock Stock']).toBeCloseTo(25 / 91, 6)
    expect(m.weightByName['Cleared for Takeoff']).toBeCloseTo(2 / 91, 6)
    // The uniform assumption would have made these equal; they differ 12-fold.
    expect(m.weightByName['Lock Stock'] / m.weightByName['Cleared for Takeoff']).toBeCloseTo(12.5, 6)
  })

  it('sums to one across the choosable crimes', () => {
    const total = Object.values(observedSpawnMix(TNL).weightByName).reduce((a, b) => a + b, 0)
    expect(total).toBeCloseTo(1, 9)
  })

  it('⚠️ a crime usually chosen but occasionally chained is still choosable', () => {
    // Judged per crime, not per row: only a crime whose EVERY appearance came
    // from a parent is a child. Its chained runs still come off the count.
    const m = observedSpawnMix({
      window_days: 30,
      by_crime: [
        { name: 'Mostly chosen', spawns: 30, from_chain: 4 },
        { name: 'Always chained', spawns: 21, from_chain: 21 },
      ],
    })
    expect(m.chainChildren).toEqual(['Always chained'])
    expect(m.weightByName['Mostly chosen']).toBe(1)
    expect(m.chosenSpawns).toBe(26)
  })

  it('⚠️ reports "not measured" rather than planning on noise', () => {
    const thin = observedSpawnMix({
      window_days: 30, by_crime: [{ name: 'Once', spawns: 3, from_chain: 0 }],
    })
    expect(thin.measured).toBe(false)
    expect(thin.spawnsPerDay).toBeNull()
    expect(thin.chosenSpawns).toBeLessThan(MIN_SPAWNS_FOR_MIX)
  })

  it('handles a faction with no history at all', () => {
    expect(observedSpawnMix(null).measured).toBe(false)
    expect(observedSpawnMix({ window_days: 30, by_crime: [] }).measured).toBe(false)
  })

  it('⚠️ a faction whose every crime is chained has no mix, not an empty one', () => {
    const m = observedSpawnMix({
      window_days: 30, by_crime: [{ name: 'Child', spawns: 40, from_chain: 40 }],
    })
    expect(m.measured).toBe(false)
    expect(m.chainChildren).toEqual(['Child'])
  })
})
