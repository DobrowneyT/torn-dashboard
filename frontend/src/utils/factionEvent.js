// Pure helpers for the faction event page (#969).

/**
 * Where `/` should take a member.
 *
 * ⚠️ `/` is a REDIRECT now, never a page. While an event is live it lands on
 * the event; otherwise on the dashboard, which lives at `/dashboard`. Keeping
 * the dashboard at `/` would make it unreachable for the whole event — its own
 * nav tab would bounce straight to the event page.
 */
export function landingPathFor(event) {
  return event?.phase === 'live' ? '/events' : '/dashboard'
}

/** Is there an event worth showing in the nav at all? */
export function eventIsVisible(event) {
  return event?.phase === 'live' || event?.phase === 'upcoming'
}

// ⚠️ TCT is UTC. A `datetime-local` input carries NO timezone, and the browser
// would otherwise read it as the viewer's local time — putting the event start
// hours off for every member outside UTC.

/** `2026-10-25T10:00` (as TCT) → epoch ms. Null for an empty or bad value. */
export function tctInputToMs(value) {
  // ⚠️ Strict shape check first: V8's lenient Date.parse turns junk like
  // `not a date:00Z` into a real timestamp.
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value ?? '')
  if (!m) return null
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])
  return Number.isFinite(ms) ? ms : null
}

/** epoch ms → `2026-10-25T10:00`, as TCT, for a `datetime-local` input. */
export function msToTctInput(ms) {
  if (ms == null || !Number.isFinite(ms)) return ''
  return new Date(ms).toISOString().slice(0, 16) // db-time-safe: epoch ms
}

/** A human TCT label: `25 Oct 10:00 TCT`. */
export function formatTct(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—'
  const d = new Date(ms) // db-time-safe: epoch ms
  const mon = d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${d.getUTCDate()} ${mon} ${hh}:${mm} TCT`
}

/**
 * Pre-filled values for a new Halloween event.
 *
 * ⚠️ DERIVED from the year, not hardcoded to 2026, so the form is right next
 * October too. These are only suggestions — every field stays editable. The
 * shape follows the decisions on #967: opens 25 Oct 10:00 TCT, daily figures
 * from the next midnight, running at least to 1 Nov 16:00 TCT and then until
 * the chain ends.
 */
export function halloweenDefaults(now = Date.now()) {
  const d = new Date(now) // db-time-safe: epoch ms
  // After this year's event has passed, suggest next year's.
  let year = d.getUTCFullYear()
  if (now > Date.UTC(year, 10, 1, 16)) year += 1
  return {
    name: 'Halloween',
    theme_color: '#f97316',
    starts_at: Date.UTC(year, 9, 25, 10),
    daily_from: Date.UTC(year, 9, 26, 0),
    min_ends_at: Date.UTC(year, 10, 1, 16),
    ends_with_chain: true,
    site_accent: true,
    wanted_min_attacks: 3,
  }
}
