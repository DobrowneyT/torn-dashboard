// War Room personal alerts (#156 dibs hospital-exit reminder, #157 chain-watch).
// Pure decision helpers + the sound/screen-flash primitives they drive. Prefs
// are per-user and client-only (localStorage) — this is an alerting layer over
// data the war room already polls, not a server feature.

// Off by default until a member opts in. Lead/threshold in seconds.
//
// The surge channel (#361) is the exception: it defaults ON, because it is a
// war-wide warning fired by the server rather than a personal reminder anyone
// asked for. Opt-out, not opt-in. It exists at all because the surge alert
// previously hardcoded sound and flash and consulted no preference whatsoever
// — so a member who wanted quiet had no control that could deliver it.
//
// Leadership's `surge_alerts_enabled` is still the master switch: with it off
// the server emits nothing and this preference never comes into play. This
// only governs how a member is notified about surges that DID fire.
export const ALERT_PREF_DEFAULTS = {
  dibs:  { enabled: false, leadSec: 60,      sound: true, flash: true },
  chain: { enabled: false, thresholdSec: 60, sound: true, flash: true },
  surge: { enabled: true,                    sound: true, flash: true },
}

const PREFS_KEY = 'warRoomAlertPrefs'

export function loadAlertPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')
    return {
      dibs:  { ...ALERT_PREF_DEFAULTS.dibs,  ...(raw.dibs  || {}) },
      chain: { ...ALERT_PREF_DEFAULTS.chain, ...(raw.chain || {}) },
      surge: { ...ALERT_PREF_DEFAULTS.surge, ...(raw.surge || {}) },
    }
  } catch {
    return {
      dibs: { ...ALERT_PREF_DEFAULTS.dibs },
      chain: { ...ALERT_PREF_DEFAULTS.chain },
      surge: { ...ALERT_PREF_DEFAULTS.surge },
    }
  }
}

export function saveAlertPrefs(prefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)) } catch { /* ignore quota */ }
}

// ── Pure decisions ─────────────────────────────────────────────────────────

/**
 * Is a dib'd target within the lead window before leaving hospital?
 * Fires in [until - leadSec, until): still in hospital, not yet out.
 */
export function hospitalExitDue(target, nowSec, leadSec) {
  if (!target || target.status_state !== 'Hospital') return false
  const until = Number(target.status_until)
  if (!Number.isFinite(until) || until <= 0) return false
  return nowSec >= until - leadSec && nowSec < until
}

/**
 * Seconds until the chain drops, or null when there is no live chain to save
 * (idle, on cooldown, or no timer). Mirrors the ChainTimerCard state machine.
 */
export function chainSecondsLeft(chain, nowSec) {
  if (!chain) return null
  if (chain.cooldown && Number(chain.cooldown) > nowSec) return null   // cooling down
  const timeout = Number(chain.timeout)
  if (!Number.isFinite(timeout) || timeout <= nowSec) return null      // no active timer
  if ((Number(chain.current) || 0) <= 0) return null                   // no chain built
  return timeout - nowSec
}

/** Is the chain within `thresholdSec` of dropping (and still savable)? */
export function chainDropDue(chain, nowSec, thresholdSec) {
  const left = chainSecondsLeft(chain, nowSec)
  return left != null && left > 0 && left <= thresholdSec
}

// ── Side effects (sound + screen flash) ────────────────────────────────────

let audioCtx = null
function ctx() {
  if (typeof window === 'undefined') return null
  const AC = window.AudioContext || window.webkitAudioContext
  if (!AC) return null
  if (!audioCtx) audioCtx = new AC()
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {})
  return audioCtx
}

// Distinct tones so the two alerts are told apart by ear (#156 vs #157):
// dibs = a single mid beep pair; chain = an urgent higher triple.
const TONES = {
  dibs:  { freq: 660, beeps: 2, gap: 0.18, dur: 0.14 },
  chain: { freq: 990, beeps: 3, gap: 0.14, dur: 0.12 },
  // Surge (#208): an urgent low-high klaxon so it's unmistakable.
  surge: { freq: 520, beeps: 4, gap: 0.10, dur: 0.16 },
  // Revive surge (#359): the push is being SET UP, not landing. Fewer, softer
  // beeps so the two are told apart by ear without a glance at the screen —
  // the same reason dibs and chain differ.
  'surge-revive': { freq: 440, beeps: 2, gap: 0.16, dur: 0.20 },
}

export function playAlertSound(kind) {
  const ac = ctx()
  if (!ac) return
  const tone = TONES[kind] || TONES.dibs
  for (let i = 0; i < tone.beeps; i++) {
    const osc = ac.createOscillator()
    const gain = ac.createGain()
    osc.type = 'square'
    osc.frequency.value = tone.freq
    const start = ac.currentTime + i * (tone.dur + tone.gap)
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.exponentialRampToValueAtTime(0.25, start + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + tone.dur)
    osc.connect(gain).connect(ac.destination)
    osc.start(start)
    osc.stop(start + tone.dur + 0.02)
  }
}

// Flash colours match each alert's banner, so the peripheral cue and the thing
// it is pointing at agree.
const FLASH_COLORS = {
  dibs: 'rgba(59,130,246,0.45)',
  chain: 'rgba(239,68,68,0.5)',
  // Red — they are already out of hospital and swinging (#208). Matches the
  // red surge banner; this was amber before #361, disagreeing with its banner.
  surge: 'rgba(239,68,68,0.5)',
  // Amber — a push being set up (#359). Matches the amber revive banner.
  'surge-revive': 'rgba(245,158,11,0.5)',
}

/** The alert channel a surge event belongs to, for tone and flash lookup. */
export function surgeAlertKind(surgeKind) {
  return surgeKind === 'revive' ? 'surge-revive' : 'surge'
}

export function flashScreen(kind) {
  if (typeof document === 'undefined') return
  const el = document.createElement('div')
  el.style.cssText =
    `position:fixed;inset:0;z-index:9999;pointer-events:none;background:${FLASH_COLORS[kind] || FLASH_COLORS.dibs};` +
    'opacity:0;transition:opacity 120ms ease-in-out'
  document.body.appendChild(el)
  requestAnimationFrame(() => { el.style.opacity = '1' })
  let flips = 0
  const id = setInterval(() => {
    flips++
    el.style.opacity = flips % 2 === 0 ? '1' : '0'
    if (flips >= 5) { clearInterval(id); el.remove() }
  }, 140)
}

/** Fire the enabled channels for one alert. `settings` is a prefs sub-object. */
export function fireAlert(kind, settings) {
  if (settings?.sound) playAlertSound(kind)
  if (settings?.flash) flashScreen(kind)
}
