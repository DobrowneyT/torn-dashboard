// Revive chance model (#358).
//
// The formula is reconstructed from Torn's published endpoints, so these tests
// pin the two things we actually know — the endpoints themselves and the
// linear 24h decay — plus the behaviours that protect against showing a
// confidently wrong number.
import { describe, it, expect } from 'vitest'
import {
  MODEL, SCORE_DECAY_SEC,
  baseChance, scorePenalty, countsTowardScore, reviveScore, chanceFromScore,
  bestCaseChance, indexRevivesByTarget, modelError, reviveChanceHue, formatReviveChance,
} from '../reviveChance'

const NOW = 1_770_000_000
const agoH = (h) => NOW - h * 3600
const rev = (over = {}) => ({ target_id: 1, timestamp: agoH(1), result: 'success', ...over })

// The formula as published, verified against the three worked examples in the
// source post. These are the anchors: if a refactor changes any of them, the
// model no longer computes what Torn computes.
//
//   chance = 90 + skill/10 − score × (8 − skill/25)
//   score  = Σ over revives in the last 24h of (1 − t/86400), t in seconds
//
describe('the published formula', () => {
  it('matches the post: score 1.5 against a skill-50 reviver is 86%', () => {
    expect(chanceFromScore(1.5, 50)).toBe(86)
  })

  it('matches the post: score 12 against skill 100 is 52%', () => {
    // The stated point of the example — at high scores the reviver's skill is
    // the difference between viable and not.
    expect(chanceFromScore(12, 100)).toBe(52)
  })

  it('matches the post: score 12 against skill 30 is 11.4%', () => {
    expect(chanceFromScore(12, 30)).toBeCloseTo(11.4, 6)
  })

  it('matches the post: a revive now plus one 12h ago is a score of 1.5', () => {
    const NOW_T = 1_770_000_000
    expect(reviveScore([
      { timestamp: NOW_T, result: 'success' },
      { timestamp: NOW_T - 12 * 3600, result: 'success' },
    ], NOW_T)).toBe(1.5)
  })

  it('is algebraically the published expression across the whole domain', () => {
    // Belt and braces: the implementation decomposes the formula into a base
    // and a per-point penalty, which is easier to read but is a rewrite. This
    // pins the rewrite to the original for every skill/score combination that
    // can occur, not just the three published points.
    const published = (score, skill) => 90 + skill / 10 - score * (8 - skill / 25)
    for (let skill = 0; skill <= 100; skill += 5) {
      for (let score = 0; score <= 25; score += 0.5) {
        const expected = Math.min(100, Math.max(0, published(score, skill)))
        expect(chanceFromScore(score, skill)).toBeCloseTo(expected, 9)
      }
    }
  })
})

describe('the published endpoints', () => {
  it('bases 90% at skill 0 and 100% at skill 100', () => {
    expect(baseChance(0)).toBe(90)
    expect(baseChance(100)).toBe(100)
  })

  it('costs 8% per score point at skill 0, halved at skill 100', () => {
    expect(scorePenalty(0)).toBe(8)
    expect(scorePenalty(100)).toBe(4)
  })

  it('clamps a skill outside 0-100 rather than extrapolating past the endpoints', () => {
    // Skill is capped at 100 in game, but a bad reading must not produce a
    // 110% chance or a negative penalty.
    expect(baseChance(150)).toBe(100)
    expect(baseChance(-5)).toBe(90)
    expect(scorePenalty(150)).toBe(4)
  })

  it('treats a missing skill as zero rather than as maximum', () => {
    // The pessimistic direction: unknown reviver assumed unskilled.
    expect(baseChance(null)).toBe(90)
    expect(baseChance(undefined)).toBe(90)
  })
})

describe('reviveScore', () => {
  it('is zero with no history — a rested target', () => {
    expect(reviveScore([], NOW)).toBe(0)
    expect(reviveScore(undefined, NOW)).toBe(0)
  })

  it('counts a just-landed revive as a full point', () => {
    expect(reviveScore([rev({ timestamp: NOW })], NOW)).toBe(1)
  })

  it('decays linearly — half a point at twelve hours', () => {
    expect(reviveScore([rev({ timestamp: agoH(12) })], NOW)).toBeCloseTo(0.5, 6)
    expect(reviveScore([rev({ timestamp: agoH(6) })], NOW)).toBeCloseTo(0.75, 6)
    expect(reviveScore([rev({ timestamp: agoH(18) })], NOW)).toBeCloseTo(0.25, 6)
  })

  it('drops a revive exactly at the 24h boundary', () => {
    expect(reviveScore([rev({ timestamp: NOW - SCORE_DECAY_SEC })], NOW)).toBe(0)
    expect(reviveScore([rev({ timestamp: agoH(25) })], NOW)).toBe(0)
  })

  it('sums independently decaying revives', () => {
    // Each revive carries its own 24h timer, so this is a sum and not a
    // single clock reset by the newest one.
    const score = reviveScore([
      rev({ timestamp: NOW }),
      rev({ timestamp: agoH(12) }),
      rev({ timestamp: agoH(18) }),
    ], NOW)
    expect(score).toBeCloseTo(1 + 0.5 + 0.25, 6)
  })

  it('clamps a future timestamp to one point instead of over-counting', () => {
    // Our clock and Torn's differ by a second or two; a negative age must not
    // make one revive worth more than one revive.
    expect(reviveScore([rev({ timestamp: NOW + 600 })], NOW)).toBe(1)
  })

  it('ignores rows with an unusable timestamp', () => {
    expect(reviveScore([rev({ timestamp: null }), rev({ timestamp: 'soon' })], NOW)).toBe(0)
  })
})

describe('countsTowardScore', () => {
  it('counts a success', () => {
    expect(countsTowardScore({ result: 'success' })).toBe(true)
  })

  it('does not count a failure — only successful revives add score', () => {
    expect(countsTowardScore({ result: 'failure' })).toBe(false)
    expect(countsTowardScore({ result: 'Failed' })).toBe(false)
  })

  it('counts an unknown result, which is the pessimistic direction', () => {
    // Skipping it would raise the chance we display, and an inflated chance is
    // what gets a reviver paid for a bad attempt.
    expect(countsTowardScore({ result: null })).toBe(true)
    expect(countsTowardScore({})).toBe(true)
  })
})

describe('chanceFromScore', () => {
  it('is the base chance for a rested target', () => {
    expect(chanceFromScore(0, 100)).toBe(100)
    expect(chanceFromScore(0, 0)).toBe(90)
  })

  it('applies the skill-appropriate penalty per point', () => {
    expect(chanceFromScore(1, 100)).toBe(96)
    expect(chanceFromScore(1, 0)).toBe(82)
    expect(chanceFromScore(2.5, 100)).toBe(90)
  })

  it('never goes below zero or above 100', () => {
    expect(chanceFromScore(50, 0)).toBe(0)
    expect(chanceFromScore(-3, 100)).toBe(100)
  })
})

describe('bestCaseChance', () => {
  it('quotes the skill-100 figure', () => {
    expect(bestCaseChance([rev({ timestamp: NOW })], NOW)).toBe(96)
  })

  it('is 100% for a member nobody has revived today', () => {
    // Distinct from "we have no data" — that is null at the call site, and the
    // formatter renders it as a dash, never as 0%.
    expect(bestCaseChance([], NOW)).toBe(100)
  })

  it('recovers as the history ages out', () => {
    const history = [rev({ timestamp: agoH(2) }), rev({ timestamp: agoH(3) })]
    const early = bestCaseChance(history, NOW)
    const later = bestCaseChance(history, NOW + 10 * 3600)
    expect(later).toBeGreaterThan(early)
    // Fully recovered once every contribution has aged past 24h.
    expect(bestCaseChance(history, NOW + 25 * 3600)).toBe(100)
  })
})

describe('indexRevivesByTarget', () => {
  it('groups by target and orders each member newest first', () => {
    const byTarget = indexRevivesByTarget([
      { target_id: 1, timestamp: agoH(5) },
      { target_id: 2, timestamp: agoH(1) },
      { target_id: 1, timestamp: agoH(2) },
    ])
    expect(byTarget.get(1).map((r) => r.timestamp)).toEqual([agoH(2), agoH(5)])
    expect(byTarget.get(2)).toHaveLength(1)
  })

  it('drops rows with no target rather than bucketing them under NaN', () => {
    expect(indexRevivesByTarget([{ timestamp: NOW }, null]).size).toBe(0)
  })

  it('tolerates an absent list', () => {
    expect(indexRevivesByTarget(undefined).size).toBe(0)
  })
})

describe('modelError', () => {
  // Every scraped revive carries the chance Torn actually displayed, so the
  // inferred interpolation is checkable rather than merely plausible.
  it('reports zero error when observations match the model', () => {
    // A rested target revived by a skill-100 reviver: Torn should have shown
    // 100%, and a second revive 12h later should have shown 100 - 0.5*4 = 98.
    const err = modelError([
      { target_id: 1, timestamp: agoH(24), reviver_skill: 100, success_chance: 100, result: 'success' },
      { target_id: 1, timestamp: agoH(12), reviver_skill: 100, success_chance: 98, result: 'success' },
    ])
    expect(err.samples).toBe(2)
    expect(err.meanAbsError).toBeCloseTo(0, 6)
    expect(err.bias).toBeCloseTo(0, 6)
  })

  it('excludes a revive from its own score', () => {
    // The displayed chance is what the reviver saw BEFORE landing it. Counting
    // it would make every first revive look like a 4-point miss.
    const err = modelError([
      { target_id: 1, timestamp: NOW, reviver_skill: 100, success_chance: 100, result: 'success' },
    ])
    expect(err.meanAbsError).toBeCloseTo(0, 6)
  })

  it('surfaces a systematic offset as signed bias, not just noise', () => {
    // If Torn's real curve sits below ours, every prediction overshoots and
    // the bias stays positive — the signature of a wrong shape rather than
    // scatter.
    const err = modelError([
      { target_id: 1, timestamp: agoH(20), reviver_skill: 100, success_chance: 95, result: 'success' },
      { target_id: 2, timestamp: agoH(10), reviver_skill: 100, success_chance: 95, result: 'success' },
    ])
    expect(err.bias).toBeCloseTo(5, 6)
    expect(err.meanAbsError).toBeCloseTo(5, 6)
  })

  it('skips observations with no reviver skill instead of guessing one', () => {
    // A guessed skill would put our own assumption into the error we use to
    // judge the assumption.
    expect(modelError([
      { target_id: 1, timestamp: NOW, reviver_skill: null, success_chance: 90 },
    ])).toBeNull()
  })

  it('returns null with nothing to check', () => {
    expect(modelError([])).toBeNull()
    expect(modelError(undefined)).toBeNull()
  })
})

describe('presentation', () => {
  it('renders a dash for no data and never a zero', () => {
    // #351: an absent reading is not a low reading.
    expect(formatReviveChance(null)).toBe('—')
    expect(formatReviveChance(undefined)).toBe('—')
    expect(formatReviveChance(NaN)).toBe('—')
    expect(formatReviveChance(0)).toBe('0%')
  })

  it('rounds to whole percent', () => {
    expect(formatReviveChance(96.4)).toBe('96%')
    expect(formatReviveChance(100)).toBe('100%')
  })

  it('ramps hue across the band that actually occurs', () => {
    expect(reviveChanceHue(100)).toBe(142)
    expect(reviveChanceHue(60)).toBe(0)
    // Everything below 60 is already as red as it gets, rather than
    // compressing the useful range into a sliver of the ramp.
    expect(reviveChanceHue(20)).toBe(0)
    expect(reviveChanceHue(80)).toBe(71)
  })

  it('has no hue for a missing reading', () => {
    expect(reviveChanceHue(null)).toBeNull()
    expect(reviveChanceHue(undefined)).toBeNull()
  })
})

describe('MODEL constants stay in one place', () => {
  it('exposes the endpoints the formula interpolates between', () => {
    // If Torn changes these, this is the single edit — and modelError() is how
    // we would find out.
    expect(MODEL).toEqual({
      baseAtSkillZero: 90, baseAtSkillMax: 100,
      penaltyAtSkillZero: 8, penaltyAtSkillMax: 4, skillMax: 100,
    })
    expect(SCORE_DECAY_SEC).toBe(86400)
  })
})
