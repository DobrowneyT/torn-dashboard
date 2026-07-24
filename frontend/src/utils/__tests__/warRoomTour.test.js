import { describe, it, expect } from 'vitest'
import { isTourSeen, markTourSeen, resetTourSeen, firstPresentStep } from '../warRoomTour'
import { tourStepsFor } from '../../components/warroom/warRoomTourSteps'

// A minimal in-memory localStorage stand-in (the frontend test env has none).
function fakeStorage() {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  }
}

describe('war room tour seen-state (per browser, per surface)', () => {
  it('tracks desktop and mobile independently, and replay clears it', () => {
    const s = fakeStorage()
    expect(isTourSeen('desktop', s)).toBe(false)
    markTourSeen('desktop', s)
    expect(isTourSeen('desktop', s)).toBe(true)
    // Mobile is a separate flag.
    expect(isTourSeen('mobile', s)).toBe(false)
    // Replay (reset) makes it run again.
    resetTourSeen('desktop', s)
    expect(isTourSeen('desktop', s)).toBe(false)
  })

  it('with no storage available, nothing is "seen" and writes are safe', () => {
    expect(isTourSeen('desktop', null)).toBe(false)
    expect(() => markTourSeen('desktop', null)).not.toThrow()
  })
})

describe('firstPresentStep — graceful skip of absent targets', () => {
  const steps = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
  const present = (ids) => (step) => ids.has(step.id)

  it('finds the first present step forward from a start index', () => {
    expect(firstPresentStep(steps, 0, 1, present(new Set(['b', 'd'])))).toBe(1) // a absent → b
    expect(firstPresentStep(steps, 2, 1, present(new Set(['d'])))).toBe(3)      // c absent → d
  })

  it('returns -1 when no present step remains in that direction', () => {
    expect(firstPresentStep(steps, 0, 1, present(new Set()))).toBe(-1)
    expect(firstPresentStep(steps, 3, 1, present(new Set(['a'])))).toBe(-1)
  })

  it('scans backward for Back navigation', () => {
    expect(firstPresentStep(steps, 3, -1, present(new Set(['a', 'c'])))).toBe(2) // d,b absent → c
  })
})

describe('tour steps content', () => {
  it('splits desktop and mobile surfaces and includes the mobile-launcher callout', () => {
    const desktopIds = tourStepsFor('desktop').map((s) => s.id)
    const mobileIds = tourStepsFor('mobile').map((s) => s.id)
    expect(desktopIds).toContain('mobile') // desktop step that calls out the launcher
    expect(desktopIds).toContain('help')   // "here's the ? for later"
    expect(mobileIds.length).toBeGreaterThan(0)
    expect(mobileIds.every((id) => id.startsWith('m-'))).toBe(true)
  })
})
