// Refresh cadence for the Book of Grudges watch (#889).
//
// ⚠️ The theme is the two ways this goes wrong at opposite ends of the scale:
// a small list refreshing far slower than it could, and a large one quietly
// spending the whole key pool and starving every other scraper.
import { describe, expect, it } from 'vitest'
import {
  planWatchCycle, shardFor, describePlan,
  TORN_CALLS_PER_KEY_PER_MINUTE, WATCH_KEY_SHARE, TICK_SECONDS,
} from '../src/grudgeWatchPlan.js'

const work = (factions: number, individuals: number) => ({
  factions: Array.from({ length: factions }, (_, i) => `f${i}`),
  individuals: Array.from({ length: individuals }, (_, i) => `i${i}`),
})

describe('planWatchCycle', () => {
  it('⚠️ costs one call per FACTION, not one per target', () => {
    // The whole reason a fast rate is affordable: /faction/{id}/members
    // returns every member's status in one call.
    const p = planWatchCycle(work(10, 5), 4)
    expect(p.callsPerSweep).toBe(15)
  })

  it('refreshes everything every tick when the budget allows', () => {
    // 4 keys × 100 × 0.25 = 100 calls a minute against a 15-call sweep.
    const p = planWatchCycle(work(10, 5), 4)
    expect(p.callsPerTick).toBe(100)
    expect(p.shards).toBe(1)
    expect(p.secondsPerSweep).toBe(TICK_SECONDS)
  })

  it('⚠️ shards a sweep too big for one tick instead of overspending', () => {
    // 1 key → 25 calls a minute; a 60-call sweep takes 3 ticks.
    const p = planWatchCycle(work(60, 0), 1)
    expect(p.callsPerTick).toBe(25)
    expect(p.shards).toBe(3)
    expect(p.secondsPerSweep).toBe(180)
  })

  it('⚠️ spends only a QUARTER of each key, leaving the other scrapers room', () => {
    // A watch that takes a key's whole minute starves OC tracking, the War
    // Room and member stats — the 2026-09-10 shape.
    const p = planWatchCycle(work(1000, 0), 10)
    expect(p.callsPerTick).toBe(10 * TORN_CALLS_PER_KEY_PER_MINUTE * WATCH_KEY_SHARE)
    expect(p.callsPerTick).toBeLessThan(10 * TORN_CALLS_PER_KEY_PER_MINUTE)
  })

  it('⚠️ does nothing when no key has consented', () => {
    // A consent outcome, not an error.
    const p = planWatchCycle(work(10, 5), 0)
    expect(p.callsPerTick).toBe(0)
    expect(p.secondsPerSweep).toBe(0)
  })

  it('⚠️ never produces zero calls while a key exists', () => {
    // A tiny share could otherwise floor to 0 and the watch would silently
    // never run at all.
    const p = planWatchCycle(work(5, 0), 1, 0.001)
    expect(p.callsPerTick).toBe(1)
    expect(p.shards).toBe(5)
  })

  it('handles an empty list without inventing work', () => {
    const p = planWatchCycle(work(0, 0), 4)
    expect(p.callsPerSweep).toBe(0)
    expect(p.shards).toBe(1)
  })

  it('gets faster as more members consent', () => {
    const one = planWatchCycle(work(100, 0), 1)
    const ten = planWatchCycle(work(100, 0), 10)
    expect(ten.secondsPerSweep).toBeLessThan(one.secondsPerSweep)
  })
})

describe('shardFor', () => {
  it('returns everything when a sweep fits in one tick', () => {
    const w = work(5, 5)
    const p = planWatchCycle(w, 4)
    expect(shardFor(w, p).factions).toHaveLength(5)
    expect(shardFor(w, p).individuals).toHaveLength(5)
  })

  it('⚠️ covers every item across a full cycle, leaving nothing stale forever', () => {
    const w = work(60, 0)
    const p = planWatchCycle(w, 1)
    const seen = new Set<string>()
    for (let tick = 0; tick < p.shards; tick++) {
      const slice = shardFor(w, p, tick * TICK_SECONDS * 1000)
      slice.factions.forEach((f) => seen.add(f))
    }
    expect(seen.size).toBe(60)
  })

  it('⚠️ stays within the per-tick budget', () => {
    const w = work(60, 0)
    const p = planWatchCycle(w, 1)
    for (let tick = 0; tick < p.shards; tick++) {
      const slice = shardFor(w, p, tick * TICK_SECONDS * 1000)
      expect(slice.factions.length + slice.individuals.length).toBeLessThanOrEqual(p.callsPerTick)
    }
  })

  it('⚠️ puts FACTIONS first, so a tight budget buys the most coverage', () => {
    // A faction call covers many targets; an individual covers one.
    const w = work(10, 10)
    const p = planWatchCycle(w, 1, 0.05)   // 5 calls a tick
    const first = shardFor(w, p, 0)
    expect(first.factions.length).toBeGreaterThan(0)
    expect(first.individuals).toHaveLength(0)
  })

  it('⚠️ needs no stored cursor, so it cannot get stuck', () => {
    // A persisted cursor is one more thing to jam: a crash mid-sweep, two
    // processes, a reset that re-reads the same slice forever.
    const w = work(9, 0)
    const p = planWatchCycle(w, 1, 0.03)
    const a = shardFor(w, p, 0).factions
    const b = shardFor(w, p, TICK_SECONDS * 1000).factions
    expect(a).not.toEqual(b)
  })
})

describe('describePlan', () => {
  it('says plainly what the cadence is', () => {
    const w = work(60, 0)
    expect(describePlan(planWatchCycle(w, 1), 1)).toMatch(/60 API calls.*3 ticks.*every 3 minutes/)
  })
  it('explains an idle watch rather than showing a zero', () => {
    expect(describePlan(planWatchCycle(work(5, 0), 0), 0)).toMatch(/Nobody has accepted/)
  })
})
