// Fair Fight (#422). Pinned against MonChoon's own description of the
// behaviour, not just the algebra — the formula is only right if it reproduces
// what players actually see in game.
import { describe, it, expect } from 'vitest'
import {
  battleStatsScore, fairFight, formatFF, ffSortValue, ffBand,
  scoreIsEstimated, ffGradientPosition, isMaxFF,
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

  it('returns null only when there is neither a breakdown nor a total', () => {
    expect(battleStatsScore({ strength: 100, speed: 100, defense: 100 })).toBeNull()
    expect(battleStatsScore(null)).toBeNull()
  })

  it('assumes an even split when only a total is known (BSP)', () => {
    // 4 × √(400/4) = 4 × 10 = 40, same as the balanced breakdown.
    expect(battleStatsScore({ total: 400 })).toBe(40)
    expect(scoreIsEstimated({ total: 400 })).toBe(true)
    expect(scoreIsEstimated({ strength: 100, speed: 100, defense: 100, dexterity: 100 })).toBe(false)
  })

  it('prefers a real breakdown over the total when both are present', () => {
    // The breakdown is measured; the total-derived figure is an assumption.
    const lopsided = { strength: 397, speed: 1, defense: 1, dexterity: 1, total: 400 }
    expect(battleStatsScore(lopsided)).toBeLessThan(40)
    expect(scoreIsEstimated(lopsided)).toBe(false)
  })

  it('OVERSTATES a lopsided build when it has to assume', () => {
    // The cost of the assumption, made explicit. An even split maximises the
    // sum of roots for a given total, so assuming it inflates a pure-strength
    // fighter — and on the defender side that makes a target look more
    // rewarding than it is.
    const real = battleStatsScore({ strength: 397, speed: 1, defense: 1, dexterity: 1 })
    const assumed = battleStatsScore({ total: 400 })
    expect(assumed).toBeGreaterThan(real)
    expect(assumed / real).toBeGreaterThan(1.3)
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

describe('ffGradientPosition', () => {
  it('runs 0 at the floor to 1 at the cap', () => {
    expect(ffGradientPosition(1)).toBe(0)
    expect(ffGradientPosition(2)).toBe(0.5)
    expect(ffGradientPosition(3)).toBe(1)
  })

  it('cannot leave the 0..1 range', () => {
    // FF is already clamped, but the gradient must not blow up if it ever is not.
    expect(ffGradientPosition(0.75)).toBe(0)
    expect(ffGradientPosition(9)).toBe(1)
  })

  it('is null for an unknown FF, so the cell can render a dash', () => {
    expect(ffGradientPosition(null)).toBeNull()
  })
})

describe('isMaxFF — the "3x FF" roster filter', () => {
  it('accepts a matchup at the cap', () => {
    expect(isMaxFF(fairFight(even(5e9), even(5e9)))).toBe(true)
    expect(isMaxFF(fairFight(even(1e8), even(5e9)))).toBe(true)
  })

  it('rejects a matchup below it', () => {
    expect(isMaxFF(fairFight(even(5e9), even(1e8)))).toBe(false)
  })

  it('tolerates floating-point dust rather than dropping a target for it', () => {
    // An exact === 3 check would hide targets over a rounding artefact the
    // user cannot see, on a filter whose whole job is "show me the good ones".
    expect(isMaxFF(3 - 1e-12)).toBe(true)
    expect(isMaxFF(2.99)).toBe(false)
  })

  it('is false for an unknown FF, never true by accident', () => {
    expect(isMaxFF(null)).toBe(false)
  })
})

describe('the BSP estimate path end to end', () => {
  it('reduces to totals when both sides are estimated', () => {
    // With an even split assumed on both sides the roots cancel:
    // FF = 1 + 8/3 × √(def_total / att_total).
    const ff = fairFight({ total: 5e9 }, { total: 1e8 })
    expect(ff).toBeCloseTo(1 + (8 / 3) * Math.sqrt(1e8 / 5e9), 6)
    expect(ff).toBeCloseTo(1.377, 3)
  })

  it('mixes a measured attacker with an estimated defender', () => {
    // The common case: we know our own stats exactly, the target is a BSP guess.
    const ff = fairFight({ strength: 1.25e9, speed: 1.25e9, defense: 1.25e9, dexterity: 1.25e9 }, { total: 1e8 })
    expect(ff).toBeCloseTo(1.377, 3)
  })
})
