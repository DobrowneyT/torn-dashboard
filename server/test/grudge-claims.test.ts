// Claim expiry for the Book of Grudges (#892).
//
// ⚠️ Every rule here was earned in a live war by the War Room's dibs, and the
// tests are written to the failures rather than to the happy path: a claim
// that never releases, a claim that releases when nothing happened, and the
// one bad sweep that frees the whole board.
import { describe, expect, it } from 'vitest'
import { decideClaim, canRelease, CLAIM_HEADSTART_SECONDS } from '../src/grudgeClaims.js'

const hosp = (until: number) => ({ state: 'Hospital', until })
const okay = { state: 'Okay', until: 0 }

describe('decideClaim', () => {
  it('⚠️ does NOTHING when the reading is missing', () => {
    // The load-bearing guard. One failed sweep would otherwise free every
    // claim on the board at once, mid-chain, with no explanation.
    expect(decideClaim(okay, null)).toEqual({ release: null, arm: false })
    expect(decideClaim(okay, {})).toEqual({ release: null, arm: false })
    expect(decideClaim(okay, { state: null })).toEqual({ release: null, arm: false })
    expect(decideClaim(okay, { state: 123 as any })).toEqual({ release: null, arm: false })
  })

  it('⚠️ releases when an Okay target stops being attackable', () => {
    // Somebody got there, or they jailed or flew. Either way it is spent.
    expect(decideClaim(okay, hosp(999)).release).toBe('spent')
    expect(decideClaim(okay, { state: 'Jail', until: 999 }).release).toBe('spent')
    expect(decideClaim(okay, { state: 'Traveling', until: 0 }).release).toBe('spent')
  })

  it('⚠️ releases when a hospital timer JUMPS UP', () => {
    // Still in hospital, but somebody else hit them (#107).
    expect(decideClaim(hosp(100), hosp(500)).release).toBe('spent')
  })

  it('does not release while a hospital timer merely counts down', () => {
    // The normal case, and releasing here would free a claim every tick.
    expect(decideClaim(hosp(500), hosp(400))).toEqual({ release: null, arm: false })
  })

  it('⚠️ KEEPS the claim when the target comes out, and arms a head start', () => {
    // This is the reservation paying off. Releasing here would hand the target
    // to whoever happened to be looking the moment the holder's wait ended.
    expect(decideClaim(hosp(100), okay)).toEqual({ release: null, arm: true })
  })

  it('does not re-arm a countdown that is already running', () => {
    expect(decideClaim(hosp(100), okay, { armed: true })).toEqual({ release: null, arm: false })
  })

  it('releases once the head start runs out unused', () => {
    const now = 1_000_000
    expect(decideClaim(okay, okay, { armed: true, expiresAt: now - 1, nowMs: now }).release)
      .toBe('window')
  })

  it('leaves an armed claim alone while the head start is still running', () => {
    const now = 1_000_000
    expect(decideClaim(okay, okay, { armed: true, expiresAt: now + 10_000, nowMs: now }))
      .toEqual({ release: null, arm: false })
  })

  it('⚠️ a brand-new claim with nothing to compare does not release', () => {
    // `prev` is null on the first sweep after a claim is made.
    expect(decideClaim(null, okay)).toEqual({ release: null, arm: false })
    expect(decideClaim(null, hosp(500))).toEqual({ release: null, arm: false })
  })

  it('⚠️ an Okay target that stays Okay is not touched', () => {
    // The commonest state on the board. Any release here is a bug that frees
    // claims nobody spent.
    expect(decideClaim(okay, okay)).toEqual({ release: null, arm: false })
  })

  it('⚠️ a hospital reading with no "until" on either side does not release', () => {
    // Absent is not "lower". Treating a missing until as 0 would make every
    // such pair look like a jump and release constantly.
    expect(decideClaim({ state: 'Hospital' }, { state: 'Hospital' }).release).toBeNull()
    expect(decideClaim(hosp(100), { state: 'Hospital' }).release).toBeNull()
    expect(decideClaim({ state: 'Hospital' }, hosp(100)).release).toBeNull()
  })

  it('the head start is a stated length, not a magic number', () => {
    expect(CLAIM_HEADSTART_SECONDS).toBe(30)
  })
})

describe('canRelease', () => {
  it('lets the holder drop their own', () => {
    expect(canRelease({ member_id: '7' }, { memberId: '7', isLeadership: false })).toBe(true)
  })

  it('⚠️ lets leadership free one somebody forgot about', () => {
    // Mid-chain a stuck reservation on a good target costs the whole faction,
    // and waiting for the holder to come back online is not an option.
    expect(canRelease({ member_id: '7' }, { memberId: '1', isLeadership: true })).toBe(true)
  })

  it('refuses an unrelated member', () => {
    expect(canRelease({ member_id: '7' }, { memberId: '9', isLeadership: false })).toBe(false)
  })

  it('compares ids as strings', () => {
    expect(canRelease({ member_id: 7 as any }, { memberId: '7', isLeadership: false })).toBe(true)
  })
})
