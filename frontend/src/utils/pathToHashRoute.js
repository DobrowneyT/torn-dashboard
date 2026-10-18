// Path-style links → hash routes (#969).
//
// ⚠️ **The Discord bot's Chain Watch sign-up link never reached Chain Watch.**
// It links to `https://<faction>.monchoon.me/members/chain-watch` — a PATH —
// but the app uses a HASH router. nginx happily serves index.html for that
// path, the router reads only what follows `#` (nothing), and the member lands
// on the dashboard home instead of the sign-up sheet they were sent to.
//
// Translating here, before the router starts, fixes that link and every other
// path-style link — and lets the bot's existing link follow Chain Watch to its
// new home on the events page without a bot change.

/**
 * The URL to replace the current one with, or null to leave it alone.
 *
 * ⚠️ A hash that is already present WINS. Somebody sharing `/#/rw/war-room`
 * from a page that happens to have a path must land where the hash says.
 */
export function hashTargetFor({ origin, pathname, search, hash }) {
  const path = pathname || '/'
  if (path === '/' || path === '/index.html') return null
  if (hash && hash !== '#' && hash !== '#/') return null
  // A request for a real file is not a route.
  if (/\.[a-z0-9]{2,5}$/i.test(path)) return null
  const trimmed = path.replace(/\/+$/, '') || '/'
  return `${origin}/#${trimmed}${search || ''}`
}

/** Apply it to the live page. Safe to call more than once. */
export function translatePathToHash(win = window) {
  const target = hashTargetFor(win.location)
  // ⚠️ replaceState, not location.assign: no reload, no extra history entry,
  // so Back does not bounce the member through the path URL again.
  if (target) win.history.replaceState(null, '', target)
}
