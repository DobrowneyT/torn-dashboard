import { describe, it, expect } from 'vitest'
import { farmCompare } from '../warRoomFarmSort'

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
