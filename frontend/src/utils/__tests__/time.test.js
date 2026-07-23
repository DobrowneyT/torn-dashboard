// #104: the API serves timestamps as Postgres text (via the PostgREST-shape
// type parsers), whose short offset (+00) JS Date rejects — Global Admin
// rendered 'Invalid Date' everywhere. parseDbTime accepts every shape the
// stack emits.
import { describe, expect, it } from 'vitest'
import { parseDbTime, fmtDbTime, fmtAgo } from '../time'

describe('fmtAgo', () => {
  const now = Date.UTC(2026, 6, 23, 12, 0, 0)
  it('renders minutes/hours/days ago from a Postgres +00 timestamp', () => {
    expect(fmtAgo('2026-07-23T11:30:00+00', now)).toBe('30m ago')
    expect(fmtAgo('2026-07-23T09:00:00+00', now)).toBe('3h ago')
    expect(fmtAgo('2026-07-21T12:00:00+00', now)).toBe('2d ago')
  })
  it('says "just now" for very recent or future, "—" when absent', () => {
    expect(fmtAgo('2026-07-23T11:59:30+00', now)).toBe('just now')
    expect(fmtAgo(null, now)).toBe('—')
  })
})

describe('parseDbTime', () => {
  it('parses Postgres timestamptz text with a short offset (+00)', () => {
    const d = parseDbTime('2026-07-11T11:21:00.626684+00')
    expect(d).toBeInstanceOf(Date)
    expect(d.getTime()).toBe(Date.UTC(2026, 6, 11, 11, 21, 0, 626))
  })

  it('parses full-offset and Z ISO strings unchanged', () => {
    expect(parseDbTime('2026-07-11T11:21:00+00:00').getTime())
      .toBe(Date.UTC(2026, 6, 11, 11, 21, 0))
    expect(parseDbTime('2026-07-11T11:21:00Z').getTime())
      .toBe(Date.UTC(2026, 6, 11, 11, 21, 0))
  })

  it('parses offset-less timestamps as UTC (PostgREST timestamp-without-tz shape)', () => {
    expect(parseDbTime('2026-07-01T00:00:00').getTime())
      .toBe(Date.UTC(2026, 6, 1, 0, 0, 0))
  })

  it('returns null for empty/invalid input', () => {
    expect(parseDbTime(null)).toBeNull()
    expect(parseDbTime('')).toBeNull()
    expect(parseDbTime('not a date')).toBeNull()
  })
})

describe('fmtDbTime', () => {
  it('renders a dash for missing values and never "Invalid Date"', () => {
    expect(fmtDbTime(null)).toBe('—')
    expect(fmtDbTime('garbage')).toBe('—')
    expect(fmtDbTime('2026-07-11T11:21:00.626684+00')).not.toContain('Invalid')
  })
})
