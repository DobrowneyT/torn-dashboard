// Our own members' battle stats (#348) — parsing and source ranking.
import { describe, it, expect } from 'vitest'
import {
  parseTornBattleStats, parseTornStatsSpy, parseBspStats, shouldReplace,
} from '../src/memberBattleStats.js'

describe('parseTornBattleStats', () => {
  // v2 wraps each stat as { value, modifier, modifiers } rather than a number.
  const body = {
    battlestats: {
      strength: { value: 1_000_000, modifier: 10, modifiers: [] },
      defense: { value: 2_000_000, modifier: 0, modifiers: [] },
      speed: { value: 3_000_000, modifier: 0, modifiers: [] },
      dexterity: { value: 4_000_000, modifier: 0, modifiers: [] },
      total: { value: 10_000_000, modifier: 0, modifiers: [] },
    },
  }

  it('reads the base value out of each wrapped stat', () => {
    expect(parseTornBattleStats(body)).toEqual({
      strength: 1_000_000, defense: 2_000_000, speed: 3_000_000,
      dexterity: 4_000_000, total: 10_000_000,
    })
  })

  it('stores the base value, not the modified one', () => {
    // A stat that changes when a drug wears off is not a useful comparison.
    expect(parseTornBattleStats(body).strength).toBe(1_000_000)
  })

  it('accepts a body that is already unwrapped', () => {
    expect(parseTornBattleStats({ strength: { value: 5 }, total: { value: 5 } }))
      .toMatchObject({ strength: 5, total: 5 })
  })

  it('tolerates bare numbers in case Torn ever flattens the shape', () => {
    expect(parseTornBattleStats({ battlestats: { strength: 7, total: 7 } }))
      .toMatchObject({ strength: 7, total: 7 })
  })

  it('derives the total from the parts when Torn omits it', () => {
    // A missing total must not blank an otherwise complete row.
    const parsed = parseTornBattleStats({
      battlestats: {
        strength: { value: 1 }, defense: { value: 2 },
        speed: { value: 3 }, dexterity: { value: 4 },
      },
    })
    expect(parsed.total).toBe(10)
  })

  it('leaves the total null when parts are missing rather than under-reporting', () => {
    // Summing an incomplete set would produce a confidently wrong number.
    expect(parseTornBattleStats({ battlestats: { strength: { value: 1 } } }).total).toBeNull()
  })

  it('returns nulls rather than throwing on junk', () => {
    for (const junk of [null, undefined, {}, { battlestats: null }, 'nope']) {
      expect(parseTornBattleStats(junk).total).toBeNull()
    }
  })
})

describe('parseTornStatsSpy', () => {
  it('reads a spy entry and its timestamp', () => {
    const out = parseTornStatsSpy({
      spy: { total: 500, strength: 100, defense: 150, speed: 125, dexterity: 125, timestamp: 1_700_000_000 },
    })
    expect(out?.stats).toMatchObject({ total: 500, strength: 100 })
    expect(out?.spyAt?.toISOString()).toBe(new Date(1_700_000_000_000).toISOString())
  })

  it('rejects an empty or zero spy', () => {
    // TornStats returns entries for unspied members with total 0.
    expect(parseTornStatsSpy({ spy: { total: 0 } })).toBeNull()
    expect(parseTornStatsSpy({ spy: null })).toBeNull()
    expect(parseTornStatsSpy({})).toBeNull()
    expect(parseTornStatsSpy(null)).toBeNull()
  })

  it('accepts a spy with no timestamp rather than discarding it', () => {
    const out = parseTornStatsSpy({ spy: { total: 500 } })
    expect(out?.stats.total).toBe(500)
    expect(out?.spyAt).toBeNull()
  })
})

describe('parseBspStats', () => {
  it('reads a successful prediction', () => {
    expect(parseBspStats({ Result: 1, TBS: 900, Strength: 200, Defense: 300, Speed: 200, Dexterity: 200 }))
      .toEqual({ total: 900, strength: 200, defense: 300, speed: 200, dexterity: 200 })
  })

  it('accepts Result 6, which also carries stats', () => {
    expect(parseBspStats({ Result: 6, TBS: 900 })?.total).toBe(900)
  })

  it('rejects a failed or empty prediction', () => {
    expect(parseBspStats({ Result: 0, TBS: 900 })).toBeNull()
    expect(parseBspStats({ Result: 1 })).toBeNull()
    expect(parseBspStats(null)).toBeNull()
  })
})

describe('shouldReplace — source ranking', () => {
  it('writes anything into an empty row', () => {
    expect(shouldReplace(null, 'bsp')).toBe(true)
    expect(shouldReplace({ source: 'torn', total: null }, 'bsp')).toBe(true)
  })

  it('never downgrades an exact figure to an estimate', () => {
    // The whole point: a BSP guess arriving after the member's own key
    // reported exact stats must not overwrite them.
    expect(shouldReplace({ source: 'torn', total: 100 }, 'bsp')).toBe(false)
    expect(shouldReplace({ source: 'torn', total: 100 }, 'tornstats')).toBe(false)
    expect(shouldReplace({ source: 'tornstats', total: 100 }, 'bsp')).toBe(false)
  })

  it('upgrades to a better source', () => {
    expect(shouldReplace({ source: 'bsp', total: 100 }, 'tornstats')).toBe(true)
    expect(shouldReplace({ source: 'bsp', total: 100 }, 'torn')).toBe(true)
    expect(shouldReplace({ source: 'tornstats', total: 100 }, 'torn')).toBe(true)
  })

  it('refreshes from the same source', () => {
    // Same rank means a newer reading from the same place — always take it.
    expect(shouldReplace({ source: 'torn', total: 100 }, 'torn')).toBe(true)
    expect(shouldReplace({ source: 'bsp', total: 100 }, 'bsp')).toBe(true)
  })

  it('treats an unknown stored source as the weakest', () => {
    expect(shouldReplace({ source: 'mystery', total: 100 }, 'bsp')).toBe(true)
  })
})
