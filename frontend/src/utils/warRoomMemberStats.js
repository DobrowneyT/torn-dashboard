/**
 * Live energy + cooldown display for our own members (#336).
 *
 * The server stores Torn's raw numbers: energy as current/maximum, and each
 * cooldown as SECONDS REMAINING AT FETCH TIME — not an absolute timestamp.
 * That distinction drives this whole module: a stored 3600 means "an hour left
 * as of fetched_at", so by the time it renders it is already stale by however
 * long ago the sweep ran. Everything here ages the stored value against the
 * clock rather than trusting it.
 */

/**
 * Overdose threshold, in seconds of remaining drug cooldown. Mirrors
 * OVERDOSE_DRUG_CD_SEC in server/src/warRoomMemberStats.ts.
 *
 * Torn has no live "is overdosed" flag — `overdoses` exists only as a lifetime
 * personalstats counter. But a xanax leaves 6-8h of drug cooldown, so anything
 * past 10h can only be an overdose.
 */
export const OVERDOSE_DRUG_CD_SEC = 36_000

/**
 * A reading, or null when there isn't one.
 *
 * Number(null) is 0 and Number('') is 0, so a plain Number() cast turns "we
 * have no reading" into "this member has zero" — which for energy means a
 * member whose own key failed renders as empty and gets written off for the
 * push. Everything numeric in this module goes through here.
 */
function reading(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** Index the memberstats delta rows by member id, for O(1) lookup per row. */
export function indexMemberStats(rows = []) {
  const byId = {}
  for (const row of rows ?? []) {
    if (row?.member_id == null) continue
    byId[String(row.member_id)] = row
  }
  return byId
}

/**
 * Seconds still remaining on a cooldown that had `seconds` left at `fetchedAt`.
 *
 * Returns null when we have no reading at all (never fetched, or the member's
 * key failed) so the UI can show "unknown" rather than a confident zero.
 */
export function remainingCooldown(seconds, fetchedAt, nowMs = Date.now()) {
  const base = reading(seconds)
  if (base == null) return null
  const fetched = fetchedAt ? Date.parse(fetchedAt) : NaN
  // No usable fetch time: show the raw reading rather than nothing. Better a
  // slightly stale number than a blank column.
  if (!Number.isFinite(fetched)) return Math.max(0, base)
  const elapsed = Math.floor((nowMs - fetched) / 1000)
  return Math.max(0, base - elapsed)
}

/**
 * Compact cooldown label: "—" when unknown, "0" when ready, else 2h 5m / 45s.
 *
 * Ready renders as `0` rather than the word "Ready" (#351): the column is
 * numeric and scanned vertically, and "Ready" was both the widest value in it
 * and the odd one out. The dash still carries the distinction that matters —
 * no reading is not the same as no cooldown.
 */
export function formatCooldown(secondsRemaining) {
  if (secondsRemaining == null) return '—'
  const s = Math.max(0, Math.floor(Number(secondsRemaining)))
  if (s === 0) return '0'
  if (s < 60) return `${s}s`
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h === 0) return `${m}m`
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

/**
 * Is this member overdosed, judged by their drug cooldown?
 *
 * NOT a duplicate of isOverdosed() in memberNotes.js (#199) — the two see
 * different windows, and both are worth having:
 *
 *   • #199 reads Torn's hospital status details ("Overdosed"). Direct and
 *     certain, but only while the member is still IN hospital for it.
 *   • This one reads the drug cooldown, which long outlives the hospital stay.
 *     It keeps flagging a member who has already been released but is still
 *     sitting on a crippling cooldown — exactly the person you must not count
 *     on for the next chain.
 *
 * Keyed off the STORED reading rather than the aged-down one: an overdose is a
 * fact about the dose that was taken, and shouldn't stop being true merely
 * because the cooldown has since burned below the threshold.
 */
export function overdosedByDrugCooldown(stats) {
  const drug = reading(stats?.cooldown_drug)
  if (drug == null) return false
  return drug > OVERDOSE_DRUG_CD_SEC
}

/** Energy label — "87/150", or "—" when we have no reading. */
export function formatEnergy(stats) {
  const cur = reading(stats?.energy_current)
  if (cur == null) return '—'
  const max = reading(stats?.energy_maximum)
  return max == null ? String(cur) : `${cur}/${max}`
}

// ── Energy colour gradient (#351) ────────────────────────────────────────────
//
// Energy does not stop at the bar. The bar caps at 150 and refills on its own
// (5 every 10 minutes, so ~5 hours from empty), but before a war everyone
// STACKS well past it — 1000 is the target. So `energy_current` routinely
// exceeds `energy_maximum`, and the two regimes are read for different
// questions: pre-war "is everyone stacked?", mid-war "who has anything left?".
//
// The previous banding divided current by maximum, which collapsed exactly the
// distinction that matters: 150/150 and 1000/150 both came out "high". The
// gradient below is PIECEWISE instead, with amber pinned to a full natural bar:
//
//   0 ─────── red→amber ─────── full bar ─────── amber→green ─────── 1000
//
// Both stretches get a full sweep, so mid-war (where nearly everyone sits
// under 150) is not squashed into the bottom 15% of one linear ramp.
//
// The numeric value is always on screen next to the colour, which is what
// carries the reading for anyone who can't separate red from green.

/** Fallback natural bar cap when Torn doesn't report a maximum. */
export const ENERGY_BAR_DEFAULT = 150

/** Pre-war stacked target — the top of the gradient. */
export const ENERGY_STACK_TARGET = 1000

export const HUE_EMPTY = 0      // red
export const HUE_FULL_BAR = 45  // amber
export const HUE_STACKED = 142  // green

/**
 * Hue (0-360) for a member's energy, or null when we have no reading.
 *
 * Null rather than red for an unknown: colouring a member we could not ask as
 * "empty" would get them written off for a push on no evidence.
 */
export function energyHue(stats) {
  const cur = reading(stats?.energy_current)
  if (cur == null) return null
  // Per-member, since donator status changes the cap — the amber line means
  // "this member's bar is full", not "150".
  const reportedMax = reading(stats?.energy_maximum)
  const bar = reportedMax != null && reportedMax > 0 ? reportedMax : ENERGY_BAR_DEFAULT

  if (cur <= 0) return HUE_EMPTY
  // Clamped, not extrapolated: hue is circular, so an unclamped 1500 would run
  // straight past green into cyan.
  if (cur >= ENERGY_STACK_TARGET) return HUE_STACKED
  if (cur <= bar) {
    return Math.round(HUE_EMPTY + (HUE_FULL_BAR - HUE_EMPTY) * (cur / bar))
  }
  // A bar bigger than the stack target would divide by zero or negative here.
  const span = ENERGY_STACK_TARGET - bar
  if (span <= 0) return HUE_STACKED
  return Math.round(HUE_FULL_BAR + (HUE_STACKED - HUE_FULL_BAR) * ((cur - bar) / span))
}

/** The same three regimes in words, for the cell's tooltip. */
export function energyBand(stats) {
  const cur = reading(stats?.energy_current)
  if (cur == null) return null
  const reportedMax = reading(stats?.energy_maximum)
  const bar = reportedMax != null && reportedMax > 0 ? reportedMax : ENERGY_BAR_DEFAULT
  if (cur <= 0) return 'empty'
  if (cur < bar) return 'regenerating'
  if (cur === bar) return 'full bar'
  return 'stacked'
}

// ── Sorting (#351) ───────────────────────────────────────────────────────────

/**
 * The number a stat column sorts on, or null when there is no reading.
 *
 * Cooldowns sort on the AGED remaining value, not the stored one. The sweep
 * walks keys serially, so two members' readings were taken at different
 * moments; ranking the raw stored seconds would produce an order that
 * disagrees with the numbers rendered beside it.
 */
export function memberStatSortValue(field, stats, nowMs = Date.now()) {
  if (field === 'energy') return reading(stats?.energy_current)
  return remainingCooldown(stats?.[field], stats?.fetched_at, nowMs)
}

/**
 * Compare two members on a stat column.
 *
 * Members with no reading sink to the bottom in BOTH directions. Sorting
 * ascending by energy asks "who is empty" — and a member whose key failed is
 * not an answer to that, they are an absence of one. Folding them in as zero
 * would bury the members the sort was meant to surface.
 */
export function compareMemberStat(field, statsA, statsB, dir = 1, nowMs = Date.now()) {
  const a = memberStatSortValue(field, statsA, nowMs)
  const b = memberStatSortValue(field, statsB, nowMs)
  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1
  return dir * (a - b)
}

/**
 * How stale is this reading, in seconds? Null when never fetched.
 *
 * The board polls our members far slower than the enemy roster (30s floor vs
 * 1 Hz), so the UI has to be able to say how old a number is instead of
 * implying it is live.
 */
export function statsAgeSeconds(stats, nowMs = Date.now()) {
  const fetched = stats?.fetched_at ? Date.parse(stats.fetched_at) : NaN
  if (!Number.isFinite(fetched)) return null
  return Math.max(0, Math.floor((nowMs - fetched) / 1000))
}

/** Did this member's own key fail on the last sweep? */
export function hasStatsError(stats) {
  return Boolean(stats?.last_error)
}
