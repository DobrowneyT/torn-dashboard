/**
 * Estimated arrival for travelling members (#330).
 *
 * Torn gives no arrival time for travel — `status.until` is null for a
 * traveller, unlike hospital and jail — so the ETA is derived from three
 * things:
 *
 *   1. WHEN they took off. Not in the API either; the server latches it when
 *      the roster poll observes the transition into Traveling
 *      (`travel_departed_at`, #330). Null when we did not witness it.
 *   2. WHERE they are going, parsed out of the status description.
 *   3. HOW they are flying, from `status.plane_image_type`.
 *
 * The result is always a BAND, never a point. Torn added up to 3% flight-time
 * variance in patch #26 (26/12/17), so even a fully known flight lands inside a
 * window rather than at a time. Presenting an exact arrival would be wrong by
 * up to 40 seconds on a long route, and a lead who queues a hit on it wastes
 * the window — the whole reason for the estimate.
 */

/** Torn's published flight-time variance: up to ±3%. */
export const TRAVEL_VARIANCE = 0.03

/**
 * Flight times in seconds, by destination and method.
 *
 * From the in-game flight table, "Without Book" tab. The travel book (*Mailing
 * Yourself Abroad*, −25% for 31 days) is deliberately NOT modelled: we are
 * after estimates, and folding it in would double the candidate set while
 * making the variance bands overlap, which is what elimination depends on not
 * happening. A member with the book simply lands early and reads as `landing`.
 */
export const FLIGHT_SECONDS = {
  'mexico':          { standard: 1440, airstrip: 1020, wlt:  720, business:  420 },
  'cayman islands':  { standard: 1980, airstrip: 1380, wlt: 1020, business:  600 },
  'canada':          { standard: 2340, airstrip: 1620, wlt: 1140, business:  720 },
  'hawaii':          { standard: 7620, airstrip: 5340, wlt: 3780, business: 2280 },
  'united kingdom':  { standard: 9060, airstrip: 6360, wlt: 4500, business: 2700 },
  'argentina':       { standard: 9480, airstrip: 6660, wlt: 4740, business: 2820 },
  'switzerland':     { standard: 9960, airstrip: 6960, wlt: 4980, business: 3000 },
  'japan':           { standard: 12780, airstrip: 8940, wlt: 6420, business: 3840 },
  'china':           { standard: 13740, airstrip: 9600, wlt: 6840, business: 4140 },
  'uae':             { standard: 15420, airstrip: 10800, wlt: 7680, business: 4620 },
  'south africa':    { standard: 16920, airstrip: 11820, wlt: 8460, business: 5100 },
}

/** Fastest to slowest — elimination and band-building both rely on this order. */
const METHODS = ['business', 'wlt', 'airstrip', 'standard']

/**
 * `status.plane_image_type` → travel method.
 *
 * Only two are confirmed, both from observed live members: someone flying a
 * Business Class Ticket reported `airliner`, someone on their private-island
 * airstrip reported `light_aircraft`. Note the BCT flyer also owns an airstrip,
 * so the value reflects the method actually IN USE, not the property owned.
 *
 * Standard and WLT are still unmapped, and a flight perk may add its own type.
 * Unknown values deliberately fall through to every method (see
 * methodsForPlaneType) rather than defaulting to one — a wrong method gives a
 * confidently wrong landing time, which is the failure this all exists to
 * avoid. Elimination narrows them soon enough anyway.
 */
export const PLANE_TYPE_METHOD = {
  airliner: 'business',
  light_aircraft: 'airstrip',
}

/** Destination names Torn uses in more than one form. */
const DESTINATION_ALIASES = {
  'united arab emirates': 'uae',
  'uk': 'united kingdom',
  'great britain': 'united kingdom',
  'cayman': 'cayman islands',
  'south africa': 'south africa',
}

function normalise(name) {
  return String(name ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * The country whose flight time applies, or null.
 *
 * A return leg takes the same time as the outbound, so the answer is whichever
 * end of the route is not Torn.
 */
export function travelDestination(description) {
  const d = String(description ?? '')
  let candidate = null

  const between = d.match(/^Traveling from (.+) to (.+)$/i)
  if (between) {
    const [, from, to] = between
    candidate = normalise(to) === 'torn' ? from : to
  } else {
    const to = d.match(/^Traveling to (.+)$/i)
    const back = d.match(/^Returning (?:to Torn )?from (.+)$/i)
    candidate = to?.[1] ?? back?.[1] ?? null
  }
  if (candidate == null) return null

  const key = normalise(candidate)
  const resolved = DESTINATION_ALIASES[key] ?? key
  // Unknown destination → null, so the caller shows nothing rather than an
  // estimate built on a duration we invented.
  return FLIGHT_SECONDS[resolved] ? resolved : null
}

/** Candidate methods for an aircraft type — all four when we can't tell. */
export function methodsForPlaneType(planeType) {
  const known = PLANE_TYPE_METHOD[planeType]
  return known ? [known] : [...METHODS]
}

/**
 * Estimated arrival for a traveller.
 *
 * Returns one of:
 *   { state: 'unknown' }                              — no departure or no route
 *   { state: 'overdue' }                              — every candidate expired
 *   { state: 'estimate', earliestSec, latestSec, methods }
 *
 * `earliestSec`/`latestSec` are seconds from now, clamped at zero.
 */
export function travelEta({ description, planeType, departedAt, nowMs = Date.now() } = {}) {
  const destination = travelDestination(description)
  const departed = departedAt ? Date.parse(departedAt) : NaN
  if (!destination || !Number.isFinite(departed)) return { state: 'unknown' }

  const times = FLIGHT_SECONDS[destination]
  const elapsed = (nowMs - departed) / 1000
  if (elapsed < 0) return { state: 'unknown' }

  // Eliminate a method only once its UPPER bound has passed. Cutting at the
  // nominal figure would rule out a flight that is legitimately still in the
  // air on the slow side of the variance.
  const surviving = methodsForPlaneType(planeType)
    .filter((m) => times[m] * (1 + TRAVEL_VARIANCE) >= elapsed)

  // Reachable in ordinary play: the Watchlist job special lets a Detective
  // Agency extend someone's flight, and the travel book shortens it. Either
  // way, refusing to show a landing time in the past beats inventing one.
  if (surviving.length === 0) return { state: 'overdue' }

  const durations = surviving.map((m) => times[m])
  const earliest = Math.min(...durations) * (1 - TRAVEL_VARIANCE)
  const latest = Math.max(...durations) * (1 + TRAVEL_VARIANCE)

  return {
    state: 'estimate',
    // Ordered fastest-first for a stable, readable methods list.
    methods: METHODS.filter((m) => surviving.includes(m)),
    earliestSec: Math.max(0, Math.round(earliest) - Math.round(elapsed)),
    latestSec: Math.max(0, Math.round(latest) - Math.round(elapsed)),
  }
}

function compact(seconds) {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}s`
  const h = Math.floor(s / 3600)
  const m = Math.round((s % 3600) / 60)
  if (h === 0) return `${m}m`
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

/**
 * The Timer-cell label for an ETA.
 *
 * Always prefixed `~`, and never rendered like the exact hospital countdown it
 * sits beside — this number is inferred, and the column must not imply
 * otherwise.
 */
export function formatTravelEta(eta) {
  if (!eta || eta.state === 'unknown') return '—'
  if (eta.state === 'overdue') return 'landing'
  const { earliestSec, latestSec } = eta
  // Collapse a tight band to one figure: on a single known method the window is
  // ±3%, and two numbers that round to nearly the same thing are just noise.
  const spread = latestSec - earliestSec
  if (spread <= 60 || spread <= earliestSec * 0.12) return `~${compact((earliestSec + latestSec) / 2)}`
  return `~${compact(earliestSec)}–${compact(latestSec)}`
}
