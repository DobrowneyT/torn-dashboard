// Server-side clamping of war-room cadence config (#260).
//
// The client already clamps these inputs, but PUT /api/war-room/config wrote
// whatever it was handed straight to the DB — so a crafted request (or a future
// UI change) could set a chain poller to 0s and hammer Torn. The clamp table is
// pure, so it unit-tests here; the endpoint wiring is asserted in
// war-room-setup.test.ts against a real database.
import { describe, it, expect } from 'vitest'
import { CONFIG_BOUNDS, ZERO_OR_FLOOR, clampConfigValue } from '../src/warRoomConfigBounds.js'

describe('clampConfigValue — cadence floors', () => {
  it('floors a chain poll interval that would poll faster than the safety minimum', () => {
    // The whole point of #260: never faster than 0.5s, and these fields are
    // integer seconds, so 1s is the practical floor.
    for (const field of ['chain_poll_interval_ours_sec', 'chain_poll_interval_enemy_sec']) {
      // ⚠️ 0 is now OFF, not "as fast as allowed" — see the zero-or-floor
      // suite below. Only a POSITIVE value under the floor gets raised.
      expect(clampConfigValue(field, 0)).toEqual({ ok: true, value: 0 })
      expect(clampConfigValue(field, 0.1)).toEqual({ ok: true, value: 0 })
      expect(clampConfigValue(field, -30)).toEqual({ ok: true, value: 0 })
      expect(clampConfigValue(field, 1)).toEqual({ ok: true, value: 1 })
    }
  })

  it('caps a chain poll interval at the existing 600s maximum', () => {
    expect(clampConfigValue('chain_poll_interval_ours_sec', 9999)).toEqual({ ok: true, value: 600 })
  })

  it('leaves an in-range value untouched', () => {
    expect(clampConfigValue('chain_poll_interval_ours_sec', 5)).toEqual({ ok: true, value: 5 })
    expect(clampConfigValue('chain_poll_interval_enemy_sec', 30)).toEqual({ ok: true, value: 30 })
  })

  it('floors fractional seconds rather than storing a float', () => {
    expect(clampConfigValue('chain_poll_interval_ours_sec', 5.9)).toEqual({ ok: true, value: 5 })
  })

  it('accepts a numeric string, as JSON bodies from forms often carry', () => {
    expect(clampConfigValue('chain_poll_interval_ours_sec', '7')).toEqual({ ok: true, value: 7 })
  })
})

describe('clampConfigValue — the other numeric cadence/threshold fields', () => {
  it('clamps every bounded field to its own range, mirroring the client', () => {
    const cases: Array<[string, number, number]> = [
      // field, below-min input → stored, above-max input → stored
      // dibs_expiry_seconds is off-or-floored now and lives in its own suite.
      ['surge_enemy_threshold', 1, 100],
      ['surge_enemy_window_sec', 5, 600],
      ['surge_our_threshold', 1, 100],
      ['surge_our_window_sec', 5, 600],
      ['surge_cooldown_sec', 30, 3600],
      ['tornstats_max_age_days', 0, 365],
    ]
    for (const [field, min, max] of cases) {
      expect(clampConfigValue(field, -1), `${field} floor`).toEqual({ ok: true, value: min })
      expect(clampConfigValue(field, 99999), `${field} cap`).toEqual({ ok: true, value: max })
    }
  })

  it('keeps tornstats_max_age_days = 0 meaningful (0 disables the filter)', () => {
    // 0 is a real setting here, not "unset" — it must survive the clamp.
    expect(clampConfigValue('tornstats_max_age_days', 0)).toEqual({ ok: true, value: 0 })
  })
})

describe('clampConfigValue — non-numeric input', () => {
  it('rejects a value that is not a number, rather than silently storing a floor', () => {
    // Silently writing the minimum would hide a real client bug.
    for (const bad of ['abc', '', null, undefined, {}, [], NaN, Infinity, true]) {
      expect(clampConfigValue('chain_poll_interval_ours_sec', bad).ok, String(bad)).toBe(false)
    }
  })
})

describe('clampConfigValue — unbounded fields pass through', () => {
  it('leaves non-numeric config fields exactly as given', () => {
    // enabled / faction_name / revive_services etc. are not cadence fields and
    // must not be coerced by this table.
    expect(clampConfigValue('enabled', false)).toEqual({ ok: true, value: false })
    expect(clampConfigValue('faction_name', 'Enemy')).toEqual({ ok: true, value: 'Enemy' })
    expect(clampConfigValue('revive_services', [{ name: 'UHC' }]))
      .toEqual({ ok: true, value: [{ name: 'UHC' }] })
    expect(clampConfigValue('faction_name', null)).toEqual({ ok: true, value: null })
  })
})

describe('clampConfigValue — member stats cadence (#336)', () => {
  const field = 'member_stats_poll_interval_sec'

  it('keeps 0 as 0 — it is "off", not "as fast as possible"', () => {
    // The trap this rule exists for: a plain [30,600] clamp would rewrite the
    // operator's "disable it" into the FASTEST allowed cadence, i.e. the exact
    // opposite of what they asked for, silently.
    expect(clampConfigValue(field, 0)).toEqual({ ok: true, value: 0 })
    expect(clampConfigValue(field, '0')).toEqual({ ok: true, value: 0 })
  })

  it('floors any enabled cadence at 30s', () => {
    // One Torn call per enrolled member per cycle, so the floor is a rate-limit
    // guard, not a preference.
    expect(clampConfigValue(field, 1)).toEqual({ ok: true, value: 30 })
    expect(clampConfigValue(field, 29)).toEqual({ ok: true, value: 30 })
    expect(clampConfigValue(field, 30)).toEqual({ ok: true, value: 30 })
  })

  it('treats a negative as off rather than flooring it up to 30', () => {
    // Nonsense input should fail toward "do nothing", never toward "poll hard".
    expect(clampConfigValue(field, -5)).toEqual({ ok: true, value: 0 })
  })

  it('rounds a fractional cadence down without escaping the floor', () => {
    expect(clampConfigValue(field, 0.9)).toEqual({ ok: true, value: 0 })
    expect(clampConfigValue(field, 45.9)).toEqual({ ok: true, value: 45 })
  })

  it('caps at the same 600s ceiling as the chain pollers', () => {
    expect(clampConfigValue(field, 99999)).toEqual({ ok: true, value: 600 })
  })

  it('still rejects non-numeric input instead of coercing it to off', () => {
    // An empty input must not read as a deliberate "disable" — Number('') is 0.
    expect(clampConfigValue(field, '')).toMatchObject({ ok: false })
    expect(clampConfigValue(field, true)).toMatchObject({ ok: false })
    expect(clampConfigValue(field, 'soon')).toMatchObject({ ok: false })
  })
})

describe('CONFIG_BOUNDS', () => {
  it('never allows a poll cadence below the 0.5s safety floor', () => {
    // A guard on the table itself: someone lowering a floor in a future edit
    // trips this rather than shipping a Torn-hammering default.
    //
    // ⚠️ Asserted against the EFFECTIVE floor, not CONFIG_BOUNDS.min. These
    // fields are off-or-floored, so their `min` is legitimately 0 — that is
    // what lets a lead disable them — and the real floor for any ENABLED
    // value lives in ZERO_OR_FLOOR.
    for (const field of ['chain_poll_interval_ours_sec', 'chain_poll_interval_enemy_sec']) {
      const effective = ZERO_OR_FLOOR[field] ?? CONFIG_BOUNDS[field].min
      expect(effective, field).toBeGreaterThanOrEqual(0.5)
      // And a positive request below it really is raised, not stored as asked.
      expect(clampConfigValue(field, 0.4)).toEqual({ ok: true, value: 0 })
      expect(clampConfigValue(field, 1)).toEqual({ ok: true, value: effective })
    }
  })

  it('has a min no greater than its max for every bounded field', () => {
    for (const [field, { min, max }] of Object.entries(CONFIG_BOUNDS)) {
      expect(min, field).toBeLessThanOrEqual(max)
    }
  })
})

describe('0 turns a cadence off rather than running it flat out', () => {
  // ⚠️ These three used to have a positive floor, so a lead who set 0 got the
  // FASTEST allowed cadence — the exact opposite of the intent, silently. The
  // client had the matching bug (`Number(x) || 30`, and 0 is falsy), so the
  // field also appeared to revert on screen.

  const offable = ['dibs_expiry_seconds', 'chain_poll_interval_ours_sec', 'chain_poll_interval_enemy_sec']

  it('stores a deliberate 0 as 0', () => {
    for (const field of offable) {
      expect(clampConfigValue(field, 0), field).toEqual({ ok: true, value: 0 })
    }
  })

  it('⚠️ raises a positive under-floor value TO the floor, not to 0', () => {
    // Wanting polling faster than we allow is not the same as not wanting it.
    expect(clampConfigValue('dibs_expiry_seconds', 3)).toEqual({ ok: true, value: 5 })
    expect(clampConfigValue('chain_poll_interval_ours_sec', 1)).toEqual({ ok: true, value: 1 })
  })

  it('still caps at the maximum', () => {
    for (const field of offable) {
      expect(clampConfigValue(field, 9999), field).toEqual({ ok: true, value: 600 })
    }
  })

  it('still rejects junk instead of silently storing "off"', () => {
    // Coercing a client bug into 0 would disable a poller nobody asked to
    // disable — worse than the old behaviour, not better.
    for (const field of offable) {
      expect(clampConfigValue(field, 'abc').ok, field).toBe(false)
      expect(clampConfigValue(field, '').ok, field).toBe(false)
      expect(clampConfigValue(field, true).ok, field).toBe(false)
    }
  })
})
