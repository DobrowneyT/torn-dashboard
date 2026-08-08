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
  if (seconds == null || !Number.isFinite(Number(seconds))) return null
  const base = Number(seconds)
  const fetched = fetchedAt ? Date.parse(fetchedAt) : NaN
  // No usable fetch time: show the raw reading rather than nothing. Better a
  // slightly stale number than a blank column.
  if (!Number.isFinite(fetched)) return Math.max(0, base)
  const elapsed = Math.floor((nowMs - fetched) / 1000)
  return Math.max(0, base - elapsed)
}

/** Compact cooldown label: "—" when unknown, "Ready" at zero, else 2h 5m / 45s. */
export function formatCooldown(secondsRemaining) {
  if (secondsRemaining == null) return '—'
  const s = Math.max(0, Math.floor(Number(secondsRemaining)))
  if (s === 0) return 'Ready'
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
  const drug = Number(stats?.cooldown_drug)
  if (!Number.isFinite(drug)) return false
  return drug > OVERDOSE_DRUG_CD_SEC
}

/** Energy label — "87/150", or "—" when we have no reading. */
export function formatEnergy(stats) {
  const cur = Number(stats?.energy_current)
  if (!Number.isFinite(cur)) return '—'
  const max = Number(stats?.energy_maximum)
  return Number.isFinite(max) ? `${cur}/${max}` : String(cur)
}

/**
 * Colour band for the energy cell: full-ish energy is the thing a war lead is
 * scanning for, so it gets the strongest treatment.
 */
export function energyTone(stats) {
  const cur = Number(stats?.energy_current)
  const max = Number(stats?.energy_maximum)
  if (!Number.isFinite(cur) || !Number.isFinite(max) || max <= 0) return 'unknown'
  const pct = cur / max
  if (pct >= 0.75) return 'high'
  if (pct >= 0.25) return 'mid'
  return 'low'
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
