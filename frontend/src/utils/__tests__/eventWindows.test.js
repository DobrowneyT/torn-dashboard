// Per-member Torn event start windows (#459).
//
// This is consent-gated personal data, so the tests care about two things
// beyond correctness: an unreadable value must never masquerade as a real one,
// and nothing here may report on the people who declined.
import { describe, expect, it } from 'vitest'
import { parseStartTime, formatStartTime, eventWindowRows, coverageByHour, windowCoverage } from '../eventWindows'

const rows = [
  { member_id: '1', member_name: 'Zara', start_time: '20:00 TCT' },
  { member_id: '2', member_name: 'Ade', start_time: '08:30 TCT' },
  { member_id: '3', member_name: 'Mo', start_time: '08:00 TCT' },
]

describe('parseStartTime', () => {
  it('reads the shape Torn sends', () => {
    expect(parseStartTime('11:30 TCT')).toBe(11 * 60 + 30)
    expect(parseStartTime('9:05 TCT')).toBe(9 * 60 + 5)
    expect(parseStartTime('00:00 TCT')).toBe(0)
  })

  it('⚠️ rejects a time that does not exist rather than computing with it', () => {
    // A window built from 24:70 lands in a day that is not there, and nothing
    // downstream would notice.
    expect(parseStartTime('24:00 TCT')).toBeNull()
    expect(parseStartTime('12:61 TCT')).toBeNull()
  })

  it('returns null for junk instead of a plausible number', () => {
    expect(parseStartTime('soon')).toBeNull()
    expect(parseStartTime('')).toBeNull()
    expect(parseStartTime(null)).toBeNull()
    expect(parseStartTime(1130)).toBeNull()
  })
})

describe('formatStartTime', () => {
  it('normalises and pads', () => {
    expect(formatStartTime('9:05 TCT')).toBe('09:05 TCT')
  })

  it('is null when the stored string cannot be read', () => {
    // Not the raw string echoed back — the UI shows a dash, and passing junk
    // through would present it as a time.
    expect(formatStartTime('whenever')).toBeNull()
  })
})

describe('eventWindowRows', () => {
  it('orders by when the window opens, not by name', () => {
    expect(eventWindowRows(rows).map((r) => r.memberName)).toEqual(['Mo', 'Ade', 'Zara'])
  })

  it('⚠️ sinks an unreadable time to the bottom in BOTH directions', () => {
    // The #351 rule. A string we failed to parse must not sort as midnight and
    // lead the list.
    const withJunk = [...rows, { member_id: '4', member_name: 'Bad', start_time: 'dunno' }]
    expect(eventWindowRows(withJunk, { direction: 'asc' }).at(-1).memberName).toBe('Bad')
    expect(eventWindowRows(withJunk, { direction: 'desc' }).at(-1).memberName).toBe('Bad')
  })

  it('falls back to the member id when we have no name', () => {
    expect(eventWindowRows([{ member_id: '77', start_time: '10:00 TCT' }])[0].memberName).toContain('77')
  })

  it('keeps the raw string alongside the parse', () => {
    // So a format change is diagnosable from the UI rather than needing a
    // database session.
    expect(eventWindowRows(rows)[0].raw).toBe('08:00 TCT')
  })

  it('survives an empty or absent list', () => {
    expect(eventWindowRows([])).toEqual([])
    expect(eventWindowRows(null)).toEqual([])
  })
})

describe('coverageByHour', () => {
  it('groups members into the hour they start', () => {
    const buckets = coverageByHour(rows)
    expect(buckets.map((b) => b.label)).toEqual(['08:00', '20:00'])
    expect(buckets[0].members.map((m) => m.memberName)).toEqual(['Mo', 'Ade'])
  })

  it('⚠️ omits hours nobody picked', () => {
    // A 24-row table that is mostly zeroes hides the rows that matter.
    expect(coverageByHour(rows)).toHaveLength(2)
  })

  it('excludes members whose time could not be read', () => {
    const buckets = coverageByHour([...rows, { member_id: '4', member_name: 'Bad', start_time: 'x' }])
    expect(buckets.flatMap((b) => b.members).map((m) => m.memberName)).not.toContain('Bad')
  })
})

describe('windowCoverage', () => {
  it('counts what was shared and what was readable', () => {
    const c = windowCoverage([...rows, { member_id: '4', member_name: 'Bad', start_time: 'x' }])
    expect(c).toEqual({ shared: 4, readable: 3 })
  })

  it('⚠️ reports nothing about the people who declined', () => {
    // Members who did not opt in are absent from the payload entirely, so
    // there is no faction total here on purpose — "12 of 80" would be
    // publishing how many people said no.
    expect(Object.keys(windowCoverage(rows))).toEqual(['shared', 'readable'])
  })
})
