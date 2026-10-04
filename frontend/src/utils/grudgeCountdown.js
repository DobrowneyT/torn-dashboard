/**
 * Hospital / jail / travel countdowns for the Book of Grudges (#889).
 *
 * ⚠️ **Torn's `status.until` is epoch SECONDS**, not a database timestamp. It
 * never goes near `parseDbTime` — that is for the `+00` strings the API serves
 * (#140), and running a Torn epoch through it lands in 1970.
 *
 * ⚠️ **The countdown is computed on the CLIENT, from a stored `until`.** It
 * needs no request to tick: the server only has to tell us *when* they are out,
 * once. That is the whole reason this page can show a live timer while its
 * server-side refresh runs every fifteen minutes.
 */

/** Seconds remaining, or null when there is no deadline. Never negative. */
export function secondsUntil(until, nowMs = Date.now()) {
  const u = Number(until)
  if (!Number.isFinite(u) || u <= 0) return null
  return Math.max(0, Math.round(u - nowMs / 1000))
}

/**
 * "12m 04s", "1h 02m", "3d 4h".
 *
 * ⚠️ Zero-padded below an hour, because an unpadded countdown jitters in width
 * every second and a column of them is unreadable.
 */
export function formatCountdown(seconds) {
  if (seconds === null || seconds === undefined) return null
  const s = Math.max(0, Math.floor(Number(seconds) || 0))
  if (s === 0) return 'now'
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  return `${m}m ${String(sec).padStart(2, '0')}s`
}

/**
 * Is this target attackable right now?
 *
 * ⚠️ "Okay" is the only yes. Hospital, jail, travelling and federal are all no,
 * and lumping them together as "not okay" would be fine — but a hospital timer
 * that has run out while the page sat open is ALSO a yes, and that is the case
 * worth catching: the server says Hospital, the clock says they are out.
 */
export function isAttackable(target, nowMs = Date.now()) {
  const state = target?.status_state ?? null
  if (state === 'Okay') return true
  if (state === 'Hospital') return secondsUntil(target?.status_until, nowMs) === 0
  return false
}

/**
 * Sort key for "who can I hit soonest".
 *
 * ⚠️ Attackable now sorts FIRST, then everyone else by how long until they are
 * out. Somebody with no deadline — travelling with no return time, or a state
 * we have never read — sorts last rather than first: unknown is not "available
 * now", and treating it as zero would put a question mark at the top of a list
 * people act on in a hurry.
 */
export function availabilityKey(target, nowMs = Date.now()) {
  if (isAttackable(target, nowMs)) return 0
  const s = secondsUntil(target?.status_until, nowMs)
  return s === null ? Number.POSITIVE_INFINITY : s
}
