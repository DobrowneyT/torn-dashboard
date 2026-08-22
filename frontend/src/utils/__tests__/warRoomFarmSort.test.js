import { describe, it, expect } from 'vitest'
import { farmCompare, isGreenTarget, isAbroadTarget, splitFarmAbroad } from '../warRoomFarmSort'

// Normalized farm target (each war-room view adapts its own row shape onto
// this before comparing):
//   { id, isGreen, okay, until, bsp, okayAt }
// isGreen mirrors the green attack button (target Online AND Okay); okay is
// "out of hospital/jail"; until is the timer release (unix secs); bsp is the
// battle-stats total (null when un-spied); okayAt is ms-since-epoch first
// observed leaving hospital this session (-1 if never).
function t(over = {}) {
  return { id: 1, isGreen: false, okay: false, until: null, bsp: null, okayAt: -1, ...over }
}
const sorted = (list) => list.slice().sort(farmCompare).map((m) => m.id)

describe('farmCompare — farm-mode two-tier sort (#108)', () => {
  it('puts every green (online+okay) target above every red one', () => {
    const green1 = t({ id: 'g1', isGreen: true, okay: true, bsp: 1_000_000 })
    const green2 = t({ id: 'g2', isGreen: true, okay: true, bsp: 5_000_000 })
    // Red targets of every flavour — freshly released, timered, unknown.
    const redOkay = t({ id: 'r-okay', okay: true, okayAt: 999, bsp: 9_000_000 })
    const redTimer = t({ id: 'r-timer', until: 1000, bsp: 9_000_000 })
    const redOther = t({ id: 'r-other', bsp: 9_000_000 })

    const order = sorted([redOkay, green1, redTimer, redOther, green2])
    // Both greens first (in some order), then all reds — regardless of the
    // reds' higher battle stats or fresh-release/timer status.
    expect(order.slice(0, 2).sort()).toEqual(['g1', 'g2'])
    expect(order.slice(2)).toEqual(expect.arrayContaining(['r-okay', 'r-timer', 'r-other']))
    expect(new Set(order.slice(2))).toEqual(new Set(['r-okay', 'r-timer', 'r-other']))
  })

  it('orders the green tier by battle stats, with un-spied targets at the tier bottom', () => {
    const big = t({ id: 'big', isGreen: true, okay: true, bsp: 8_000_000 })
    const mid = t({ id: 'mid', isGreen: true, okay: true, bsp: 3_000_000 })
    const unknown = t({ id: 'unknown', isGreen: true, okay: true, bsp: null })
    expect(sorted([mid, unknown, big])).toEqual(['big', 'mid', 'unknown'])
  })

  it('keeps the red tier ordering: freshly-released first, then soonest-out timers, then the rest', () => {
    // Okay-not-online sub-tier: higher okayAt (more recently released) first.
    const freshNew = t({ id: 'fresh-new', okay: true, okayAt: 5000 })
    const freshOld = t({ id: 'fresh-old', okay: true, okayAt: 1000 })
    const standing = t({ id: 'standing', okay: true, okayAt: -1, bsp: 2_000_000 })
    // Timer sub-tier: soonest release first.
    const soon = t({ id: 'soon', until: 100 })
    const later = t({ id: 'later', until: 900 })
    // Bottom sub-tier: flying/abroad/fallen (no okay, no timer).
    const other = t({ id: 'other', bsp: 9_000_000 })

    expect(sorted([later, standing, other, soon, freshOld, freshNew])).toEqual([
      'fresh-new', 'fresh-old', 'standing', // sub 0
      'soon', 'later',                      // sub 1
      'other',                              // sub 2
    ])
  })
})

describe('isGreenTarget (#366)', () => {
  const green = { last_action_status: 'Online', status_state: 'Okay' }

  it('is the green attack button: online AND out of hospital', () => {
    expect(isGreenTarget(green)).toBe(true)
  })

  it('is false for anyone who cannot be hit right now', () => {
    expect(isGreenTarget({ last_action_status: 'Online', status_state: 'Hospital' })).toBe(false)
    expect(isGreenTarget({ last_action_status: 'Offline', status_state: 'Okay' })).toBe(false)
    expect(isGreenTarget({ last_action_status: 'Idle', status_state: 'Okay' })).toBe(false)
    expect(isGreenTarget({ last_action_status: 'Online', status_state: 'Traveling' })).toBe(false)
  })

  it('tolerates a missing row', () => {
    expect(isGreenTarget(null)).toBe(false)
    expect(isGreenTarget({})).toBe(false)
  })

  it('⚠️ reads the mobile row shape as well as the desktop one (#479)', () => {
    // Same member, two field namings. A predicate that only understood one
    // would silently answer "not green" on the other surface, which is the
    // quiet version of the exact bug it exists to prevent.
    expect(isGreenTarget({ activity: 'Online', state: 'Okay' })).toBe(true)
    expect(isGreenTarget({ activity: 'Online', state: 'Hospital' })).toBe(false)
    expect(isGreenTarget({ activity: 'Idle', state: 'Okay' })).toBe(false)
  })

  it('agrees with the tier the farm sort puts them in', () => {
    // The reason this is shared rather than written twice (#366): the stats
    // filter must never remove a member the farm sort promotes to the top
    // tier. Two copies of the predicate would eventually disagree, and the
    // failure mode is a top-tier target vanishing off the board.
    const asTarget = (m) => ({ isGreen: isGreenTarget(m), okay: m.status_state === 'Okay', until: null, bsp: 1, okayAt: -1 })
    const notGreen = { last_action_status: 'Offline', status_state: 'Okay' }
    expect(farmCompare(asTarget(green), asTarget(notGreen))).toBeLessThan(0)
  })
})

describe('isAbroadTarget (#561)', () => {
  it('is true for Traveling and Abroad', () => {
    expect(isAbroadTarget({ status_state: 'Traveling', status_description: 'Traveling from Torn to Mexico' })).toBe(true)
    expect(isAbroadTarget({ status_state: 'Abroad', status_description: 'In Mexico' })).toBe(true)
  })

  it('is true for a hospitalized-abroad target — the case MonChoon flagged explicitly', () => {
    // "even if they are in the hospital": state is 'Hospital', but the
    // description says they're hospitalized in a foreign country, not Torn.
    expect(isAbroadTarget({ status_state: 'Hospital', status_description: 'In a Canadian hospital' })).toBe(true)
    expect(isAbroadTarget({ status_state: 'Hospital', status_description: 'In an Mexican hospital' })).toBe(true)
  })

  it('is false for a plain domestic hospital target', () => {
    expect(isAbroadTarget({ status_state: 'Hospital', status_description: 'Hospitalized' })).toBe(false)
    expect(isAbroadTarget({ status_state: 'Hospital', status_description: null })).toBe(false)
  })

  it('is false for Okay, Jail, and Fallen', () => {
    expect(isAbroadTarget({ status_state: 'Okay', status_description: 'Okay' })).toBe(false)
    expect(isAbroadTarget({ status_state: 'Jail', status_description: 'In jail' })).toBe(false)
    expect(isAbroadTarget({ status_state: 'Fallen', status_description: null })).toBe(false)
  })

  it('tolerates a missing row', () => {
    expect(isAbroadTarget(null)).toBe(false)
    expect(isAbroadTarget({})).toBe(false)
  })

  it('reads the mobile row shape as well as the desktop one', () => {
    expect(isAbroadTarget({ state: 'Abroad', description: 'In Mexico' })).toBe(true)
    expect(isAbroadTarget({ state: 'Hospital', description: 'In a Canadian hospital' })).toBe(true)
    expect(isAbroadTarget({ state: 'Hospital', description: 'Hospitalized' })).toBe(false)
  })
})

describe('splitFarmAbroad (#561)', () => {
  // Minimal farmTarget projection over the same normalized member shape the
  // rest of this file uses (id, status_state/status_description, bsp).
  const toFarmTarget = (m) => ({
    isGreen: isGreenTarget({ last_action_status: m.activity, status_state: m.status_state }),
    okay: m.status_state === 'Okay',
    until: m.until ?? null,
    bsp: m.bsp ?? null,
    okayAt: -1,
  })

  it('segregates travelling/abroad/hospitalized-abroad into "abroad", everyone else into "main"', () => {
    const green   = { id: 'green', activity: 'Online', status_state: 'Okay', bsp: 1 }
    const domesticHospital = { id: 'dom-hosp', activity: 'Offline', status_state: 'Hospital', status_description: 'Hospitalized', until: 100, bsp: 2 }
    const fallen   = { id: 'fallen', activity: 'Offline', status_state: 'Fallen', bsp: 3 }
    const flying   = { id: 'flying', activity: 'Offline', status_state: 'Traveling', status_description: 'Traveling from Torn to Mexico', bsp: 4 }
    const abroad   = { id: 'abroad', activity: 'Offline', status_state: 'Abroad', status_description: 'In Mexico', bsp: 5 }
    const hospAbroad = { id: 'hosp-abroad', activity: 'Offline', status_state: 'Hospital', status_description: 'In a Canadian hospital', until: 50, bsp: 6 }

    const { main, abroad: abroadList } = splitFarmAbroad(
      [green, domesticHospital, fallen, flying, abroad, hospAbroad],
      toFarmTarget
    )

    expect(main.map(m => m.id).sort()).toEqual(['dom-hosp', 'fallen', 'green'])
    expect(abroadList.map(m => m.id).sort()).toEqual(['abroad', 'flying', 'hosp-abroad'])
  })

  it('keeps farmCompare ordering for the main list — a domestic hospital timer still ranks by soonest-out', () => {
    const soon  = { id: 'soon', activity: 'Offline', status_state: 'Hospital', status_description: 'Hospitalized', until: 100, bsp: 1 }
    const later = { id: 'later', activity: 'Offline', status_state: 'Hospital', status_description: 'Hospitalized', until: 900, bsp: 1 }
    const { main } = splitFarmAbroad([later, soon], toFarmTarget)
    expect(main.map(m => m.id)).toEqual(['soon', 'later'])
  })

  it('sorts the abroad section by battle stats descending, nulls last — NOT by timer', () => {
    // hospAbroadSoon's timer would put it first under the main-list ordering,
    // but the abroad section deliberately ignores timers (#561): the target
    // still needs travel time home once released.
    const hospAbroadSoon = { id: 'hosp-soon', activity: 'Offline', status_state: 'Hospital', status_description: 'In a Canadian hospital', until: 10, bsp: 3_000_000 }
    const flyingBig      = { id: 'flying-big', activity: 'Offline', status_state: 'Traveling', status_description: 'Traveling from Torn to Mexico', until: 9_000, bsp: 9_000_000 }
    const abroadUnspied  = { id: 'abroad-unspied', activity: 'Offline', status_state: 'Abroad', status_description: 'In Mexico', bsp: null }

    const { abroad } = splitFarmAbroad([hospAbroadSoon, abroadUnspied, flyingBig], toFarmTarget)
    expect(abroad.map(m => m.id)).toEqual(['flying-big', 'hosp-soon', 'abroad-unspied'])
  })

  it('is a no-op for an all-domestic roster — abroad is empty, main preserves farmCompare order', () => {
    const green = { id: 'green', activity: 'Online', status_state: 'Okay', bsp: 1 }
    const red   = { id: 'red', activity: 'Offline', status_state: 'Okay', bsp: 2 }
    const { main, abroad } = splitFarmAbroad([red, green], toFarmTarget)
    expect(abroad).toEqual([])
    expect(main.map(m => m.id)).toEqual(['green', 'red'])
  })
})
