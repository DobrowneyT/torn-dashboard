// TNL's Steadfast rotation (#395).
//
// People plan training around this — a training book is five days of
// commitment — so an off-by-one at a swap boundary mislabels a fortnight and
// costs someone real gains. The boundary cases carry most of the weight here.
import { describe, expect, it } from 'vitest'
import {
  picksOn, rotationSegments, deriveMagnitudes, percentagesFor,
  STR_SPD_SWAP_DAY, DEF_DEX_SWAP_DAY,
} from '../steadfastRotation'

const on = (y, m, d) => new Date(Date.UTC(y, m - 1, d))

describe('picksOn — the anchors MonChoon gave', () => {
  it('has speed and defense boosted on 14 August 2026', () => {
    expect(picksOn(on(2026, 8, 14))).toEqual({ strSpd: 'speed', defDex: 'defense' })
  })

  it('⚠️ swaps DEF→DEX on the 16th, not the 15th', () => {
    // The written rule is "DEF/DEX SWAP ON 16TH". Confirmed with MonChoon
    // against a conflicting off-hand mention of the 15th; the 15th is the last
    // DEF day.
    expect(DEF_DEX_SWAP_DAY).toBe(16)
    expect(picksOn(on(2026, 8, 15)).defDex).toBe('defense')
    expect(picksOn(on(2026, 8, 16)).defDex).toBe('dexterity')
  })

  it('swaps SPD→STR on 1 September 2026', () => {
    expect(STR_SPD_SWAP_DAY).toBe(1)
    expect(picksOn(on(2026, 8, 31)).strSpd).toBe('speed')
    expect(picksOn(on(2026, 9, 1)).strSpd).toBe('strength')
  })

  it('keeps the two rotations offset by half a month', () => {
    // The whole point of the offset: the pairs never swap on the same day.
    expect(picksOn(on(2026, 9, 1))).toEqual({ strSpd: 'strength', defDex: 'dexterity' })
    expect(picksOn(on(2026, 9, 16))).toEqual({ strSpd: 'strength', defDex: 'defense' })
    expect(picksOn(on(2026, 10, 1))).toEqual({ strSpd: 'speed', defDex: 'defense' })
    expect(picksOn(on(2026, 10, 16))).toEqual({ strSpd: 'speed', defDex: 'dexterity' })
  })

  it('predicts a year out without drifting', () => {
    // 12 months on, both pairs are back where they started.
    expect(picksOn(on(2027, 8, 14))).toEqual({ strSpd: 'speed', defDex: 'defense' })
    expect(picksOn(on(2027, 9, 1)).strSpd).toBe('strength')
  })

  it('⚠️ alternates correctly BEFORE the anchor too', () => {
    // JavaScript's % returns a negative remainder for negative operands, which
    // would silently invert every month in the past — and the calendar can be
    // paged backwards.
    expect(picksOn(on(2026, 7, 20)).strSpd).toBe('strength')
    expect(picksOn(on(2026, 6, 10)).strSpd).toBe('speed')
    expect(picksOn(on(2026, 7, 15)).defDex).toBe('dexterity')
    expect(picksOn(on(2026, 7, 16)).defDex).toBe('defense')
  })

  it('handles the January boundary, where the DEF/DEX period starts last year', () => {
    // A date before the 16th belongs to the period that started in December —
    // so the DEF/DEX pick matches 20 December. Only that pair: the STR/SPD
    // rotation is per calendar month and January is genuinely a new month.
    expect(picksOn(on(2027, 1, 10)).defDex).toBe(picksOn(on(2026, 12, 20)).defDex)
    expect(picksOn(on(2027, 1, 10)).strSpd).not.toBe(picksOn(on(2026, 12, 20)).strSpd)
  })
})

describe('rotationSegments', () => {
  it('splits a month at both swap days', () => {
    const segs = rotationSegments(on(2026, 8, 1), on(2026, 8, 31))
    expect(segs).toHaveLength(2)
    expect(segs[0]).toMatchObject({ strSpd: 'speed', defDex: 'defense' })
    expect(segs[0].end.toISOString().slice(0, 10)).toBe('2026-08-15')
    expect(segs[1]).toMatchObject({ strSpd: 'speed', defDex: 'dexterity' })
    expect(segs[1].start.toISOString().slice(0, 10)).toBe('2026-08-16')
  })

  it('clips to the requested window and says which ends were clipped', () => {
    const segs = rotationSegments(on(2026, 8, 10), on(2026, 8, 20))
    expect(segs[0].start.toISOString().slice(0, 10)).toBe('2026-08-10')
    expect(segs[0].clippedStart).toBe(true)
    expect(segs[segs.length - 1].end.toISOString().slice(0, 10)).toBe('2026-08-20')
    expect(segs[segs.length - 1].clippedEnd).toBe(true)
  })

  it('covers a six-week grid that overflows into both neighbouring months', () => {
    const segs = rotationSegments(on(2026, 7, 27), on(2026, 9, 6))
    // 27–31 Jul, 1–15 Aug, 16–31 Aug, 1–6 Sep
    expect(segs).toHaveLength(4)
    // 27–31 July is still inside the DEF period that started 16 July.
    expect(segs[0]).toMatchObject({ strSpd: 'strength', defDex: 'defense' })
    expect(segs[3]).toMatchObject({ strSpd: 'strength', defDex: 'dexterity' })
    // Contiguous, no gaps and no overlaps.
    for (let i = 1; i < segs.length; i++) {
      expect(segs[i].start.getTime() - segs[i - 1].end.getTime()).toBe(86_400_000)
    }
  })

  it('reads each segment\'s picks from its own start, never carried over', () => {
    const segs = rotationSegments(on(2026, 8, 16), on(2026, 8, 31))
    expect(segs).toHaveLength(1)
    expect(segs[0].defDex).toBe('dexterity')
  })

  it('returns nothing for a nonsense window', () => {
    expect(rotationSegments(on(2026, 8, 20), on(2026, 8, 10))).toEqual([])
    expect(rotationSegments(null, on(2026, 8, 10))).toEqual([])
  })
})

describe('deriveMagnitudes', () => {
  // Observed 14 Aug 2026, when speed and defense held the secondaries.
  const picks = { strSpd: 'speed', defDex: 'defense' }
  const snap = (over = {}) => ({
    snapshot_date: '2026-08-14',
    steadfast_strength: 10, steadfast_speed: 15,
    steadfast_defense: 15, steadfast_dexterity: 10,
    ...over,
  })

  it('splits each pair into a main level and the secondary bonus', () => {
    const m = deriveMagnitudes(snap(), picks)
    expect(m.strSpd).toMatchObject({ main: 10, bonus: 5, suspect: false })
    expect(m.defDex).toMatchObject({ main: 10, bonus: 5, suspect: false })
  })

  it('reads a tertiary bonus as the larger gap, without being told about it', () => {
    // MonChoon, 2026-08-14: "We dont have anything at 20% at the moment" — but
    // the moment they buy it, the observation carries it. Nothing here is
    // hard-coded to 5.
    const m = deriveMagnitudes(snap({ steadfast_speed: 20 }), picks)
    expect(m.strSpd.bonus).toBe(10)
  })

  it('handles a main tree that is not maxed', () => {
    const m = deriveMagnitudes(snap({ steadfast_strength: 7, steadfast_speed: 12 }), picks)
    expect(m.strSpd).toMatchObject({ main: 7, bonus: 5 })
  })

  it('⚠️ flags a pair where the pick reads LOWER than the other stat', () => {
    // Then the equal-mains assumption has failed, and the split is not
    // trustworthy. Better to say so than to present a negative bonus as fact.
    const m = deriveMagnitudes(snap({ steadfast_speed: 8 }), picks)
    expect(m.strSpd.suspect).toBe(true)
  })

  it('⚠️ returns nulls, never zeros, for an unreadable stat', () => {
    const m = deriveMagnitudes(snap({ steadfast_speed: null }), picks)
    expect(m.strSpd).toMatchObject({ main: null, bonus: null })
  })

  it('is null with no snapshot at all', () => {
    expect(deriveMagnitudes(null, picks)).toBeNull()
  })
})

describe('percentagesFor', () => {
  const magnitudes = {
    strSpd: { main: 10, bonus: 5, suspect: false },
    defDex: { main: 10, bonus: 5, suspect: false },
  }

  it('moves the bonus onto whichever stat the rotation picks', () => {
    expect(percentagesFor({ strSpd: 'speed', defDex: 'defense' }, magnitudes))
      .toEqual({ strength: 10, speed: 15, defense: 15, dexterity: 10 })
    // ...and a fortnight later the same magnitudes land elsewhere.
    expect(percentagesFor({ strSpd: 'strength', defDex: 'dexterity' }, magnitudes))
      .toEqual({ strength: 15, speed: 10, defense: 10, dexterity: 15 })
  })

  it('⚠️ claims nothing when the faction upgrades have never been scraped', () => {
    // The rotation is still known and still worth showing; the percentages are
    // not, and must not default to a plausible-looking 15/10.
    expect(percentagesFor({ strSpd: 'speed', defDex: 'defense' }, null))
      .toEqual({ strength: null, speed: null, defense: null, dexterity: null })
  })
})
