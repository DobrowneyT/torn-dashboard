// Shared spy providers (#889 slice 5), extracted from spyFetch so the War Room
// and the Book of Grudges read players the same way.
//
// ⚠️ **These tests exist because the war-room suite does not cover this.**
// Swapping `defense` for `speed` in the parser left all 10 war-room spy tests
// green — they assert `bsp_total`, `spy_source` and `ts_spy_at` and never the
// individual stats. Fair Fight is a sum of square ROOTS of the four stats, so
// a str/def swap silently produces a wrong FF on every surface that shows one.
import { describe, expect, it } from 'vitest'
import { readTornStatsFaction, readBspStats } from '../src/spyProviders.js'

const NOW = Math.floor(Date.now() / 1000)

const tsPayload = (over: any = {}) => ({
  faction: {
    members: {
      '90120': {
        id: 90120,
        spy: {
          total: 1_500_000, strength: 500_000, speed: 400_000,
          defense: 300_000, dexterity: 300_000, timestamp: NOW,
          ...over,
        },
      },
    },
  },
})

describe('readTornStatsFaction', () => {
  it('⚠️ maps every stat to the RIGHT field', () => {
    // The assertion the war-room suite was missing. Each value is distinct so
    // any transposition shows up.
    const r = readTornStatsFaction(tsPayload(), new Set([90120]))
    expect(r.get(90120)).toMatchObject({
      total: 1_500_000, str: 500_000, spd: 400_000, def: 300_000, dex: 300_000,
      source: 'tornstats',
    })
  })

  it('carries the spy’s own capture time, not the fetch time', () => {
    const r = readTornStatsFaction(tsPayload(), new Set([90120]))
    expect(r.get(90120)!.spiedAt!.getTime()).toBe(NOW * 1000)
  })

  it('⚠️ drops a spy older than the floor, so BSP can answer instead', () => {
    // A spy from last year is worse than no spy: it is a number people act on,
    // and the target has trained since.
    const old = NOW - 400 * 86_400
    const r = readTornStatsFaction(tsPayload({ timestamp: old }), new Set([90120]), NOW - 30 * 86_400)
    expect(r.size).toBe(0)
  })

  it('⚠️ treats a zero or missing total as NO spy, not as a weak player', () => {
    // Storing it would put somebody at the bottom of every sort and make them
    // look like a free hit.
    expect(readTornStatsFaction(tsPayload({ total: 0 }), new Set([90120])).size).toBe(0)
    expect(readTornStatsFaction(tsPayload({ total: undefined }), new Set([90120])).size).toBe(0)
  })

  it('ignores anybody we did not ask about', () => {
    expect(readTornStatsFaction(tsPayload(), new Set([99999])).size).toBe(0)
  })

  it('survives a malformed or empty payload', () => {
    expect(readTornStatsFaction(null, new Set([1])).size).toBe(0)
    expect(readTornStatsFaction({}, new Set([1])).size).toBe(0)
    expect(readTornStatsFaction({ faction: { members: [] } }, new Set([1])).size).toBe(0)
  })
})

describe('readBspStats', () => {
  const bsp = (over: any = {}) => ({
    Result: 1, TBS: 2_000_000, Strength: 800_000, Speed: 600_000,
    Defense: 400_000, Dexterity: 200_000, ...over,
  })

  it('⚠️ maps every stat to the RIGHT field', () => {
    expect(readBspStats(bsp())).toMatchObject({
      total: 2_000_000, str: 800_000, spd: 600_000, def: 400_000, dex: 200_000,
      source: 'bsp',
    })
  })

  it('⚠️ has NO capture time, and does not invent one', () => {
    // Filling it with now() would present an estimate of unknown age as
    // something taken this minute.
    expect(readBspStats(bsp())!.spiedAt).toBeNull()
  })

  it('accepts both Result codes that mean "we have an answer"', () => {
    expect(readBspStats(bsp({ Result: 1 }))).not.toBeNull()
    expect(readBspStats(bsp({ Result: 6 }))).not.toBeNull()
  })

  it('refuses any other Result rather than reading a blank body', () => {
    expect(readBspStats(bsp({ Result: 0 }))).toBeNull()
    expect(readBspStats(bsp({ Result: 3 }))).toBeNull()
  })

  it('⚠️ treats a zero total as no reading', () => {
    expect(readBspStats(bsp({ TBS: 0 }))).toBeNull()
    expect(readBspStats(bsp({ TBS: null }))).toBeNull()
  })

  it('keeps a reading whose individual stats are missing', () => {
    // BSP sometimes gives a total without the breakdown. That is still worth
    // having — fairFight falls back to an even split and flags it as estimated.
    const r = readBspStats({ Result: 1, TBS: 2_000_000 })
    expect(r).toMatchObject({ total: 2_000_000, str: null, spd: null, def: null, dex: null })
  })

  it('survives a malformed body', () => {
    expect(readBspStats(null)).toBeNull()
    expect(readBspStats({})).toBeNull()
  })
})
