// #774 — the review flags, and what they deliberately do not catch.
import { describe, expect, it } from 'vitest'
import {
  flagFor, wasActive, wasAway, ACTIVITY_GAP_MS, AT_RISK_SECONDS,
} from '../src/chain/watchFlags.js'

const H = Date.parse('2027-10-26T04:00:00Z')
const mins = (n: number) => H + n * 60_000
const ev = (over: Partial<Parameters<typeof flagFor>[0]> = {}) => ({
  hourStart: H, lastActions: [], states: ['Okay'], minTimeoutSeconds: 300, sampled: true, ...over,
})

describe('flagFor', () => {
  it('⚠️ does not flag a watcher who made no hits but was around', () => {
    // THE case this whole design turns on. During a healthy chain a watcher
    // with zero attacks did the job — others were hitting and nothing needed
    // doing. Flagging on attacks would fire across most of a successful event.
    expect(flagFor(ev({ lastActions: [mins(12), mins(40)] }))).toBeNull()
  })

  it('flags a watcher with no actions at all', () => {
    expect(flagFor(ev({ lastActions: [] }))).toBe('absent')
  })

  it('⚠️ separates absent from absent while the chain was at risk', () => {
    // Both are flagged — you are paid to be on the hook, not to be needed — but
    // they must not look identical, or leadership treats them identically.
    expect(flagFor(ev({ lastActions: [], minTimeoutSeconds: 600 }))).toBe('absent')
    expect(flagFor(ev({ lastActions: [], minTimeoutSeconds: AT_RISK_SECONDS }))).toBe('absent-at-risk')
    expect(flagFor(ev({ lastActions: [], minTimeoutSeconds: 5 }))).toBe('absent-at-risk')
  })

  it('does not escalate to at-risk when the timer was never sampled', () => {
    expect(flagFor(ev({ lastActions: [], minTimeoutSeconds: null }))).toBe('absent')
  })

  it('⚠️ flags abroad above everything, because it is not a judgment call', () => {
    // A watcher overseas could not have hit anything: the slot was not served.
    // It outranks activity — being busy in Mexico is still being in Mexico.
    expect(flagFor(ev({ states: ['Abroad', 'Abroad'], lastActions: [mins(10)] }))).toBe('abroad')
    expect(flagFor(ev({ states: ['Traveling', 'Traveling'], lastActions: [] }))).toBe('abroad')
  })

  it('does not call it abroad when they were only away for part of the hour', () => {
    // Landing mid-shift is showing up late, not missing it.
    expect(flagFor(ev({ states: ['Traveling', 'Okay'], lastActions: [mins(45)] }))).toBeNull()
  })

  it('⚠️ says nothing about an hour it never looked at', () => {
    // "We were not looking" must never render as "they were not there" — the
    // #330 mistake, where a guard asked "did this change?" while meaning "were
    // we watching?", and it cost a fortnight.
    expect(flagFor(ev({ sampled: false, lastActions: [], states: [] }))).toBeNull()
  })
})

describe('wasActive', () => {
  it('counts an action just before the hour, within the gap', () => {
    // last_action is the LAST thing they did, sampled a few minutes in. Someone
    // who acted at 03:55 and was polled at 04:05 was plainly around.
    expect(wasActive(ev({ lastActions: [H - ACTIVITY_GAP_MS + 60_000] }))).toBe(true)
  })

  it('does not count an action long before the hour', () => {
    expect(wasActive(ev({ lastActions: [H - 3 * 3600_000] }))).toBe(false)
  })

  it('does not count an action after the hour ended', () => {
    expect(wasActive(ev({ lastActions: [H + 3600_000 + 60_000] }))).toBe(false)
  })
})

describe('wasAway', () => {
  it('is false when nothing was sampled, rather than true by vacuous truth', () => {
    // `[].every(...)` is true, which would flag every unsampled hour as abroad
    // and quietly refuse to pay for it.
    expect(wasAway(ev({ states: [] }))).toBe(false)
  })
})
