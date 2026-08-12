// Push-countdown headline helpers. A leader picks a target time; we store the
// headline as `PUSH@<epochSeconds>` so every War Room tab can render a live
// countdown ("PUSH IN 4:37" → "PUSH NOW") from the same absolute instant,
// independent of each viewer's timezone. Pure + unit-tested; the banner and
// composer wire the live clock to them.

export const PUSH_TARGET_RE = /^PUSH@(\d+)$/

/** Epoch seconds encoded in a push-countdown headline, or null if it isn't one. */
export function parsePushTarget(text) {
  if (typeof text !== 'string') return null
  const m = PUSH_TARGET_RE.exec(text.trim())
  return m ? Number(m[1]) : null
}

/**
 * The next occurrence of a "HH:MM" wall-clock time (in the picker's local zone)
 * as epoch seconds. If that time has already passed today, it rolls to tomorrow.
 */
export function pushTargetEpoch(hhmm, now = new Date()) {
  const [h, m] = String(hhmm).split(':').map(Number)
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) return null
  // db-time-safe: copies the caller-supplied Date.
  const t = new Date(now)
  t.setHours(h, m, 0, 0)
  if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1)
  return Math.floor(t.getTime() / 1000)
}

/** The headline text a leader posts for a scheduled push, or null on bad input. */
export function pushHeadlineText(hhmm, now = new Date()) {
  const epoch = pushTargetEpoch(hhmm, now)
  return epoch == null ? null : `PUSH@${epoch}`
}

/** Render the countdown: "PUSH IN 4:37" / "PUSH IN 1:04:37" / "PUSH NOW". */
export function formatPushCountdown(secondsLeft) {
  if (!(secondsLeft > 0)) return 'PUSH NOW'
  const s = Math.floor(secondsLeft)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const two = (n) => String(n).padStart(2, '0')
  const clock = h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`
  return `PUSH IN ${clock}`
}
