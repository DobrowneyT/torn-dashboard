// Configurable roster refresh cadence (#339).
import { describe, it, expect } from 'vitest'
import {
  ROSTER_POLL_MIN_MS, ROSTER_POLL_MAX_MS, ROSTER_POLL_DEFAULT_MS,
  TICKER_HEARTBEAT_MS, rosterPollDue,
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
    // 0 is NOT an off switch here — unlike member stats, a war room with no
    // roster polling is just broken, so nonsense reverts to the default.
    expect(rosterPollDue(NOW - 1000, NaN, NOW)).toBe(true)
    expect(rosterPollDue(NOW - 999, NaN, NOW)).toBe(false)
  })
})

describe('roster_poll_interval_ms in CONFIG_BOUNDS', () => {
  const field = 'roster_poll_interval_ms'

  it('is clamped server-side to the same window', () => {
    expect(CONFIG_BOUNDS[field]).toEqual({ min: ROSTER_POLL_MIN_MS, max: ROSTER_POLL_MAX_MS })
  })

  it('raises a too-fast request to the 2 Hz floor instead of rejecting it', () => {
    expect(clampConfigValue(field, 1)).toEqual({ ok: true, value: 500 })
    expect(clampConfigValue(field, 0)).toEqual({ ok: true, value: 500 })
    expect(clampConfigValue(field, -1000)).toEqual({ ok: true, value: 500 })
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
