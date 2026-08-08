// Server-side bounds for the numeric war-room config fields (#260).
//
// PUT /api/war-room/config used to write whatever it was handed straight to the
// DB. The client clamps these inputs, but a client clamp is a UX affordance, not
// a control: a crafted request — or a future UI change that drops a `min` — could
// set a chain poller to 0s and have the server-side poller hammer Torn on every
// tick. These bounds are the enforcement.
//
// Mirrors the clamps in frontend/src/views/WarRoomViewV2.jsx. Keep the two in
// step: the client's job is to stop a typo, this one's is to stop everything else.

export interface Bounds {
  min: number
  max: number
}

/**
 * Bounded numeric fields, in seconds unless the name says otherwise. Anything
 * absent from this table (booleans, names, revive_services JSON) passes through
 * untouched — this is a clamp table, not an allowlist. The allowlist is
 * CONFIG_COLUMNS in warRoomSetup.ts.
 */
export const CONFIG_BOUNDS: Record<string, Bounds> = {
  // The #260 floor. These are integer seconds, so 1s is the practical minimum
  // and is comfortably above the 0.5s safety floor the UI refresh uses.
  chain_poll_interval_ours_sec: { min: 1, max: 600 },
  chain_poll_interval_enemy_sec: { min: 1, max: 600 },

  // A dib that expires almost instantly is indistinguishable from no dibs.
  dibs_expiry_seconds: { min: 5, max: 600 },

  // PUSH-surge alerts (#208). A 0-threshold or 0-window would alert on
  // everything and spam every subscribed member's phone.
  surge_enemy_threshold: { min: 1, max: 100 },
  surge_enemy_window_sec: { min: 5, max: 600 },
  surge_our_threshold: { min: 1, max: 100 },
  surge_our_window_sec: { min: 5, max: 600 },
  surge_cooldown_sec: { min: 30, max: 3600 },

  // 0 is a real setting (disables the age filter), so the floor must be 0.
  tornstats_max_age_days: { min: 0, max: 365 },

  // #336 member live stats. Range is NON-CONTIGUOUS: 0 means off, and any
  // enabled cadence is floored at 30s. `min` is 0 so a plain clamp can't
  // rewrite "off" into "fastest"; ZERO_OR_FLOOR below enforces the real floor.
  // Unlike the chain pollers this costs one Torn call per enrolled member per
  // cycle, so the floor is a rate-limit guard rather than a preference.
  member_stats_poll_interval_sec: { min: 0, max: 600 },

  // #339 roster refresh, in MILLISECONDS (the other cadences are seconds, but
  // this one needs sub-second granularity to express 2 Hz). 0 disables the
  // roster poll outright (#345); any enabled value floors at 500ms because
  // each sync spends two Torn calls.
  roster_poll_interval_ms: { min: 0, max: 60_000 },
}

/**
 * Fields where 0 is a distinct "off" setting and every other value has a
 * higher floor. Clamping these against CONFIG_BOUNDS alone would turn an
 * operator's deliberate 0 into the fastest allowed cadence — the exact
 * opposite of the intent, and silently.
 */
const ZERO_OR_FLOOR: Record<string, number> = {
  member_stats_poll_interval_sec: 30,
  roster_poll_interval_ms: 500,
}

export type ClampResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string }

/**
 * Clamp one config field to its bounds.
 *
 * Out-of-range numbers are clamped (the caller asked for something unsafe; store
 * the safe edge). Non-numeric input for a bounded field is REJECTED rather than
 * coerced — silently storing the minimum would hide a real client bug behind a
 * plausible-looking value.
 */
export function clampConfigValue(field: string, value: unknown): ClampResult {
  const bounds = CONFIG_BOUNDS[field]
  if (!bounds) return { ok: true, value }

  // Accept a numeric string: JSON bodies built from form inputs often carry one.
  // Reject booleans explicitly — Number(true) is 1, which would look valid.
  // Reject an empty/whitespace string too: Number('') is 0, so a cleared input
  // would otherwise sail through and be stored as the field's minimum.
  let n = NaN
  if (typeof value === 'number') n = value
  else if (typeof value === 'string' && value.trim() !== '') n = Number(value)
  if (!Number.isFinite(n)) {
    return { ok: false, error: `${field} must be a number` }
  }

  // Floor before clamping so 0.9 cannot round up past a floor of 1.
  const floored = Math.floor(n)

  // Off-or-floored fields. 0 (or anything nonsensical below it) is "off" and
  // survives as 0; a positive request under the floor is raised TO the floor,
  // because the caller clearly wanted polling and the floor is the fastest we
  // will safely do. Collapsing those to 0 instead would silently ignore them.
  const zeroFloor = ZERO_OR_FLOOR[field]
  if (zeroFloor !== undefined) {
    if (floored <= 0) return { ok: true, value: 0 }
    return { ok: true, value: Math.min(bounds.max, Math.max(zeroFloor, floored)) }
  }

  return { ok: true, value: Math.min(bounds.max, Math.max(bounds.min, floored)) }
}
