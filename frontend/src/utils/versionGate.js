/**
 * Keeping clients on the current build (#382).
 *
 * nginx no longer lets `index.html` be cached, which fixes the common case:
 * the next navigation picks up a new deploy. But the War Room is left OPEN,
 * often for the length of a war, and a tab that never navigates never
 * re-fetches the document. During the war behind #371/#376 people were running
 * builds hours old and reporting bugs against code we had already fixed.
 *
 * So the running app also asks. `/api/health` reports the server's VERSION and
 * the bundle carries its own from build time; a mismatch means this tab is
 * stale.
 *
 * ── The reload loop is the real hazard here ──────────────────────────────
 *
 * "Version differs → reload" is one bad deploy away from an infinite refresh
 * loop that locks every user out of the board mid-war, which is far worse than
 * the staleness it set out to fix. It loops whenever the reload CANNOT fix the
 * mismatch, and there are ordinary ways that happens:
 *
 *   - a CDN or proxy still serving the old document
 *   - a rolling deploy where two API containers report different versions, so
 *     the "correct" answer alternates between polls
 *   - a service worker serving the old bundle from its own cache
 *
 * The guard is therefore: reload AT MOST ONCE per observed server version, and
 * record it before reloading. If the reload doesn't take, the second sighting
 * of that same version is a no-op and we fall back to telling the user, which
 * degrades to the annoying-but-usable end state rather than the unusable one.
 */

/** Where the "we already tried this one" marker lives. */
export const RELOAD_MARK_KEY = 'tnl:version-reload'

/** Reasons the gate can decline to act, kept distinct for the tests. */
export const GateAction = {
  NONE: 'none',
  RELOAD: 'reload',
  NOTIFY: 'notify',
}

function normalise(v) {
  if (v == null) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

/**
 * Decide what to do about a version reading.
 *
 * Pure: it reads the mark and returns a decision. The caller performs the
 * reload and writes the mark, so the ordering (write, THEN reload) is visible
 * at the call site rather than buried here.
 *
 * @param running  the version this bundle was built as
 * @param serving  the version the API reports
 * @param mark     the previously recorded attempt, or null
 * @param canReload  false where a reload would lose work (see shouldPrompt)
 */
export function evaluateVersion({ running, serving, mark, canReload = true }) {
  const have = normalise(running)
  const want = normalise(serving)

  // Nothing to compare. A missing version is not a mismatch — an API that
  // failed to report, or a dev bundle with no version baked in, must not
  // trigger anything.
  if (!have || !want) return { action: GateAction.NONE, version: want }
  if (have === want) return { action: GateAction.NONE, version: want }

  // Already tried to reload onto this exact version and we are still here, so
  // reloading is not what fixes it. Tell the user instead of spinning.
  if (mark === want) return { action: GateAction.NOTIFY, version: want, reason: 'reload-did-not-take' }

  if (!canReload) return { action: GateAction.NOTIFY, version: want, reason: 'unsafe-to-reload' }

  return { action: GateAction.RELOAD, version: want }
}

/**
 * Read the reload mark.
 *
 * sessionStorage, deliberately, not localStorage: the mark is about THIS tab's
 * attempt. localStorage would let one tab's failed reload permanently suppress
 * reloads in every other tab, including ones opened long afterwards.
 */
export function readMark(storage) {
  try {
    return normalise(storage?.getItem(RELOAD_MARK_KEY))
  } catch {
    // Private mode, or storage disabled. Treated as "no mark", which allows a
    // single reload; the alternative is never updating at all.
    return null
  }
}

/** Record an attempt. Must happen BEFORE the reload, or the guard is useless. */
export function writeMark(storage, version) {
  try {
    storage?.setItem(RELOAD_MARK_KEY, String(version))
    return true
  } catch {
    // If we cannot record the attempt we cannot guarantee we won't loop, so
    // the caller must not reload. Returning false is what stops it.
    return false
  }
}

/**
 * Clear the mark once running and serving agree.
 *
 * Without this, a tab that legitimately reloaded onto v2 keeps the v2 mark
 * forever — and if the app is later rolled BACK to v2 after a spell on v3, the
 * gate would refuse to reload for it.
 */
export function clearMarkIfCurrent(storage, { running, serving }) {
  const have = normalise(running)
  const want = normalise(serving)
  if (!have || !want || have !== want) return false
  try {
    if (storage?.getItem(RELOAD_MARK_KEY) == null) return false
    storage.removeItem(RELOAD_MARK_KEY)
    return true
  } catch {
    return false
  }
}
