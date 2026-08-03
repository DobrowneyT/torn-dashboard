import { describe, it, expect } from 'vitest'
import { boundaryValue, fmtBoundary, windowLabel } from '../competitionWindow.js'

describe('boundaryValue', () => {
  it('sends a bare date when no time is given (API maps to start/end of day)', () => {
    expect(boundaryValue('2026-08-01', '')).toBe('2026-08-01')
  })
  it('sends a full ISO timestamp (TCT/UTC) when a time is given', () => {
    expect(boundaryValue('2026-08-01', '18:00')).toBe('2026-08-01T18:00:00.000Z')
  })
  it('is empty without a date', () => {
    expect(boundaryValue('', '18:00')).toBe('')
  })
})

describe('fmtBoundary', () => {
  it('hides the time for a date-only start (00:00) and end (23:59)', () => {
    expect(fmtBoundary('2026-08-01T00:00:00.000Z', 'start')).toBe('2026-08-01')
    expect(fmtBoundary('2026-08-01T23:59:59.999Z', 'end')).toBe('2026-08-01')
  })
  it('shows the exact time in TCT for an explicit boundary', () => {
    expect(fmtBoundary('2026-08-01T18:00:00.000Z', 'end')).toBe('2026-08-01 18:00 TCT')
    expect(fmtBoundary('2026-08-01T09:30:00.000Z', 'start')).toBe('2026-08-01 09:30 TCT')
  })
  it('parses Postgres-style text with a bare offset', () => {
    expect(fmtBoundary('2026-08-01 18:00:00+00', 'end')).toBe('2026-08-01 18:00 TCT')
  })
  it('is empty for a missing value', () => {
    expect(fmtBoundary(null, 'end')).toBe('')
  })
})

describe('windowLabel', () => {
  it('shows the exact end time to everyone for a timed contest', () => {
    expect(windowLabel({
      window_kind: 'fixed',
      window_start: '2026-08-01T09:00:00.000Z',
      window_end: '2026-08-01T18:00:00.000Z',
    })).toBe('2026-08-01 09:00 TCT → 2026-08-01 18:00 TCT')
  })
  it('keeps a date-only window clean', () => {
    expect(windowLabel({
      window_kind: 'fixed',
      window_start: '2026-08-01T00:00:00.000Z',
      window_end: '2026-08-07T23:59:59.999Z',
    })).toBe('2026-08-01 → 2026-08-07')
  })
  it('summarises a rolling window', () => {
    expect(windowLabel({ window_kind: 'rolling', rolling_days: 10 })).toBe('rolling · last 10 days')
  })
})
