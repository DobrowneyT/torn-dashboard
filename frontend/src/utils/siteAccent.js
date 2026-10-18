// Site-wide event accent (MonChoon, 2026-10-17: "if there's an event and we
// specify some colour it changes for the entire site").
//
// ⚠️ How: Tailwind's `blue` palette — the site's accent, ~1,000 class uses in 69
// files — is defined as CSS variables (tailwind.config.js), defaulting to
// Tailwind's own blues in index.css. While a live event allows it, this writes
// a full 50…950 scale derived from the event colour onto <html>; when it ends,
// the variables are removed and every blue is blue again. No class anywhere
// had to change.
//
// ⚠️ Accent only. The light/dark choice stays each viewer's own; forcing dark
// mode for an event is a separate decision MonChoon deferred.

export const ACCENT_STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]

// How far each step is mixed toward white (negative: toward black). The event
// colour itself is 500, so a saturated mid-tone stays recognisable on buttons
// (600) and links, with readable tints and shades around it.
const MIX = { 50: 0.9, 100: 0.8, 200: 0.65, 300: 0.45, 400: 0.22, 500: 0, 600: -0.15, 700: -0.3, 800: -0.45, 900: -0.58, 950: -0.72 }

const HEX = /^#([0-9a-f]{6})$/i

/** '#f97316' → { 50: '254 241 232', … } as Tailwind's "r g b" triples. Null for a bad colour. */
export function accentScale(hex) {
  const m = HEX.exec(hex ?? '')
  if (!m) return null
  const n = parseInt(m[1], 16)
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  const out = {}
  for (const step of ACCENT_STEPS) {
    const t = MIX[step]
    const target = t >= 0 ? 255 : 0
    const k = Math.abs(t)
    out[step] = rgb.map((c) => Math.round(c + (target - c) * k)).join(' ')
  }
  return out
}

/** Should this event colour the whole site right now? */
export function siteAccentFor(event) {
  if (!event || event.phase !== 'live' || event.site_accent === false) return null
  return accentScale(event.theme_color)
}

/** Apply (or clear) the accent on the document root. */
export function applySiteAccent(event, root = document.documentElement) {
  const scale = siteAccentFor(event)
  for (const step of ACCENT_STEPS) {
    if (scale) root.style.setProperty(`--accent-${step}`, scale[step])
    else root.style.removeProperty(`--accent-${step}`)
  }
  if (scale) root.dataset.eventAccent = event.theme_color
  else delete root.dataset.eventAccent
}
