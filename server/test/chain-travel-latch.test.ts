// #774 — did we actually witness the take-off? (rule from #330)
import { describe, expect, it } from 'vitest'
import {
  latchDeparture, isAway, isTravelling, TRAVEL_EDGE_TRUST_MS,
} from '../src/chain/travelLatch.js'

const T = Date.parse('2027-10-26T04:00:00Z')
const obs = (state: string | null, sampledAt: number, departedAt: number | null = null) =>
  ({ state, sampledAt, departedAt })

describe('latchDeparture', () => {
  it('latches the moment we saw them leave', () => {
    expect(latchDeparture(obs('Okay', T - 300_000), { state: 'Traveling', sampledAt: T })).toBe(T)
  })

  it('keeps the departure it already has while they are still in the air', () => {
    expect(latchDeparture(obs('Traveling', T - 300_000, T - 900_000),
      { state: 'Traveling', sampledAt: T })).toBe(T - 900_000)
  })

  it('clears it once they are no longer travelling', () => {
    expect(latchDeparture(obs('Traveling', T - 300_000, T - 900_000),
      { state: 'Abroad', sampledAt: T })).toBeNull()
    expect(latchDeparture(obs('Traveling', T - 300_000, T - 900_000),
      { state: 'Okay', sampledAt: T })).toBeNull()
  })

  it('⚠️ refuses to invent a departure after a gap in sampling', () => {
    // The #330 lesson: the first sample after a restart or a deploy reads a
    // member who left hours ago as having just taken off, and produces a
    // confidently wrong arrival. Wrong is worse than absent — a lead waits on
    // it, and an absent ETA at least says so.
    const stale = obs('Okay', T - TRAVEL_EDGE_TRUST_MS - 60_000)
    expect(latchDeparture(stale, { state: 'Traveling', sampledAt: T })).toBeNull()
  })

  it('believes an edge right at the trust boundary', () => {
    const edge = obs('Okay', T - TRAVEL_EDGE_TRUST_MS)
    expect(latchDeparture(edge, { state: 'Traveling', sampledAt: T })).toBe(T)
  })

  it('⚠️ gives nothing for a member first seen already in the air', () => {
    // We did not witness the departure, so there is nothing to count from.
    expect(latchDeparture(null, { state: 'Traveling', sampledAt: T })).toBeNull()
  })

  it('carries a null departure forward rather than back-filling one', () => {
    // Still travelling, and we never saw them go. A later sample must not
    // suddenly decide the take-off was now.
    expect(latchDeparture(obs('Traveling', T - 300_000, null),
      { state: 'Traveling', sampledAt: T })).toBeNull()
  })
})

describe('away states', () => {
  it('counts both in-the-air and already-overseas as away', () => {
    expect(isAway('Traveling')).toBe(true)
    expect(isAway('Abroad')).toBe(true)
    expect(isAway('Okay')).toBe(false)
    expect(isAway('Hospital')).toBe(false)
  })

  it('separates in-the-air from overseas, because only one has an ETA', () => {
    expect(isTravelling('Traveling')).toBe(true)
    expect(isTravelling('Abroad')).toBe(false)
  })
})

describe('chain timers', () => {
  it('converts Torn’s relative seconds to an absolute epoch', async () => {
    const { toAbsoluteEpoch } = await import('../src/chain/chainTimers.js')
    expect(toAbsoluteEpoch(184, 1_000_000)).toBe(1_000_184)
  })

  it('⚠️ treats no-timer as null, never as "drops right now"', async () => {
    // A zero that survives as the current time reads as a chain about to drop
    // this instant, which is the opposite of what it means.
    const { toAbsoluteEpoch } = await import('../src/chain/chainTimers.js')
    expect(toAbsoluteEpoch(0, 1_000_000)).toBeNull()
    expect(toAbsoluteEpoch(null, 1_000_000)).toBeNull()
    expect(toAbsoluteEpoch(undefined, 1_000_000)).toBeNull()
    expect(toAbsoluteEpoch('nonsense', 1_000_000)).toBeNull()
  })
})
