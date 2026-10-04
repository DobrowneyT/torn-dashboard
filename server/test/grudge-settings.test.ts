import { describe, expect, it } from 'vitest'
import {
  slugify, normaliseSeverities, normaliseWatchedFactions, removedSeverityIds,
} from '../src/grudgeSettings.js'

describe('normaliseSeverities', () => {
  it('mints a stable id from the label for a new entry', () => {
    const r = normaliseSeverities([{ label: 'Blood feud' }])
    expect(r).toEqual({ ok: true, severities: [{ id: 'blood-feud', label: 'Blood feud' }] })
  })

  it('⚠️ KEEPS an existing id when the label is renamed', () => {
    // grudge_entries.severity_id points at it. Re-slugging on every save would
    // orphan every grudge using the old name, and the column would quietly
    // start rendering a raw slug instead of a label.
    const r = normaliseSeverities([{ id: 'petty', label: 'Mildly annoying' }])
    expect(r).toEqual({ ok: true, severities: [{ id: 'petty', label: 'Mildly annoying' }] })
  })

  it('⚠️ disambiguates two labels that slug to the same id', () => {
    // Otherwise the second silently takes over the first's meaning for every
    // grudge pointing at that id.
    const r = normaliseSeverities([{ label: 'Blood feud' }, { label: 'blood-feud' }])
    expect(r.ok && r.severities.map((s) => s.id)).toEqual(['blood-feud', 'blood-feud-2'])
  })

  it('refuses a duplicate id that was supplied explicitly', () => {
    const r = normaliseSeverities([{ id: 'x', label: 'One' }, { id: 'x', label: 'Two' }])
    expect(r).toEqual({ ok: false, error: 'duplicate severity id "x"' })
  })

  it('refuses two identical labels, which nobody could tell apart', () => {
    const r = normaliseSeverities([{ label: 'Petty' }, { label: 'petty' }])
    expect(r.ok).toBe(false)
  })

  it('refuses a blank label', () => {
    expect(normaliseSeverities([{ label: '   ' }]).ok).toBe(false)
    expect(normaliseSeverities([{}]).ok).toBe(false)
  })

  it('⚠️ accepts an empty list — that is "no severities", not an error', () => {
    // A faction that wants none gets a control that does not render.
    expect(normaliseSeverities([])).toEqual({ ok: true, severities: [] })
  })

  it('refuses something that is not a list at all', () => {
    expect(normaliseSeverities(null).ok).toBe(false)
    expect(normaliseSeverities({ a: 1 }).ok).toBe(false)
  })

  it('⚠️ order is the ARRAY order, with no separate order field', () => {
    // A second source of truth for the same fact is a second thing to drift.
    const r = normaliseSeverities([{ label: 'C' }, { label: 'A' }, { label: 'B' }])
    expect(r.ok && r.severities.map((s) => s.label)).toEqual(['C', 'A', 'B'])
  })
})

describe('slugify', () => {
  it('handles punctuation and spacing', () => {
    expect(slugify('Blood Feud!!')).toBe('blood-feud')
    expect(slugify('  spaced  out  ')).toBe('spaced-out')
  })
  it('returns empty for something with no usable characters', () => {
    expect(slugify('!!!')).toBe('')
  })
})

describe('normaliseWatchedFactions', () => {
  it('⚠️ stores ids as STRINGS, whatever was sent', () => {
    // Torn sends numbers, the column is text, and a mixed-type compare matches
    // nothing — which here means an own-faction target reaching the list.
    expect(normaliseWatchedFactions([10739, '8103'])).toEqual({
      ok: true, factions: ['10739', '8103'],
    })
  })

  it('drops duplicates, including ones that differ only by type', () => {
    expect(normaliseWatchedFactions(['1', 1, '1'])).toEqual({ ok: true, factions: ['1'] })
  })

  it('refuses anything that is not a faction id', () => {
    expect(normaliseWatchedFactions(['TNL']).ok).toBe(false)
    expect(normaliseWatchedFactions([''] ).ok).toBe(false)
  })

  it('accepts an empty list — watching nothing is a valid policy', () => {
    expect(normaliseWatchedFactions([])).toEqual({ ok: true, factions: [] })
  })
})

describe('removedSeverityIds', () => {
  it('names what disappeared, so the caller can warn about grudges using it', () => {
    const before = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]
    expect(removedSeverityIds(before, [{ id: 'a', label: 'A' }])).toEqual(['b'])
  })
  it('reports nothing for a pure rename', () => {
    const before = [{ id: 'a', label: 'A' }]
    expect(removedSeverityIds(before, [{ id: 'a', label: 'Renamed' }])).toEqual([])
  })
})
