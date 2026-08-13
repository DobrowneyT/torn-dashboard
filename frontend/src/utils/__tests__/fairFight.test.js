// Fair Fight (#422). Pinned against MonChoon's own description of the
// behaviour, not just the algebra — the formula is only right if it reproduces
// what players actually see in game.
import { describe, it, expect } from 'vitest'
import {
  battleStatsScore, fairFight, formatFF, ffSortValue, ffBand,
  FF_MAX, FF_CAP_RATIO,
} from '../fairFight'

/** Even split across the four stats, which is how the examples were described. */
const even = (total) => ({
  strength: total / 4, speed: total / 4, defense: total / 4, dexterity: total / 4,
})

describe('battleStatsScore', () => {
  it('is the sum of square roots, not a function of the total', () => {
    // The reason FF needs four numbers rather than one. Same total, different
    // split, different score — so a total-only reading cannot produce FF.
    const balanced = battleStatsScore({ strength: 100, speed: 100, defense: 100, dexterity: 100 })
    const lopsided = battleStatsScore({ strength: 397, speed: 1, defense: 1, dexterity: 1 })
    expect(balanced).toBe(40)                 // 4 × 10
    expect(lopsided).toBeLessThan(balanced)   // ~22.9, same 400 total
  })

  it('accepts the short field names the War Room uses', () => {
    expect(battleStatsScore({ str: 100, spd: 100, def: 100, dex: 100 })).toBe(40)
  })

  it('returns null when any component is missing', () => {
    // Never guess an even split from a total: it produces a number that looks
    // right and is not, on a value that decides who gets attacked.
    expect(battleStatsScore({ strength: 100, speed: 100, defense: 100 })).toBeNull()
    expect(battleStatsScore({ strength: 100, speed: 100, defense: 100, dexterity: null })).toBeNull()
    expect(battleStatsScore(null)).toBeNull()
  })

  it('treats a zero stat as a real reading, not as missing', () => {
    // Number(null) === 0 from the other side: a genuine 0 is knowledge.
    expect(battleStatsScore({ strength: 0, speed: 0, defense: 0, dexterity: 0 })).toBe(0)
  })
})

describe('fairFight — MonChoon\'s stated cases', () => {
  it('gives ~1.38 for 5b stats hitting 100m — the "3-4 respect" case', () => {
    expect(fairFight(even(5e9), even(1e8))).toBeCloseTo(1.377, 3)
  })

  it('caps at 3.00 for an even fight', () => {
    expect(fairFight(even(5e9), even(5e9))).toBe(FF_MAX)
  })

  it('caps at 3.00 when punching up', () => {
    expect(fairFight(even(1e8), even(5e9))).toBe(FF_MAX)
  })

  it('saturates exactly at a defender/attacker ratio of 0.75', () => {
    // 1 + 8/3 × 0.75 = 3. Everything above this reads flat, which is why the
    // colour band uses the ratio rather than FF.
    const attacker = even(4e9)
    // BS score scales with √total, so a 0.75 BS ratio needs total × 0.5625.
    const defender = even(4e9 * FF_CAP_RATIO * FF_CAP_RATIO)
    expect(fairFight(attacker, defender)).toBeCloseTo(3, 6)
  })

  it('approaches 1.00 as the defender approaches nothing', () => {
    expect(fairFight(even(5e9), even(1))).toBeGreaterThan(1)
    expect(fairFight(even(5e9), even(1))).toBeLessThan(1.001)
  })

  it('never exceeds the cap or drops below the floor', () => {
    for (const [a, d] of [[1e6, 1e12], [1e12, 1], [5e9, 5e9], [1e8, 3e8]]) {
      const ff = fairFight(even(a), even(d))
      expect(ff).toBeGreaterThanOrEqual(1)
      expect(ff).toBeLessThanOrEqual(FF_MAX)
    }
  })
})

describe('fairFight — unknowns', () => {
  it('returns null when either side has an incomplete reading', () => {
    expect(fairFight(even(5e9), { strength: 1, speed: 1, defense: 1 })).toBeNull()
    expect(fairFight({ strength: 1, speed: 1, defense: 1 }, even(5e9))).toBeNull()
  })

  it('returns null rather than dividing by zero', () => {
    expect(fairFight(even(0), even(5e9))).toBeNull()
  })

  it('formats a null as a dash, never as 0.00', () => {
    expect(formatFF(null)).toBe('—')
    expect(formatFF(fairFight(even(5e9), even(1e8)))).toBe('1.38')
  })

  it('sorts unknowns as null so the shared #351 rule can sink them', () => {
    // Sorting an unknown as 0 or 1.00 buries it mid-ranking, which is worse
    // than either end — #351 puts no-reading last in BOTH directions.
    expect(ffSortValue(even(5e9), { strength: 1 })).toBeNull()
    expect(ffSortValue(even(5e9), even(5e9))).toBe(3)
  })
})

describe('ffBand', () => {
  it('separates an even fight from punching up, which FF alone cannot', () => {
    // Both are FF 3.00. The band still distinguishes them because it reads the
    // ratio, and "who should I hit" is a choice between exactly these.
    expect(fairFight(even(5e9), even(5e9))).toBe(fairFight(even(1e8), even(5e9)))
    expect(ffBand(even(5e9), even(5e9))).toBe('max')
    expect(ffBand(even(1e8), even(5e9))).toBe('max')
  })

  it('marks a big mismatch as wasted', () => {
    expect(ffBand(even(5e9), even(1e8))).toBe('wasted')
  })

  it('reports unknown rather than guessing a band', () => {
    expect(ffBand(even(5e9), { strength: 1 })).toBe('unknown')
  })
})
