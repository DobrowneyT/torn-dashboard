// Configurable roster refresh cadence (#339).
import { describe, it, expect } from 'vitest'
import {
  ROSTER_POLL_MIN_MS, ROSTER_POLL_MAX_MS, ROSTER_POLL_DEFAULT_MS,
  TICKER_HEARTBEAT_MS, rosterPollDue,
  minSustainableIntervalMs, safeRosterIntervalMs,
} from '../src/warRoomRosterPoll.js'
import { CONFIG_BOUNDS, clampConfigValue } from '../src/warRoomConfigBounds.js'

const NOW = 1_700_000_000_000

describe('roster poll bounds', () => {
  it('floors at 2 Hz', () => {
    // Each sync is two Torn calls (their roster + ours), so 2 Hz already means
    // 240 calls a minute against a pool shared with chains and the scrapers.
    expect(ROSTER_POLL_MIN_MS).toBe(500)
  })

  it('keeps the ticker heartbeat fast enough to actually deliver the floor', () => {
    // The gate can only fire on a heartbeat: a 1000ms heartbeat could never
    // deliver a 500ms cadence no matter what the config said.
    expect(TICKER_HEARTBEAT_MS).toBeLessThanOrEqual(ROSTER_POLL_MIN_MS)
  })

  it('defaults to the 1 Hz the board ran at before it was configurable', () => {
    expect(ROSTER_POLL_DEFAULT_MS).toBe(1000)
  })
})

describe('rosterPollDue', () => {
  it('polls immediately when nothing has synced yet', () => {
    expect(rosterPollDue(null, 1000, NOW)).toBe(true)
    expect(rosterPollDue(undefined, 1000, NOW)).toBe(true)
  })

  it('waits out the configured interval', () => {
    expect(rosterPollDue(NOW - 999, 1000, NOW)).toBe(false)
    expect(rosterPollDue(NOW - 1000, 1000, NOW)).toBe(true)
  })

  it('honours a faster cadence down to the floor', () => {
    expect(rosterPollDue(NOW - 499, 500, NOW)).toBe(false)
    expect(rosterPollDue(NOW - 500, 500, NOW)).toBe(true)
  })

  it('honours a slower cadence for a termed war', () => {
    // The reason this setting exists: 1 Hz on both rosters is wasted calls
    // when nothing is happening.
    expect(rosterPollDue(NOW - 4000, 10_000, NOW)).toBe(false)
    expect(rosterPollDue(NOW - 10_000, 10_000, NOW)).toBe(true)
  })

  it('clamps a below-floor cadence rather than honouring it', () => {
    // Defence in depth: a row edited directly in psql must not outrun 2 Hz.
    expect(rosterPollDue(NOW - 100, 50, NOW)).toBe(false)
    expect(rosterPollDue(NOW - 500, 50, NOW)).toBe(true)
  })

  it('clamps an absurdly slow cadence to the ceiling', () => {
    expect(rosterPollDue(NOW - ROSTER_POLL_MAX_MS, 999_999, NOW)).toBe(true)
  })

  it('falls back to the default on a non-numeric cadence', () => {
    expect(rosterPollDue(NOW - 1000, NaN, NOW)).toBe(true)
    expect(rosterPollDue(NOW - 999, NaN, NOW)).toBe(false)
  })

  it('never polls when the cadence is 0 (#345 off switch)', () => {
    // Off must beat staleness, or "stop polling" would resume on the first
    // tick after a restart.
    expect(rosterPollDue(null, 0, NOW)).toBe(false)
    expect(rosterPollDue(NOW - 999_999, 0, NOW)).toBe(false)
  })
})

describe('roster_poll_interval_ms in CONFIG_BOUNDS', () => {
  const field = 'roster_poll_interval_ms'

  it('allows 0 (off) through to the 60s ceiling', () => {
    expect(CONFIG_BOUNDS[field]).toEqual({ min: 0, max: ROSTER_POLL_MAX_MS })
  })

  it('raises a positive too-fast request to the 2 Hz floor', () => {
    expect(clampConfigValue(field, 1)).toEqual({ ok: true, value: 500 })
  })

  it('keeps 0 as off rather than clamping it to the floor (#345)', () => {
    // Same trap as the member-stats cadence: a plain clamp would turn the
    // operator's "stop" into "as fast as possible".
    expect(clampConfigValue(field, 0)).toEqual({ ok: true, value: 0 })
    expect(clampConfigValue(field, -1000)).toEqual({ ok: true, value: 0 })
  })

  it('accepts the usable range unchanged', () => {
    expect(clampConfigValue(field, 500)).toEqual({ ok: true, value: 500 })
    expect(clampConfigValue(field, 2000)).toEqual({ ok: true, value: 2000 })
    expect(clampConfigValue(field, 60_000)).toEqual({ ok: true, value: 60_000 })
  })

  it('caps a too-slow request', () => {
    expect(clampConfigValue(field, 999_999)).toEqual({ ok: true, value: 60_000 })
  })

  it('rejects non-numeric input', () => {
    expect(clampConfigValue(field, '')).toMatchObject({ ok: false })
    expect(clampConfigValue(field, true)).toMatchObject({ ok: false })
  })
})

describe('minSustainableIntervalMs (#342)', () => {
  it('holds a one-key pool to 1.5s', () => {
    // Two calls per sync on ONE key: at 1s that is 120 calls/min against
    // Torn's 100/min limit. This is the case that froze the board.
    expect(minSustainableIntervalMs(1)).toBe(1500)
  })

  it('lets a larger pool go faster, down to the absolute floor', () => {
    expect(minSustainableIntervalMs(2)).toBe(750)
    expect(minSustainableIntervalMs(3)).toBe(ROSTER_POLL_MIN_MS)
    expect(minSustainableIntervalMs(50)).toBe(ROSTER_POLL_MIN_MS)
  })

  it('never returns faster than the absolute floor however large the pool', () => {
    expect(minSustainableIntervalMs(10_000)).toBe(ROSTER_POLL_MIN_MS)
  })

  it('treats a missing or nonsense pool size as one key', () => {
    // Fail toward the SLOWEST assumption — the failure mode of guessing high
    // is a frozen board.
    expect(minSustainableIntervalMs(0)).toBe(1500)
    expect(minSustainableIntervalMs(NaN)).toBe(1500)
    expect(minSustainableIntervalMs(-5)).toBe(1500)
  })
})

describe('safeRosterIntervalMs (#342)', () => {
  it('overrides a cadence the pool cannot sustain', () => {
    // The exact reported failure: 0.5s configured against a small pool.
    expect(safeRosterIntervalMs(500, 1)).toBe(1500)
    expect(safeRosterIntervalMs(500, 2)).toBe(750)
  })

  it('honours a cadence the pool can sustain', () => {
    expect(safeRosterIntervalMs(500, 3)).toBe(500)
    expect(safeRosterIntervalMs(5000, 1)).toBe(5000)
  })

  it('never speeds a slow setting up', () => {
    // The override is a floor, not a target — a lead who asked for 10s during
    // a termed war must still get 10s on a 50-key pool.
    expect(safeRosterIntervalMs(10_000, 50)).toBe(10_000)
  })

  it('falls back to the default when unset, still respecting the pool', () => {
    expect(safeRosterIntervalMs(null, 5)).toBe(ROSTER_POLL_DEFAULT_MS)
  })

  it('preserves 0 as off instead of raising it to the sustainable floor (#345)', () => {
    // The pool floor must not resurrect a poll the operator switched off.
    expect(safeRosterIntervalMs(0, 1)).toBe(0)
    expect(safeRosterIntervalMs(0, 50)).toBe(0)
  })

  it('still caps at the ceiling', () => {
    expect(safeRosterIntervalMs(999_999, 5)).toBe(ROSTER_POLL_MAX_MS)
  })
})
