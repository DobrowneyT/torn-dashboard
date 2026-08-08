import { describe, it, expect, beforeEach } from 'vitest'
import {
  hospitalExitDue, chainSecondsLeft, chainDropDue,
  ALERT_PREF_DEFAULTS, loadAlertPrefs, saveAlertPrefs, surgeAlertKind,
} from '../warRoomAlerts.js'

describe('hospitalExitDue', () => {
  const target = (state, until) => ({ status_state: state, status_until: until })

  it('fires inside the lead window before a hospital target comes out', () => {
    // until = 1000, lead = 60 → window [940, 1000)
    expect(hospitalExitDue(target('Hospital', 1000), 950, 60)).toBe(true)
    expect(hospitalExitDue(target('Hospital', 1000), 940, 60)).toBe(true)
  })

  it('does not fire before the window opens or after the target is out', () => {
    expect(hospitalExitDue(target('Hospital', 1000), 939, 60)).toBe(false) // too early
    expect(hospitalExitDue(target('Hospital', 1000), 1000, 60)).toBe(false) // already out (boundary)
    expect(hospitalExitDue(target('Hospital', 1000), 1200, 60)).toBe(false) // long out
  })

  it('only applies to hospital targets with a real until', () => {
    expect(hospitalExitDue(target('Okay', null), 950, 60)).toBe(false)
    expect(hospitalExitDue(target('Hospital', null), 950, 60)).toBe(false)
    expect(hospitalExitDue(target('Hospital', 0), 950, 60)).toBe(false)
    expect(hospitalExitDue(null, 950, 60)).toBe(false)
  })
})

describe('chainSecondsLeft', () => {
  it('returns the remaining seconds for a live, built chain', () => {
    expect(chainSecondsLeft({ current: 25, timeout: 1100 }, 1000)).toBe(100)
  })

  it('is null when idle, unbuilt, expired, or on cooldown', () => {
    expect(chainSecondsLeft(null, 1000)).toBeNull()
    expect(chainSecondsLeft({ current: 0, timeout: 1100 }, 1000)).toBeNull()       // no chain built
    expect(chainSecondsLeft({ current: 25, timeout: 900 }, 1000)).toBeNull()        // timer already passed
    expect(chainSecondsLeft({ current: 25, timeout: 1100, cooldown: 2000 }, 1000)).toBeNull() // cooling down
  })
})

describe('chainDropDue', () => {
  it('fires only when a live chain is at/under the threshold', () => {
    expect(chainDropDue({ current: 25, timeout: 1050 }, 1000, 60)).toBe(true)  // 50s left
    expect(chainDropDue({ current: 25, timeout: 1060 }, 1000, 60)).toBe(true)  // exactly 60s
    expect(chainDropDue({ current: 25, timeout: 1120 }, 1000, 60)).toBe(false) // 120s left
  })

  it('never fires without a live savable chain', () => {
    expect(chainDropDue({ current: 0, timeout: 1050 }, 1000, 60)).toBe(false)
    expect(chainDropDue({ current: 25, timeout: 1050, cooldown: 2000 }, 1000, 60)).toBe(false)
  })
})

// These tests run in node, not jsdom — the frontend suite is util-level by
// design — so localStorage has to be stood up by hand.
function stubLocalStorage() {
  const store = new Map()
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  }
  return store
}

describe('surge alert preferences (#361)', () => {
  beforeEach(() => { stubLocalStorage() })

  it('defaults the surge channel ON, unlike dibs and chain', () => {
    // A war-wide warning fired by the server, not a personal reminder someone
    // asked for — so opt-OUT. The other two stay opt-in.
    expect(ALERT_PREF_DEFAULTS.surge.enabled).toBe(true)
    expect(ALERT_PREF_DEFAULTS.dibs.enabled).toBe(false)
    expect(ALERT_PREF_DEFAULTS.chain.enabled).toBe(false)
  })

  it('gives the surge channel the same sound and flash switches as the others', () => {
    // The bug: fireAlert('surge', {sound:true, flash:true}) was hardcoded, so
    // the checkboxes in the popover visibly did not apply to it.
    expect(ALERT_PREF_DEFAULTS.surge).toMatchObject({ sound: true, flash: true })
  })

  it('has no threshold — the window is leadership-owned and server-side', () => {
    expect(ALERT_PREF_DEFAULTS.surge).not.toHaveProperty('leadSec')
    expect(ALERT_PREF_DEFAULTS.surge).not.toHaveProperty('thresholdSec')
  })

  it('loads a surge channel even for a browser that predates it', () => {
    // Prefs saved before #361 have no surge key at all; merging over the
    // defaults must not leave it undefined and crash the alert handler.
    localStorage.setItem('warRoomAlertPrefs', JSON.stringify({ dibs: { enabled: true } }))
    const prefs = loadAlertPrefs()
    expect(prefs.surge).toMatchObject({ enabled: true, sound: true, flash: true })
    expect(prefs.dibs.enabled).toBe(true)
  })

  it('round-trips a member silencing surges', () => {
    saveAlertPrefs({ ...loadAlertPrefs(), surge: { enabled: false, sound: false, flash: false } })
    expect(loadAlertPrefs().surge.enabled).toBe(false)
  })
})

describe('surgeAlertKind', () => {
  it('routes the two surge kinds to different tone and flash channels', () => {
    // Told apart by ear and by peripheral colour, the same way dibs and chain
    // already are.
    expect(surgeAlertKind('revive')).toBe('surge-revive')
    expect(surgeAlertKind('status')).toBe('surge')
  })

  it('falls back to the status channel when a payload carries no kind', () => {
    // An alert from a server predating #359 has no `surge` field.
    expect(surgeAlertKind(undefined)).toBe('surge')
    expect(surgeAlertKind(null)).toBe('surge')
  })
})
