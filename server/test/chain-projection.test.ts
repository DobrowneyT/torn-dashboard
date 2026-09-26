// #774 — projecting where the chain finishes, and refusing to when it cannot.
import { describe, expect, it } from 'vitest'
import {
  projectChain, CHAIN_TARGET, WINDOW_MS, BAND,
} from '../src/chain/chainProjection.js'

const T0 = Date.parse('2027-10-26T00:00:00Z')
const h = (n: number) => T0 + n * 3600_000
/** A steady climb, sampled hourly. */
const steady = (hours: number, perHour: number, from = 0) =>
  Array.from({ length: hours + 1 }, (_, i) => ({ chain: from + i * perHour, at: h(i) }))

describe('projectChain', () => {
  it('projects a finish from the rate the chain is actually climbing', () => {
    const readings = steady(48, 250)            // 12,000 hits over two days
    const p = projectChain(readings, h(48))
    expect(p.measured).toBe(true)
    if (!p.measured) return
    expect(p.current).toBe(12_000)
    expect(p.hitsPerHour).toBeCloseTo(250, 6)
    expect(p.remaining).toBe(CHAIN_TARGET - 12_000)
    // 88,000 left at 250/h = 352h. The band straddles that.
    const centre = h(48) + 352 * 3600_000
    expect((p.earliest + p.latest) / 2).toBeCloseTo(centre, -4)
  })

  it('⚠️ returns a band, not a point', () => {
    // A projection eleven days out stated to the hour is false precision that
    // somebody will plan around. travelEta (#330) sets the precedent.
    const p = projectChain(steady(48, 250), h(48))
    if (!p.measured) throw new Error('expected a projection')
    expect(p.latest).toBeGreaterThan(p.earliest)
    const hoursLeft = (CHAIN_TARGET - 12_000) / 250
    expect(p.latest - p.earliest).toBeCloseTo(2 * BAND * hoursLeft * 3600_000, -4)
  })

  it('⚠️ measures over a whole day, so the answer does not swing with the clock', () => {
    // Hit rate is violently diurnal. These readings are a real day: dead
    // overnight, heavy in the evening. Sampled at 06:00 (after the quiet) and
    // at 22:00 (after the rush), a six-hour window would give wildly different
    // answers. A 24h window gives the same one.
    const perHour = [
      5, 5, 5, 5, 5, 5, 10, 20, 40, 60, 80, 90,
      90, 90, 80, 70, 120, 200, 300, 300, 200, 100, 40, 10,
    ]
    const readings = [{ chain: 0, at: h(0) }]
    let total = 0
    perHour.forEach((n, i) => { total += n; readings.push({ chain: total, at: h(i + 1) }) })
    // Two more days of the same shape so a full window exists at both hours.
    for (let d = 1; d < 3; d++) {
      perHour.forEach((n, i) => {
        total += n
        readings.push({ chain: total, at: h(d * 24 + i + 1) })
      })
    }
    const atQuiet = projectChain(readings.filter((r) => r.at <= h(48 + 6)), h(48 + 6))
    const atRush = projectChain(readings.filter((r) => r.at <= h(48 + 22)), h(48 + 22))
    if (!atQuiet.measured || !atRush.measured) throw new Error('expected projections')
    // Same daily total either way — the cycle is averaged out, not sampled.
    expect(atQuiet.hitsPerHour).toBeCloseTo(atRush.hitsPerHour, 1)
  })

  it('⚠️ refuses to project from less than a day of chain', () => {
    // Six hours extrapolated to 100,000 hits is noise wearing a date, and an
    // absent projection is fine where a confident wrong one is not.
    const p = projectChain(steady(6, 250), h(6))
    expect(p.measured).toBe(false)
    if (p.measured) return
    expect(p.reason).toBe('too-early')
    expect(p.current).toBe(1_500)   // still says where the chain IS
  })

  it('says nothing useful about a chain that is not moving', () => {
    const flat = Array.from({ length: 49 }, (_, i) => ({ chain: 4_000, at: h(i) }))
    const p = projectChain(flat, h(48))
    expect(p.measured).toBe(false)
    if (p.measured) return
    expect(p.reason).toBe('stalled')
    expect(p.hitsPerHour).toBe(0)
  })

  it('reports a finished chain as finished rather than projecting past the cap', () => {
    const done = steady(48, 2_500)   // 120,000 — over Torn's limit
    const p = projectChain(done, h(48))
    expect(p.measured).toBe(false)
    if (p.measured) return
    expect(p.reason).toBe('complete')
  })

  it('handles having nothing to read', () => {
    const p = projectChain([], h(0))
    expect(p.measured).toBe(false)
    if (p.measured) return
    expect(p.reason).toBe('no-readings')
    expect(p.current).toBeNull()
  })

  it('⚠️ takes its window from elapsed time, not from how many rows arrived', () => {
    // A sampler that stopped for a day leaves few rows over a long span. The
    // window is the span, and the rate must not be computed as if the gap were
    // dense — nor rejected merely for being sparse.
    const sparse = [
      { chain: 0, at: h(0) },
      { chain: 6_000, at: h(24) },
      { chain: 12_000, at: h(48) },
    ]
    const p = projectChain(sparse, h(48))
    expect(p.measured).toBe(true)
    if (!p.measured) return
    expect(p.hitsPerHour).toBeCloseTo(250, 6)
    expect(p.windowHours).toBe(24)
  })

  it('ignores unusable readings instead of poisoning the rate', () => {
    const readings = [...steady(48, 250), { chain: NaN, at: h(49) } as any]
    const p = projectChain(readings, h(48))
    expect(p.measured).toBe(true)
  })
})
