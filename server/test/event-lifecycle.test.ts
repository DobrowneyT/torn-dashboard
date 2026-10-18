// When a faction event is upcoming, live, or over (#969).
//
// ⚠️ The end is not a date: live until 1 Nov 16:00 TCT at minimum, then until
// the chain finishes or breaks. These pin the edges that are easy to get wrong.
import { describe, expect, it } from 'vitest'
import {
  eventPhase, eventEndedAt, firstChainEndAfter, isChainOver, TORN_CHAIN_MAX,
  type EventTimes,
} from '../src/events/eventLifecycle.js'

const T = (iso: string) => Date.parse(iso)
// Halloween 2026 as decided on #967.
const halloween = (over: Partial<EventTimes> = {}): EventTimes => ({
  starts_at: T('2026-10-25T10:00:00Z'),
  min_ends_at: T('2026-11-01T16:00:00Z'),
  ends_with_chain: true,
  ended_at: null,
  ...over,
})

describe('eventPhase', () => {
  it('is upcoming before the start', () => {
    expect(eventPhase(halloween(), T('2026-10-25T09:59:59Z'), null)).toBe('upcoming')
  })

  it('is live from the first instant of the start', () => {
    expect(eventPhase(halloween(), T('2026-10-25T10:00:00Z'), null)).toBe('live')
  })

  it('⚠️ stays live before the minimum end EVEN IF the chain has died', () => {
    // MonChoon: "at minimum the event will last until November 1 16:00 TCT".
    // A chain that broke on 30 Oct does not end the event early.
    expect(eventPhase(halloween(), T('2026-10-30T12:00:00Z'), T('2026-10-30T11:00:00Z')))
      .toBe('live')
  })

  it('stays live past the minimum while the chain is still going', () => {
    expect(eventPhase(halloween(), T('2026-11-03T05:00:00Z'), null)).toBe('live')
  })

  it('ends once the chain is over, past the minimum', () => {
    expect(eventPhase(halloween(), T('2026-11-03T06:00:00Z'), T('2026-11-03T05:11:00Z')))
      .toBe('ended')
  })

  it('without ends_with_chain, the minimum IS the end', () => {
    const e = halloween({ ends_with_chain: false })
    expect(eventPhase(e, T('2026-11-01T15:59:59Z'), null)).toBe('live')
    expect(eventPhase(e, T('2026-11-01T16:00:00Z'), null)).toBe('ended')
  })

  it('⚠️ once stamped ended, it STAYS ended whatever the chain does next', () => {
    // A finished event must not come back to life when the faction starts an
    // ordinary chain the following week.
    const e = halloween({ ended_at: T('2026-11-03T05:11:00Z') })
    expect(eventPhase(e, T('2026-11-10T12:00:00Z'), null)).toBe('ended')
  })

  it('⚠️ no chain data past the minimum keeps it LIVE — an outage must not end it', () => {
    expect(eventPhase(halloween(), T('2026-11-02T00:00:00Z'), null)).toBe('live')
  })
})

describe('eventEndedAt — what gets stamped', () => {
  it('is the derived chain end, not the moment somebody looked', () => {
    expect(eventEndedAt(halloween(), T('2026-11-03T05:11:00Z'))).toBe(T('2026-11-03T05:11:00Z'))
  })

  it('is never earlier than the minimum end', () => {
    // A chain end seen before the minimum is not the event's end.
    expect(eventEndedAt(halloween(), T('2026-10-30T11:00:00Z'))).toBe(T('2026-11-01T16:00:00Z'))
  })

  it('is the minimum end when the event does not wait for a chain', () => {
    expect(eventEndedAt(halloween({ ends_with_chain: false }), null)).toBe(T('2026-11-01T16:00:00Z'))
  })

  it('is null while the chain is still going', () => {
    expect(eventEndedAt(halloween(), null)).toBeNull()
  })

  it('keeps an end that is already stamped', () => {
    const at = T('2026-11-02T09:00:00Z')
    expect(eventEndedAt(halloween({ ended_at: at }), T('2026-11-05T00:00:00Z'))).toBe(at)
  })
})

describe('reading the chain samples', () => {
  const since = T('2026-11-01T16:00:00Z')
  const s = (iso: string, chain_current: number | null) => ({ sampled_at: T(iso), chain_current })

  it('a chain at 0 is over; one at Torn\'s cap is over; a running one is not', () => {
    expect(isChainOver({ sampled_at: 0, chain_current: 0 })).toBe(true)
    expect(isChainOver({ sampled_at: 0, chain_current: TORN_CHAIN_MAX })).toBe(true)
    expect(isChainOver({ sampled_at: 0, chain_current: 54_321 })).toBe(false)
  })

  it('⚠️ a sample with no reading is NOT a dead chain', () => {
    // A failed poll during an outage is an absence of information.
    expect(isChainOver({ sampled_at: 0, chain_current: null })).toBe(false)
  })

  it('finds the FIRST dead sample at or after the minimum end', () => {
    const samples = [
      s('2026-10-30T11:00:00Z', 0),          // before the minimum — ignored
      s('2026-11-02T10:00:00Z', 81_000),
      s('2026-11-03T05:12:00Z', 0),          // ← this one
      s('2026-11-03T05:16:00Z', 0),
    ]
    expect(firstChainEndAfter(samples, since)).toBe(T('2026-11-03T05:12:00Z'))
  })

  it('⚠️ ignores a chain death BEFORE the minimum end', () => {
    expect(firstChainEndAfter([s('2026-10-30T11:00:00Z', 0)], since)).toBeNull()
  })

  it('skips null readings rather than treating them as a death', () => {
    expect(firstChainEndAfter([s('2026-11-02T00:00:00Z', null)], since)).toBeNull()
  })

  it('a chain that reaches 100k ends it', () => {
    expect(firstChainEndAfter([s('2026-11-02T00:00:00Z', 100_000)], since))
      .toBe(T('2026-11-02T00:00:00Z'))
  })
})
