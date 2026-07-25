// #230: precise competition boundary timers. Pure/injected — no DB, no Torn,
// no real sleeping. Verifies the scheduling decision and that arming fires a
// start capture, an end capture, and an auto-freeze only for auto_resolve.
import { describe, it, expect } from 'vitest'
import { scheduleFor, createCompetitionTimers } from '../src/competitions/competitionTimers.js'

const NOW = Date.parse('2026-08-01T12:00:00Z')
const base = { metric_id: 'x', direction: 'desc', window_kind: 'fixed' as const }

describe('scheduleFor (#230)', () => {
  it('future start/end → delays until each instant', () => {
    expect(scheduleFor({ ...base, window_start: '2026-08-01T13:00:00Z', window_end: '2026-08-01T18:00:00Z' }, NOW))
      .toEqual({ start: 3_600_000, end: 6 * 3_600_000 })
  })

  it('a just-passed start (within grace) → "now"; a long-past start → null', () => {
    expect(scheduleFor({ ...base, window_start: '2026-08-01T11:58:00Z', window_end: '2026-08-01T18:00:00Z' }, NOW).start).toBe('now')
    expect(scheduleFor({ ...base, window_start: '2026-07-01T00:00:00Z', window_end: '2026-08-01T18:00:00Z' }, NOW).start).toBeNull()
  })

  it('a past end → null (backstop handles it); rolling/no-window → nulls', () => {
    expect(scheduleFor({ ...base, window_start: '2026-08-01T13:00:00Z', window_end: '2026-08-01T11:00:00Z' }, NOW).end).toBeNull()
    expect(scheduleFor({ metric_id: 'x', direction: 'desc', window_kind: 'rolling', rolling_days: 7 }, NOW))
      .toEqual({ start: null, end: null })
  })
})

function harness(dbRows: unknown[] = []) {
  const scheduled: { fn: () => void; ms: number }[] = []
  const captures: string[] = []
  const resolves: (string | number)[] = []
  const timers = createCompetitionTimers({
    db: { query: async () => ({ rows: dbRows }) } as never,
    deps: {} as never,
    capture: async (_deps, at) => { captures.push(at.toISOString()); return 1 },
    resolve: async (c) => { resolves.push(c.id!); return null },
    setTimer: (fn, ms) => { const h = { fn, ms }; scheduled.push(h); return h },
    clearTimer: () => {},
    now: () => NOW,
  })
  return { timers, scheduled, captures, resolves }
}

describe('createCompetitionTimers (#230)', () => {
  it('arms a start capture and an end capture + auto-freeze at the right delays', async () => {
    const { timers, scheduled, captures, resolves } = harness()
    timers.arm({ ...base, id: 7, auto_resolve: true,
      window_start: '2026-08-01T13:00:00Z', window_end: '2026-08-01T18:00:00Z' }, { immediate: true })

    expect(scheduled.map((s) => s.ms)).toEqual([3_600_000, 6 * 3_600_000])
    await scheduled[0].fn() // start timer fires
    expect(captures).toEqual(['2026-08-01T13:00:00.000Z'])
    await scheduled[1].fn() // end timer fires → capture at end_ts, then freeze
    expect(captures).toEqual(['2026-08-01T13:00:00.000Z', '2026-08-01T18:00:00.000Z'])
    expect(resolves).toEqual([7])
  })

  it('captures a just-started competition\'s baseline immediately (no start timer)', async () => {
    const { timers, scheduled, captures } = harness()
    timers.arm({ ...base, id: 8, auto_resolve: false,
      window_start: '2026-08-01T11:59:00Z', window_end: '2026-08-01T18:00:00Z' }, { immediate: true })
    // Only the end timer is scheduled; the baseline fired immediately.
    expect(scheduled.map((s) => s.ms)).toEqual([6 * 3_600_000])
    await new Promise((r) => setTimeout(r, 0)) // let the immediate capture run
    expect(captures).toEqual(['2026-08-01T11:59:00.000Z'])
  })

  it('does NOT auto-freeze a non-auto competition at end — it only captures', async () => {
    const { timers, scheduled, captures, resolves } = harness()
    timers.arm({ ...base, id: 9, auto_resolve: false,
      window_start: '2026-08-01T13:00:00Z', window_end: '2026-08-01T18:00:00Z' }, { immediate: true })
    await scheduled[1].fn() // end timer
    expect(captures).toContain('2026-08-01T18:00:00.000Z')
    expect(resolves).toEqual([])
  })

  it('rearmAll arms fixed competitions from the DB and skips fully-past ones', async () => {
    const rows = [
      { ...base, id: 1, window_start: '2026-08-01T13:00:00Z', window_end: '2026-08-01T18:00:00Z' }, // future
      { ...base, id: 2, window_start: '2026-07-01T00:00:00Z', window_end: '2026-07-02T00:00:00Z' }, // past
    ]
    const { timers, scheduled } = harness(rows)
    await timers.rearmAll()
    // comp 1 → start + end (2 timers); comp 2 fully past → none.
    expect(scheduled.length).toBe(2)
  })
})
