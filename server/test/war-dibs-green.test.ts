// Whether a hit on a dibbed target can be a steal at all (#935).
//
// ⚠️ **This file decides whether somebody gets called a thief.** The column it
// feeds, `took_from_others`, is an accusation with a member's name on it — so
// the cases that matter most are the ones where clearing the hit is correct and
// the obvious implementation gets it wrong.
import { describe, expect, it } from 'vitest'
import {
  claimKind, canBeStolen, claimedGreen, isGreenOnline, explainGreen,
  CLAIM_KINDS, GREEN_ONLINE_STATES,
} from '../src/warDibsGreen.js'

describe('isGreenOnline', () => {
  it('counts Online', () => {
    expect(isGreenOnline('Online')).toBe(true)
  })

  /**
   * ⚠️ The tunable, asserted so a change is deliberate. MonChoon, 2026-10-09:
   * "For now lets go with Online only, not idle." An idle player is often still
   * at the keyboard, so including them would widen the free-for-all beyond what
   * was asked — 8 more of 190 on the live roster when this was written.
   */
  it('does NOT count Idle', () => {
    expect(isGreenOnline('Idle')).toBe(false)
    expect(GREEN_ONLINE_STATES.has('Idle')).toBe(false)
  })

  it('does not count Offline or nonsense', () => {
    for (const v of ['Offline', '', null, undefined, 7, {}]) {
      expect(isGreenOnline(v as unknown)).toBe(false)
    }
  })
})

describe('claimKind', () => {
  /**
   * ⚠️ THE case this whole issue exists for, and the one a claim-time-only
   * design gets wrong. MonChoon's description of what actually happens:
   * claimed in hospital while OFFLINE, logs in while still in hospital,
   * surfaces online, teammate hits them. Claim-time status says Hospital +
   * Offline, so looking only there calls that hit a steal.
   */
  it('is green-means-go when the target surfaced online, however it was claimed', () => {
    expect(claimKind({
      claim_state: 'Hospital', claim_online: 'Offline',
      surfaced_online: true, surfaced_at: '2026-10-09T14:32:07+00',
    })).toBe(CLAIM_KINDS.greenMeansGo)
  })

  it('is green-means-go when the target was already green at claim time', () => {
    // "Nobody should be claiming targets that are green" — but it happens, and
    // the claim reserved nothing when it did.
    expect(claimKind({ claim_state: 'Okay', claim_online: 'Online', surfaced_online: null }))
      .toBe(CLAIM_KINDS.greenMeansGo)
  })

  it('is a reservation when the target surfaced OFFLINE', () => {
    // The ordinary, honest case: claimed while down, still away when they came
    // out, so the claim did its job and a teammate's hit really is a steal.
    expect(claimKind({
      claim_state: 'Hospital', claim_online: 'Offline', surfaced_online: false,
    })).toBe(CLAIM_KINDS.reservation)
  })

  it('is a reservation when claimed Okay but offline', () => {
    // Okay alone is not green — an offline player cannot fly away.
    expect(claimKind({ claim_state: 'Okay', claim_online: 'Offline' })).toBe(CLAIM_KINDS.reservation)
  })

  it('is a reservation when claimed in hospital while the target was online', () => {
    // ⚠️ Online alone is not green either: they are in hospital, so they are
    // not fair game yet. Both halves are required.
    expect(claimKind({ claim_state: 'Hospital', claim_online: 'Online' }))
      .toBe(CLAIM_KINDS.reservation)
  })

  /**
   * ⚠️ A row with `surfaced_online: false` IS fully observed — the target
   * simply never surfaced online. Reading that as unknown would throw away the
   * answer in the most common case.
   */
  it('treats a recorded false as observed, not as unknown', () => {
    expect(claimKind({ surfaced_online: false })).toBe(CLAIM_KINDS.reservation)
  })

  /**
   * ⚠️ Claims from before #935 have none of this. They must read as NEITHER:
   * defaulting them to green would silently clear a month of real steals, and
   * defaulting to reservation would assert something never observed.
   */
  it('is unknown only when nothing at all was observed', () => {
    expect(claimKind({})).toBe(CLAIM_KINDS.unknown)
    expect(claimKind({ claim_state: null, claim_online: null, surfaced_online: null })).toBe(CLAIM_KINDS.unknown)
    expect(claimKind(null)).toBe(CLAIM_KINDS.unknown)
    expect(claimKind(undefined)).toBe(CLAIM_KINDS.unknown)
  })
})

describe('canBeStolen', () => {
  it('clears a hit on a target who surfaced online', () => {
    expect(canBeStolen({ claim_state: 'Hospital', claim_online: 'Offline', surfaced_online: true })).toBe(false)
  })

  it('still allows a steal on a genuine reservation', () => {
    expect(canBeStolen({ claim_state: 'Hospital', claim_online: 'Offline', surfaced_online: false })).toBe(true)
  })

  /**
   * ⚠️ Deliberate: an UNOBSERVED claim can still be stolen, so the
   * back-history behaves exactly as it did before #935. The new leniency
   * applies to claims we actually watched, rather than retroactively clearing
   * every steal ever recorded.
   */
  it('leaves the back-history alone', () => {
    expect(canBeStolen({})).toBe(true)
  })
})

describe('explainGreen', () => {
  /**
   * ⚠️ The deliverable is an ARGUMENT, not a bucket. MonChoon: "sometimes
   * members claim 'my dibs was taken' … and we need to justify it that they
   * were online so the dibs was no longer relevant."
   */
  it('names the time they surfaced, because that is the evidence', () => {
    const text = explainGreen({
      claim_state: 'Hospital', claim_online: 'Offline',
      surfaced_online: true, surfaced_at: '14:32:07',
    })
    expect(text).toContain('14:32:07')
    expect(text).toMatch(/online/i)
  })

  it('formats the timestamp through the caller', () => {
    const text = explainGreen(
      { surfaced_online: true, surfaced_at: 1_791_577_448 },
      () => 'two minutes ago'
    )
    expect(text).toContain('two minutes ago')
  })

  it('still explains a green claim with no recorded time', () => {
    const text = explainGreen({ surfaced_online: true })
    expect(text).toMatch(/online/i)
    expect(text).not.toContain('undefined')
  })

  it('explains the already-green case differently', () => {
    const text = explainGreen({ claim_state: 'Okay', claim_online: 'Online' })
    expect(text).toMatch(/already/i)
  })

  /** ⚠️ Null rather than a vague reassurance: an argument needs the facts or it
   *  is just an assertion, and a reservation has no excuse to offer. */
  it('says nothing for a genuine reservation or an unobserved claim', () => {
    expect(explainGreen({ claim_state: 'Hospital', claim_online: 'Offline', surfaced_online: false })).toBeNull()
    expect(explainGreen({})).toBeNull()
    expect(explainGreen(null)).toBeNull()
  })
})

describe('claimedGreen', () => {
  it('needs BOTH Okay and Online', () => {
    expect(claimedGreen({ claim_state: 'Okay', claim_online: 'Online' })).toBe(true)
    expect(claimedGreen({ claim_state: 'Okay', claim_online: 'Idle' })).toBe(false)
    expect(claimedGreen({ claim_state: 'Hospital', claim_online: 'Online' })).toBe(false)
    expect(claimedGreen({})).toBe(false)
  })
})
