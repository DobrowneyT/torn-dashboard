// The post-mortem sheet's column model (#480 reshape, MonChoon 2026-09-27).
import { describe, it, expect } from 'vitest'
import {
  idleSeconds, formatIdle, wasAround, outcome, stackRatio,
  sortSnapshot, SNAPSHOT_COLUMNS, ACTIVE_WINDOW_SEC,
} from '../stacksSnapshot'

// Captured at a known instant so "how long idle" is arithmetic, not a clock race.
const CAPTURED = '2026-09-26T18:00:00.000Z'
const capturedSec = Math.floor(Date.parse(CAPTURED) / 1000)
const row = (over = {}) => ({
  member_id: 1, member_name: 'Acid', has_reading: true,
  energy_current: 1000, energy_maximum: 150, od_flagged_prewar: false,
  captured_at: CAPTURED, last_action_epoch: capturedSec - 120,
  on_at_start: true, availability: 'on_time', revised: false, ...over,
})

describe('idle time', () => {
  it('measures from the snapshot, not from now', () => {
    // ⚠️ The whole point: this sheet is read weeks later. Measuring against the
    // reader's clock would make everybody look permanently absent.
    expect(idleSeconds(row({ last_action_epoch: capturedSec - 300 }))).toBe(300)
  })

  it('⚠️ reports NOT RECORDED as null, never as zero', () => {
    // Snapshots predating the activity columns can never be backfilled, and
    // "no data" must not render as "active this second".
    expect(idleSeconds(row({ last_action_epoch: null }))).toBeNull()
    expect(wasAround(row({ last_action_epoch: null }))).toBeNull()
    expect(formatIdle(null)).toBeNull()
  })

  it('never goes negative when a reading post-dates the capture', () => {
    // The sweep and the snapshot are seconds apart; clock skew must not print
    // "-3s idle", which reads as a bug in the sheet rather than in the clock.
    expect(idleSeconds(row({ last_action_epoch: capturedSec + 30 }))).toBe(0)
  })

  it('⚠️ survives a captured_at Postgres offset that Date.parse rejects', () => {
    // `2026-09-26 18:00:00+00` — the bare two-digit offset that took the chain
    // sampler down for two days. It must fall back, not emit NaN.
    const s = idleSeconds(row({ captured_at: '2026-09-26 18:00:00+00' }))
    expect(Number.isFinite(s)).toBe(true)
  })

  it('formats compactly at every scale', () => {
    expect(formatIdle(45)).toBe('45s')
    expect(formatIdle(180)).toBe('3m')
    expect(formatIdle(4320)).toBe('1h 12m')
    expect(formatIdle(200_000)).toBe('2d')
  })
})

describe('outcome — the reason the sheet exists', () => {
  it('marks somebody who said they would be there and was', () => {
    expect(outcome(row()).key).toBe('kept')
  })

  it('marks somebody who said they would be there and was not', () => {
    expect(outcome(row({ last_action_epoch: capturedSec - 86_400 })).key).toBe('missed')
  })

  it('⚠️ singles out people who said they could NOT make it and turned up', () => {
    // Asked for explicitly. Filing these under the same label as someone who
    // merely did as promised throws away the thing worth noticing.
    const turnedUp = row({ on_at_start: false, availability: '6_plus' })
    expect(outcome(turnedUp).key).toBe('bonus')
    expect(outcome(turnedUp).label).toBe('Turned up')
  })

  it('says nothing at all when activity was never recorded', () => {
    // ⚠️ A verdict computed from absent data is a fabricated verdict.
    expect(outcome(row({ last_action_epoch: null })).key).toBe('unknown')
  })

  it('uses the stated active window as its boundary', () => {
    expect(wasAround(row({ last_action_epoch: capturedSec - ACTIVE_WINDOW_SEC }))).toBe(true)
    expect(wasAround(row({ last_action_epoch: capturedSec - ACTIVE_WINDOW_SEC - 1 }))).toBe(false)
  })
})

describe('energy', () => {
  it('ranks by how stacked they were, not by raw energy', () => {
    // ⚠️ 1000/1000 is a full stack; 1000/150 is nearly seven. Sorting on the
    // raw number calls them equal, which is the opposite of the truth.
    expect(stackRatio(row({ energy_current: 1000, energy_maximum: 150 })))
      .toBeGreaterThan(stackRatio(row({ energy_current: 1000, energy_maximum: 1000 })))
  })

  it('is null when no pooled key answered', () => {
    expect(stackRatio(row({ has_reading: false }))).toBeNull()
  })
})

describe('sorting', () => {
  const rows = [
    row({ member_id: 1, member_name: 'Charlie', last_action_epoch: capturedSec - 600 }),
    row({ member_id: 2, member_name: 'alpha',   last_action_epoch: capturedSec - 60 }),
    row({ member_id: 3, member_name: 'Bravo',   last_action_epoch: null }),
  ]

  it('offers a sort for every column', () => {
    // ⚠️ The guard behind "every table should be sortable": a column added
    // later without one silently does nothing when clicked.
    for (const c of SNAPSHOT_COLUMNS) {
      expect(typeof c.sort).toBe('function')
      expect(() => sortSnapshot(rows, c.key, 1)).not.toThrow()
    }
  })

  it('sorts names case-insensitively', () => {
    // 'alpha' before 'Bravo' — a raw comparison puts every capital first.
    expect(sortSnapshot(rows, 'member', 1).map(r => r.member_name))
      .toEqual(['alpha', 'Bravo', 'Charlie'])
  })

  it('⚠️ sinks unrecorded rows in BOTH directions', () => {
    // Reversing should reveal the other end of the real data, not a screen of
    // blanks — the rule the War Room flags column already follows.
    expect(sortSnapshot(rows, 'activity', 1).at(-1).member_name).toBe('Bravo')
    expect(sortSnapshot(rows, 'activity', -1).at(-1).member_name).toBe('Bravo')
  })

  it('breaks ties by name in a fixed direction, so the table cannot reshuffle', () => {
    const tied = [row({ member_id: 1, member_name: 'Zed' }), row({ member_id: 2, member_name: 'Abe' })]
    expect(sortSnapshot(tied, 'od', 1).map(r => r.member_name)).toEqual(['Abe', 'Zed'])
    expect(sortSnapshot(tied, 'od', -1).map(r => r.member_name)).toEqual(['Abe', 'Zed'])
  })

  it('does not mutate the array it was given', () => {
    const before = rows.map(r => r.member_name)
    sortSnapshot(rows, 'activity', -1)
    expect(rows.map(r => r.member_name)).toEqual(before)
  })
})
