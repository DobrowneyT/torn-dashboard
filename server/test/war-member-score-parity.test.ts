// ⚠️ The page and the server score a member's war SEPARATELY, and this is the
// test that stops them drifting (#943).
//
// The duplication is forced for the same reason as the War Overview summary:
// the payout sheet recomputes in the browser as prices are typed, and the
// Discord bot cannot run browser JS. So "what counts as a scoring hit" exists
// twice — `frontend/src/utils/warPayoutCalculations.js` and
// `server/src/warMemberScore.ts`.
//
// ⚠️ These numbers go into a PERMANENT per-member post that leadership reads,
// beside a payout sheet computed by the other implementation. A drift here is
// not a cosmetic mismatch; it is an argument about money with two sources of
// truth and no way to tell which is wrong.
import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain JS from the frontend workspace, no type declarations
import * as web from '../../frontend/src/utils/warPayoutCalculations.js'
import {
  scoreMemberWar, BONUS_HIT_CHAINS, SCORING_RESULTS, BONUS_HIT_CAP,
} from '../src/warMemberScore.js'

// ⚠️ Forge's id, and it must stay that way. `calculateCutoffScores` calls
// `getFactionId()`, which outside a browser falls through to the pre-bootstrap
// fallback in `frontend/src/config.js` — 10739. Changing this number makes the
// page's half of the comparison silently score nothing, and a parity test that
// compares zero to zero passes while proving nothing.
const US = 10739
const OTHER = 20747
const ME = 101
const SOMEBODY_ELSE = 202

const RESULTS = [
  'Attacked', 'Mugged', 'Hospitalized', 'Arrested', 'Looted', 'Special',
  'Assist', 'Lost', 'Timeout', 'Interrupted', 'Stalemate', 'Escape',
  'SomethingTornAddedLater', '',
]
/** Chain lengths either side of every bonus boundary, plus non-bonus ones. */
const CHAINS = [0, 1, 9, 10, 11, 24, 25, 99, 100, 250, 999, 1000, 10000]

/** A deterministic spread that touches every branch in both implementations. */
function fixture() {
  const attacks: any[] = []
  let id = 1
  for (const result of RESULTS) {
    for (const chain of CHAINS) {
      for (const [attacker, faction] of [
        [ME, US], [ME, OTHER], [SOMEBODY_ELSE, US],
      ] as Array<[number, number]>) {
        for (const ranked of [true, false]) {
          attacks.push({
            attack_id: id,
            started: 1_790_000_000 + id,
            attacker_id: attacker,
            attacker_faction_id: faction,
            defender_id: 900 + (id % 5),
            defender_faction_id: faction === US ? OTHER : US,
            result,
            // ⚠️ Deliberately varied, including values ABOVE and BELOW the cap,
            // so a bonus hit worth less than 10 is not silently raised to 10 by
            // a `Math.max` written where a `Math.min` belongs.
            respect_gain: (id % 17) + (id % 3) * 0.25,
            chain,
            is_ranked_war: ranked,
          })
          id += 1
        }
      }
    }
  }
  return attacks
}

/** The page's totals for one member: normalised = pre + post. */
function pageScore(attacks: any[], memberId: number) {
  // ⚠️ A cutoff far in the future, so everything lands pre-cutoff and the two
  // buckets sum to the whole war. The cutoff split is a payout concern with no
  // meaning in a member's report.
  const scores = web.calculateCutoffScores(attacks, Number.MAX_SAFE_INTEGER)
  const s = scores.get(memberId)
  if (!s) return null
  const normalised = s.preCutoffScore + s.postCutoffScore
  return {
    normalised: round2(normalised),
    bonus_reduction: round2(s.bonusReduction),
    raw: round2(normalised + s.bonusReduction),
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100

describe('the constants are the same constants', () => {
  it('⚠️ BONUS_HIT_CHAINS equals the page\'s BONUS_HITS', () => {
    // Not "looks similar" — identical. A chain length in one set and not the
    // other caps a hit on one side only.
    expect([...BONUS_HIT_CHAINS].sort((a, b) => a - b))
      .toEqual([...web.BONUS_HITS].sort((a: number, b: number) => a - b))
  })

  it('⚠️ SCORING_RESULTS equals the page\'s WIN_RESULTS, Special excluded', () => {
    expect([...SCORING_RESULTS].sort()).toEqual([...web.WIN_RESULTS].sort())
    expect(SCORING_RESULTS.has('Special')).toBe(false)
  })

  it('caps at 10, the figure every payout has used', () => {
    expect(BONUS_HIT_CAP).toBe(10)
  })
})

describe('scoring one member over the same rows', () => {
  const attacks = fixture()

  it('agrees with the page on raw, normalised and the reduction', () => {
    const mine = scoreMemberWar(attacks, ME, US)
    const theirs = pageScore(attacks, ME)
    expect(theirs).not.toBeNull()
    expect(mine).not.toBeNull()
    expect({
      raw: mine!.raw, normalised: mine!.normalised, bonus_reduction: mine!.bonus_reduction,
    }).toEqual(theirs)
  })

  it('agrees for a second member in the same ledger', () => {
    // ⚠️ Two members, one fixture: a bug that leaked every row into every
    // member's total would still pass a single-member comparison, because both
    // implementations would leak identically.
    const mine = scoreMemberWar(attacks, SOMEBODY_ELSE, US)
    expect({
      raw: mine!.raw, normalised: mine!.normalised, bonus_reduction: mine!.bonus_reduction,
    }).toEqual(pageScore(attacks, SOMEBODY_ELSE))
    // ...and they are genuinely different people with different totals.
    expect(mine!.raw).not.toBe(scoreMemberWar(attacks, ME, US)!.raw)
  })

  it('the reduction is real in this fixture, not an accidental zero', () => {
    // ⚠️ A parity test over rows that happen to contain no cappable bonus hit
    // compares 0 to 0 and proves nothing about the cap.
    const mine = scoreMemberWar(attacks, ME, US)!
    expect(mine.bonus_hits).toBeGreaterThan(0)
    expect(mine.bonus_reduction).toBeGreaterThan(0)
    expect(mine.raw).toBeGreaterThan(mine.normalised)
  })
})

describe('⚠️ a real zero is a zero; only an empty ledger is null', () => {
  // The first version returned null whenever the member had no hits, so
  // somebody who genuinely scored nothing was published as "Score · not
  // recorded". MonChoon: "if they had a 0, we should just show 0, not recorded
  // makes it seem like a weird data loss issue."
  //
  // The discriminator is the LEDGER. No attack rows at all → we cannot say
  // anything about anybody. Rows present and this member absent from them →
  // they scored nothing, and saying so is the point.

  it('an EMPTY ledger is null — we know nothing about anyone', () => {
    expect(scoreMemberWar([], ME, US)).toBeNull()
  })

  it('a member absent from a POPULATED ledger scored zero', () => {
    const s = scoreMemberWar(fixture(), 999_999, US)
    expect(s).not.toBeNull()
    expect(s!.raw).toBe(0)
    expect(s!.hits).toBe(0)
  })

  it('a member whose only hits were losses scored zero', () => {
    const attacks = [{
      attacker_id: ME, attacker_faction_id: US, result: 'Lost',
      respect_gain: 0, chain: 5, is_ranked_war: true,
    }]
    expect(scoreMemberWar(attacks, ME, US)!.raw).toBe(0)
  })

  it('a member whose hits were all outside the ranked war scored zero', () => {
    const attacks = [{
      attacker_id: ME, attacker_faction_id: US, result: 'Hospitalized',
      respect_gain: 12.5, chain: 3, is_ranked_war: false,
    }]
    expect(scoreMemberWar(attacks, ME, US)!.raw).toBe(0)
  })

  it('refuses a non-numeric member or faction rather than scoring everything', () => {
    expect(scoreMemberWar(fixture(), 'not-a-number', US)).toBeNull()
    expect(scoreMemberWar(fixture(), ME, 'not-a-number')).toBeNull()
  })
})

describe('the cap itself', () => {
  const hit = (over: Record<string, unknown>) => ({
    attacker_id: ME, attacker_faction_id: US, result: 'Attacked', is_ranked_war: true, ...over,
  })

  it('caps a bonus hit worth more than 10', () => {
    const s = scoreMemberWar([hit({ respect_gain: 85.5, chain: 100 })], ME, US)!
    expect(s.raw).toBe(85.5)
    expect(s.normalised).toBe(10)
    expect(s.bonus_reduction).toBe(75.5)
  })

  it('⚠️ does NOT raise a bonus hit worth less than 10', () => {
    const s = scoreMemberWar([hit({ respect_gain: 4.25, chain: 100 })], ME, US)!
    expect(s.normalised).toBe(4.25)
    expect(s.bonus_reduction).toBe(0)
  })

  it('leaves a non-bonus hit alone however large', () => {
    const s = scoreMemberWar([hit({ respect_gain: 99.75, chain: 11 })], ME, US)!
    expect(s.raw).toBe(99.75)
    expect(s.normalised).toBe(99.75)
    expect(s.bonus_reduction).toBe(0)
  })

  it('a chain of 0 is not a bonus hit', () => {
    const s = scoreMemberWar([hit({ respect_gain: 50, chain: 0 })], ME, US)!
    expect(s.bonus_hits).toBe(0)
    expect(s.normalised).toBe(50)
  })
})
