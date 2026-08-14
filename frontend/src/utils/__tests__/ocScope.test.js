// The scope economy (#444 groundwork).
//
// Scope is the resource crimes are spawned with: cost up front, reward only on
// success, bank capped at 100. That asymmetry is what makes "the optimal
// minimum CPR" a real question with a real answer.
import { describe, expect, it } from 'vitest'
import {
  scopeFor, breakEvenSuccess, netScope, scopeVerdict, moneyPerScope, scopeBudget, SCOPE_CAP,
} from '../ocScope'

describe('scopeFor', () => {
  it('matches Torn\'s published cost and reward per assignment', () => {
    expect(scopeFor('introductory')).toMatchObject({ cost: 1, reward: 2 })
    expect(scopeFor('simple')).toMatchObject({ cost: 2, reward: 3 })
    expect(scopeFor('intermediate')).toMatchObject({ cost: 3, reward: 4 })
    expect(scopeFor('advanced')).toMatchObject({ cost: 4, reward: 5 })
    expect(scopeFor('elaborate')).toMatchObject({ cost: 5, reward: 6 })
  })

  it('returns null for an unknown category rather than assuming a cost', () => {
    // A guessed cost would silently enter a budget calculation.
    expect(scopeFor('nonsense')).toBeNull()
    expect(scopeFor(undefined)).toBeNull()
  })
})

describe('breakEvenSuccess', () => {
  it('is cost/reward — the line below which a crime drains scope', () => {
    expect(breakEvenSuccess('introductory')).toBeCloseTo(0.5)
    expect(breakEvenSuccess('simple')).toBeCloseTo(2 / 3)
    expect(breakEvenSuccess('intermediate')).toBeCloseTo(0.75)
    expect(breakEvenSuccess('advanced')).toBeCloseTo(0.8)
    expect(breakEvenSuccess('elaborate')).toBeCloseTo(5 / 6)
  })

  it('rises with difficulty, so harder crimes demand better crews', () => {
    // The reason a single faction-wide minimum CPR is the wrong policy.
    const order = ['introductory', 'simple', 'intermediate', 'advanced', 'elaborate']
      .map(breakEvenSuccess)
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThan(order[i - 1])
  })
})

describe('netScope', () => {
  it('counts the cost whether or not the crime succeeds', () => {
    // 90% on Elaborate: 0.9 × 6 − 5 = +0.4
    expect(netScope('elaborate', 0.9)).toBeCloseTo(0.4)
    // 80% on Elaborate: 0.8 × 6 − 5 = −0.2. Scope-NEGATIVE despite four in five
    // crimes succeeding, which is the counterintuitive part worth surfacing.
    expect(netScope('elaborate', 0.8)).toBeCloseTo(-0.2)
  })

  it('nets only +1 per crime at every tier when success is near certain', () => {
    // Scope income is driven by crime COUNT, money by crime DIFFICULTY. Those
    // pull in opposite directions, which is the core trade-off of #444.
    for (const c of ['introductory', 'simple', 'intermediate', 'advanced', 'elaborate']) {
      expect(netScope(c, 1)).toBeCloseTo(1)
    }
  })
})

describe('scopeVerdict', () => {
  it('calls a crime below its break-even unsustainable', () => {
    const v = scopeVerdict('elaborate', 0.8)
    expect(v.sustainable).toBe(false)
    expect(v.margin).toBeCloseTo(0.8 - 5 / 6)
  })

  it('reports the margin, so barely-viable reads differently from comfortable', () => {
    const barely = scopeVerdict('advanced', 0.81)
    const comfy = scopeVerdict('advanced', 0.97)
    expect(barely.sustainable).toBe(true)
    expect(comfy.sustainable).toBe(true)
    expect(comfy.margin).toBeGreaterThan(barely.margin)
  })

  it('returns null rather than a verdict it cannot support', () => {
    expect(scopeVerdict('elaborate', NaN)).toBeNull()
    expect(scopeVerdict('nonsense', 0.9)).toBeNull()
  })
})

describe('moneyPerScope', () => {
  it('ranks by the scarce input, not by money per run', () => {
    // An Elaborate paying $375M costs 5 scope; a Simple paying $160M costs 2.
    // Per run the Elaborate wins; per scope the Simple does.
    const elaborate = moneyPerScope('elaborate', 375_000_000)
    const simple = moneyPerScope('simple', 160_000_000)
    expect(elaborate).toBeCloseTo(75_000_000)
    expect(simple).toBeCloseTo(80_000_000)
    expect(simple).toBeGreaterThan(elaborate)
  })

  it('refuses to divide by a cost it does not know', () => {
    expect(moneyPerScope('nonsense', 1000)).toBeNull()
    expect(moneyPerScope('simple', NaN)).toBeNull()
  })
})

describe('scopeBudget', () => {
  it('says how many spawns the bank supports', () => {
    expect(scopeBudget(20, 'elaborate')).toMatchObject({ spawnsAffordable: 4, atCap: false })
  })

  it('flags a full bank as waste, not as a healthy surplus', () => {
    // ⚠️ Scope over the cap is discarded, so sitting at 100 loses the daily
    // regeneration. Reporting the balance without this reads as comfort.
    const full = scopeBudget(SCOPE_CAP, 'advanced')
    expect(full.atCap).toBe(true)
    expect(full.wastedPerDay).toBe(1)
    expect(scopeBudget(99, 'advanced').wastedPerDay).toBe(0)
  })
})
