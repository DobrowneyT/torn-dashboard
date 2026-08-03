// PWA install helpers (#206). The environment detection and the "what should
// the install UI show" decision live here as pure functions so they can be
// unit-tested without a DOM; the React hook (usePwaInstall) wires the live
// browser events to them.

const DISMISS_KEY = 'pwa-install-dismissed'

// Is the app already running as an installed PWA? Covers the standard
// display-mode media query and iOS Safari's non-standard navigator.standalone.
export function isStandalone(win = typeof window !== 'undefined' ? window : undefined) {
  if (!win) return false
  const mm = win.matchMedia && win.matchMedia('(display-mode: standalone)')
  return !!(mm && mm.matches) || win.navigator?.standalone === true
}

// iOS (incl. iPadOS, which since iPadOS 13 reports a Mac UA but is touch-based).
// iOS has no beforeinstallprompt, so we detect it to show Add-to-Home-Screen
// instructions instead.
export function isIos(nav = typeof navigator !== 'undefined' ? navigator : undefined) {
  if (!nav) return false
  const ua = nav.userAgent || ''
  if (/iphone|ipad|ipod/i.test(ua)) return true
  // iPadOS masquerading as macOS: Mac UA + a touch screen.
  return /Macintosh/.test(ua) && (nav.maxTouchPoints || 0) > 1
}

// Decide what install affordance to render. Pure so the branching is testable:
//   'none'   — already installed, or a desktop/Android browser with no pending
//              prompt (nothing useful to offer).
//   'button' — a captured beforeinstallprompt is ready; show an Install button.
//   'ios'    — iOS Safari; show manual Add-to-Home-Screen instructions.
export function installAffordance({ standalone, ios, hasPrompt, dismissed }) {
  if (standalone) return 'none'
  if (dismissed) return 'none'
  if (hasPrompt) return 'button'
  if (ios) return 'ios'
  return 'none'
}

export function isInstallDismissed(storage = safeStorage()) {
  try {
    return storage?.getItem(DISMISS_KEY) === '1'
  } catch {
    return false
  }
}

export function markInstallDismissed(storage = safeStorage()) {
  try {
    storage?.setItem(DISMISS_KEY, '1')
  } catch {
    // ignore — private mode / storage disabled
  }
}

function safeStorage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : undefined
  } catch {
    return undefined
  }
}
