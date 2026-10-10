// What a dibs claim came to, and who took it (#530).
//
// ⚠️ **This file decides who gets blamed.** Every number it produces lands in a
// leaderboard with members' names against it, so the cases that matter most
// here are the ones where the data is ambiguous and the honest answer is "not
// their fault" — a target who self-hospitalised to dodge, a board wiped at war
// setup, a fight that was already underway when the claim was placed.
import { describe, expect, it } from 'vitest'
import {
  classifyClaim, summariseWarDibs, CLAIM_OUTCOMES, STEAL_GRACE_SECONDS,
  warAttacksSettled, ATTACKS_SETTLE_SECONDS,
} from '../src/warDibsSummary.js'

const US = 10739
const THEM = 20747
const OUTSIDER = 99999

const HOLDER = 1001
const MATE = 1002
const TARGET = 90100

/** A claim, in EPOCH SECONDS — the SQL converts, never the JS (#140). */
const claim = (over: Partial<any> = {}) => ({
  id: 1, target_id: TARGET, claimed_by: HOLDER, claimed_name: 'Holder',
  claimed_at: 1000, deleted_at: 2000, release_reason: 'spent', war_id: 700, ...over,
})

const attack = (over: Partial<any> = {}) => ({
  attacker_id: HOLDER, attacker_faction_id: US, attacker_name: 'Holder',
  defender_id: TARGET, defender_faction_id: THEM,
  started: 1500, ended: 1520, result: 'Hospitalized', ...over,
})

const classify = (c: any, attacks: any[], opts: any = {}) =>
  classifyClaim({ claim: c, attacks, ourFactionId: US, warEndTs: 9999, ...opts })

describe('classifyClaim', () => {
  /**
   * ⚠️ THE case that proves attacks outrank the reason. A successful
   * conversion is recorded as `spent`, because the sweep releases a claim the
   * moment the target stops being attackable and does not care who put them
   * there. Reading the reason alone would file every success as "target went
   * down, nobody's doing".
   */
  it('counts the holder landing the hit as converted, despite a `spent` reason', () => {
    const c = classify(claim({ release_reason: 'spent' }), [attack()])
    expect(c.outcome).toBe(CLAIM_OUTCOMES.converted)
    expect(c.holderSwung).toBe(true)
  })

  it('counts the holder swinging and losing as attempted, not as no-swing', () => {
    const c = classify(claim(), [attack({ result: 'Lost' })])
    expect(c.outcome).toBe(CLAIM_OUTCOMES.attempted)
    expect(c.holderSwung).toBe(true)
  })

  it('names the teammate who took it', () => {
    const c = classify(claim(), [attack({ attacker_id: MATE, attacker_name: 'Mate' })])
    expect(c.outcome).toBe(CLAIM_OUTCOMES.taken)
    expect(c.takenBy).toBe(MATE)
    expect(c.holderSwung).toBe(false)
  })

  /**
   * ⚠️ A teammate's LOSS steals nothing — it does not hospitalise the target,
   * so the claim is still live and the holder has lost nothing.
   */
  it('does not call a teammate losing a steal', () => {
    const c = classify(claim({ release_reason: 'window' }), [
      attack({ attacker_id: MATE, result: 'Lost' }),
    ])
    expect(c.outcome).toBe(CLAIM_OUTCOMES.noSwing)
    expect(c.takenBy).toBeNull()
  })

  it('still records the holder swinging when a teammate finished it', () => {
    const c = classify(claim(), [
      attack({ result: 'Lost' }),
      attack({ attacker_id: MATE, started: 1600 }),
    ])
    expect(c.outcome).toBe(CLAIM_OUTCOMES.taken)
    // ⚠️ They tried. A "no swing" column that counted this would be wrong
    // about the one thing it is meant to measure.
    expect(c.holderSwung).toBe(true)
  })

  /**
   * ⚠️ A fight already underway is not a theft. `started` before the claim
   * means the attacker could not possibly have seen it — and `ended` lands
   * after, so matching on `ended` would convict them.
   */
  it('ignores an attack that STARTED before the claim existed', () => {
    const c = classify(claim({ claimed_at: 1000, release_reason: 'spent' }), [
      attack({ attacker_id: MATE, started: 900, ended: 1100 }),
    ])
    expect(c.outcome).toBe(CLAIM_OUTCOMES.outside)
    expect(c.takenBy).toBeNull()
  })

  it('ignores an attack after the claim was released', () => {
    const c = classify(claim({ deleted_at: 2000, release_reason: 'window' }), [
      attack({ attacker_id: MATE, started: 2500 }),
    ])
    expect(c.outcome).toBe(CLAIM_OUTCOMES.noSwing)
  })

  /**
   * ⚠️ The grace window. A claim takes a moment to reach other people's
   * screens; somebody who clicked attack in the same instant raced, they did
   * not steal. Tunable rather than hardcoded.
   */
  it('does not call a hit inside the grace window a steal', () => {
    const c = classify(
      claim({ claimed_at: 1000, release_reason: 'spent' }),
      [attack({ attacker_id: MATE, started: 1000 + STEAL_GRACE_SECONDS - 1 })],
    )
    expect(c.outcome).toBe(CLAIM_OUTCOMES.outside)
    expect(c.raced).toBe(true)
  })

  it('does call it a steal once the grace window has passed', () => {
    const c = classify(
      claim({ claimed_at: 1000, release_reason: 'spent' }),
      [attack({ attacker_id: MATE, started: 1000 + STEAL_GRACE_SECONDS })],
    )
    expect(c.outcome).toBe(CLAIM_OUTCOMES.taken)
    expect(c.raced).toBe(false)
  })

  it('honours a configured grace window', () => {
    const c = classify(
      claim({ claimed_at: 1000, release_reason: 'spent' }),
      [attack({ attacker_id: MATE, started: 1030 })],
      { graceSeconds: 60 },
    )
    expect(c.outcome).toBe(CLAIM_OUTCOMES.outside)
  })

  /** ⚠️ The HOLDER is never racing themselves — grace applies to others only. */
  it('credits the holder converting instantly', () => {
    const c = classify(claim({ claimed_at: 1000 }), [attack({ started: 1000 })])
    expect(c.outcome).toBe(CLAIM_OUTCOMES.converted)
  })

  it('does not count an outside faction as one of ours', () => {
    const c = classify(claim({ release_reason: 'spent' }), [
      attack({ attacker_id: 777, attacker_faction_id: OUTSIDER }),
    ])
    // Torn does not even give us this row in reality — included to prove the
    // faction gate, not because the feed would contain it.
    expect(c.outcome).toBe(CLAIM_OUTCOMES.outside)
  })

  it('ignores attacks on a different target', () => {
    const c = classify(claim({ release_reason: 'window' }), [
      attack({ defender_id: 90999 }),
    ])
    expect(c.outcome).toBe(CLAIM_OUTCOMES.noSwing)
  })

  describe('with no attack of ours to go on, the reason decides', () => {
    const cases: Array<[string, string]> = [
      ['window', CLAIM_OUTCOMES.noSwing],
      ['spent', CLAIM_OUTCOMES.outside],
      ['rehospitalised', CLAIM_OUTCOMES.outside],
      ['manual', CLAIM_OUTCOMES.released],
      ['superseded', CLAIM_OUTCOMES.hopped],
      ['admin', CLAIM_OUTCOMES.overridden],
      ['reset', CLAIM_OUTCOMES.boardReset],
    ]
    for (const [reason, outcome] of cases) {
      it(`${reason} → ${outcome}`, () => {
        expect(classify(claim({ release_reason: reason }), []).outcome).toBe(outcome)
      })
    }
  })

  /**
   * ⚠️ Pre-0072 history. NULL is not a reason, and must not fall through to any
   * default — a claim we cannot explain has to be visibly unexplained, or the
   * first report silently files months of back-history under whichever bucket
   * the `else` happened to point at.
   */
  it('reads a missing reason as unknown, never as a failure', () => {
    const c = classify(claim({ release_reason: null }), [])
    expect(c.outcome).toBe(CLAIM_OUTCOMES.unknown)
  })

  it('reads a reason it does not recognise as unknown too', () => {
    const c = classify(claim({ release_reason: 'something-added-later' }), [])
    expect(c.outcome).toBe(CLAIM_OUTCOMES.unknown)
  })

  it('calls a claim still held at war end open, not a failure', () => {
    const c = classify(claim({ deleted_at: null, release_reason: null }), [])
    expect(c.outcome).toBe(CLAIM_OUTCOMES.open)
  })

  it('measures a still-open claim up to the war end', () => {
    const c = classify(
      claim({ claimed_at: 1000, deleted_at: null, release_reason: null }),
      [attack({ started: 1500 })],
      { warEndTs: 2000 },
    )
    expect(c.outcome).toBe(CLAIM_OUTCOMES.converted)
  })
})

describe('summariseWarDibs', () => {
  it('counts a member\'s own claims and their outcomes', () => {
    const out = summariseWarDibs({
      claims: [
        claim({ id: 1, target_id: 90100 }),
        claim({ id: 2, target_id: 90101, release_reason: 'window' }),
      ],
      attacks: [attack({ defender_id: 90100 })],
      ourFactionId: US,
      warEndTs: 9999,
    })
    const m = out.members.find((r) => r.member_id === HOLDER)!
    expect(m).toMatchObject({ claims: 2, converted: 1, noSwing: 1, takenFrom: 0 })
  })

  /**
   * ⚠️ The two axes. "Stolen" is TWO numbers that cannot share a column: taken
   * FROM a holder, and taken BY an offender. The top-offenders question needs
   * the second, and a member can have both in the same war.
   */
  it('tallies theft on both axes at once', () => {
    const out = summariseWarDibs({
      claims: [
        claim({ id: 1, claimed_by: HOLDER, target_id: 90100, claimed_at: 1000 }),
        claim({ id: 2, claimed_by: MATE, target_id: 90101, claimed_at: 1000 }),
      ],
      attacks: [
        // MATE finishes HOLDER's target…
        attack({ attacker_id: MATE, defender_id: 90100, started: 1500 }),
        // …and HOLDER finishes MATE's.
        attack({ attacker_id: HOLDER, defender_id: 90101, started: 1500 }),
      ],
      ourFactionId: US,
      warEndTs: 9999,
    })
    const holder = out.members.find((r) => r.member_id === HOLDER)!
    const mate = out.members.find((r) => r.member_id === MATE)!
    expect(holder).toMatchObject({ takenFrom: 1, tookFromOthers: 1 })
    expect(mate).toMatchObject({ takenFrom: 1, tookFromOthers: 1 })
  })

  it('does not count converting your OWN claim as taking from others', () => {
    const out = summariseWarDibs({
      claims: [claim({ claimed_by: HOLDER, target_id: 90100 })],
      attacks: [attack({ attacker_id: HOLDER, defender_id: 90100 })],
      ourFactionId: US, warEndTs: 9999,
    })
    expect(out.members.find((r) => r.member_id === HOLDER)!.tookFromOthers).toBe(0)
  })

  it('does not count a hit on an unclaimed target as taking from others', () => {
    const out = summariseWarDibs({
      claims: [],
      attacks: [attack({ attacker_id: HOLDER, defender_id: 90100 })],
      ourFactionId: US, warEndTs: 9999,
    })
    expect(out.members).toEqual([])
  })

  it('every outcome bucket sums back to the claim count', () => {
    const reasons = ['window', 'spent', 'manual', 'superseded', 'admin', 'reset', null]
    const out = summariseWarDibs({
      claims: reasons.map((r, i) =>
        claim({ id: i + 1, target_id: 90100 + i, release_reason: r })),
      attacks: [],
      ourFactionId: US, warEndTs: 9999,
    })
    const m = out.members.find((r) => r.member_id === HOLDER)!
    // ⚠️ Audited on purpose. A leaderboard whose columns do not add up to the
    // total is one nobody can check, which is the opposite of what a metric
    // with members' names on it needs. Every outcome is mutually exclusive and
    // every claim lands in exactly one.
    const bucketed = m.converted + m.attempted + m.takenFrom + m.noSwing
      + m.outside + m.released + m.hopped + m.overridden + m.boardReset
      + m.open + m.unknown + m.greenMeansGo
    expect(bucketed).toBe(m.claims)
    expect(m.claims).toBe(reasons.length)
  })

  it('sorts by claims descending so the busiest callers read first', () => {
    const out = summariseWarDibs({
      claims: [
        claim({ id: 1, claimed_by: MATE, target_id: 90100 }),
        claim({ id: 2, claimed_by: HOLDER, target_id: 90101 }),
        claim({ id: 3, claimed_by: HOLDER, target_id: 90102 }),
      ],
      attacks: [], ourFactionId: US, warEndTs: 9999,
    })
    expect(out.members.map((m) => m.member_id)).toEqual([HOLDER, MATE])
  })

  it('returns nothing rather than throwing on an empty war', () => {
    expect(summariseWarDibs({ claims: [], attacks: [], ourFactionId: US, warEndTs: 1 }))
      .toMatchObject({ members: [] })
  })
})

describe('warAttacksSettled', () => {
  const settled = (o: any) => warAttacksSettled({
    warEndTs: 1000, newestAttackTs: null, lastSuccessfulSyncTs: null, ...o,
  })

  it('is settled once an attack newer than the war end is stored', () => {
    expect(settled({ newestAttackTs: 1000 })).toBe(true)
    expect(settled({ newestAttackTs: 1001 })).toBe(true)
  })

  it('is NOT settled while the newest attack predates the war end', () => {
    expect(settled({ newestAttackTs: 999 })).toBe(false)
  })

  /**
   * ⚠️ Covers a faction that fought a war and then genuinely did nothing, so
   * `max(started)` sits behind the war's end for days. Needs a SUCCESSFUL sync
   * well after the end — not merely the clock, because a sync that hits a Torn
   * rate limit mid-backlog exits as a success without having caught up.
   */
  it('falls back to a successful sync well after the war ended', () => {
    expect(settled({ lastSuccessfulSyncTs: 1000 + ATTACKS_SETTLE_SECONDS })).toBe(true)
    expect(settled({ lastSuccessfulSyncTs: 1000 + ATTACKS_SETTLE_SECONDS - 1 })).toBe(false)
  })

  it('honours a configured settle period', () => {
    expect(settled({ lastSuccessfulSyncTs: 1060, settleSeconds: 60 })).toBe(true)
  })

  /** ⚠️ A war still running has no end to settle against. */
  it('is never settled for a war with no end', () => {
    expect(settled({ warEndTs: null, newestAttackTs: 99999 })).toBe(false)
  })

  it('is not settled when we know nothing', () => {
    expect(settled({})).toBe(false)
  })
})

/**
 * #935 — a green (Okay + Online) target is outside the dibs system.
 *
 * ⚠️ These are the cases where the obvious implementation accuses somebody who
 * did exactly what the faction asks: hit a target who is at their keyboard
 * before they can fly out.
 */
describe('green targets cannot be stolen (#935)', () => {
  const greenAfterSurfacing = (over = {}) => claim({
    claim_state: 'Hospital', claim_online: 'Offline',
    surfaced_online: true, surfaced_at: 1500, ...over,
  })

  /**
   * ⚠️ THE case. Claimed in hospital while offline — a real reservation — then
   * the target logged in and surfaced online, so a teammate's hit is legitimate.
   * A claim-time-only design calls this a steal.
   */
  it('a teammate finishing a target who surfaced online is NOT a steal', () => {
    const c = classify(greenAfterSurfacing(), [attack({ attacker_id: MATE, started: 1600 })])
    expect(c.outcome).not.toBe(CLAIM_OUTCOMES.taken)
    expect(c.takenBy).toBeNull()
  })

  /**
   * ⚠️ And the offender's tally must not see it either. `took_from_others` is
   * the accusation; clearing the victim while still charging the hitter would
   * be the worst of both outcomes.
   */
  it('does not charge the hitter on the other axis either', () => {
    const out = summariseWarDibs({
      claims: [greenAfterSurfacing({ claimed_by: HOLDER, target_id: 90100 })],
      attacks: [attack({ attacker_id: MATE, name: 'Mate', defender_id: 90100, started: 1600 })],
      ourFactionId: US, warEndTs: 9999,
    })
    const holder = out.members.find((r) => r.member_id === HOLDER)
    const mate = out.members.find((r) => r.member_id === MATE)
    expect(holder?.takenFrom).toBe(0)
    expect(mate?.tookFromOthers ?? 0).toBe(0)
  })

  it('buckets an unconverted green claim as green-means-go, not no-swing', () => {
    // ⚠️ "we really dont care too much about the person that claimed it" — the
    // claim was never a reservation, so "had their window and did not use it"
    // is the wrong reading.
    const c = classify(greenAfterSurfacing({ release_reason: 'window' }), [])
    expect(c.outcome).toBe(CLAIM_OUTCOMES.greenMeansGo)
  })

  it('still credits the holder who converted a green target', () => {
    const c = classify(greenAfterSurfacing(), [attack({ started: 1600 })])
    expect(c.outcome).toBe(CLAIM_OUTCOMES.converted)
    expect(c.holderSwung).toBe(true)
  })

  it('counts a claim taken on an already-green target the same way', () => {
    const c = classify(
      claim({ claim_state: 'Okay', claim_online: 'Online', release_reason: 'window' }), []
    )
    expect(c.outcome).toBe(CLAIM_OUTCOMES.greenMeansGo)
  })

  /** ⚠️ A genuine reservation still produces a steal — the rule must not clear
   *  everything. */
  it('leaves a real steal alone when the target surfaced offline', () => {
    const c = classify(
      claim({ claim_state: 'Hospital', claim_online: 'Offline', surfaced_online: false }),
      [attack({ attacker_id: MATE, started: 1600 })]
    )
    expect(c.outcome).toBe(CLAIM_OUTCOMES.taken)
    expect(c.takenBy).toBe(MATE)
  })

  /**
   * ⚠️ Claims predating #935 keep behaving exactly as before, so promoting this
   * does not retroactively clear a month of recorded steals.
   */
  it('does not change an unobserved claim from the back-history', () => {
    const c = classify(claim(), [attack({ attacker_id: MATE, started: 1600 })])
    expect(c.outcome).toBe(CLAIM_OUTCOMES.taken)
  })

  it('still sums to the claim count with the new bucket', () => {
    const out = summariseWarDibs({
      claims: [
        greenAfterSurfacing({ id: 1, target_id: 90100, release_reason: 'window' }),
        claim({ id: 2, target_id: 90101, release_reason: 'window', surfaced_online: false }),
      ],
      attacks: [], ourFactionId: US, warEndTs: 9999,
    })
    const m = out.members.find((r) => r.member_id === HOLDER)!
    expect(m.greenMeansGo).toBe(1)
    expect(m.noSwing).toBe(1)
    expect(m.greenMeansGo + m.noSwing).toBe(m.claims)
  })
})
