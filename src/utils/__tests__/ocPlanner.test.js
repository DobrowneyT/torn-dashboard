import { describe, it, expect } from 'vitest'
import {
  makeCategoryResolver,
  advancedCrimeNames,
  qualifiesForAdvanced,
  maxCategoryForMember,
  buildBase,
  selectAvailable,
  selectPausingSlots,
  buildSpawnPlan,
} from '../ocPlanner'

const CATEGORIES = {
  introductory: { difficulty: [1, 2], scopeCost: 1, plannable: false },
  simple: { difficulty: [3, 4], scopeCost: 2, plannable: true },
  intermediate: { difficulty: [5, 6], scopeCost: 3, plannable: true },
  advanced: { difficulty: [7, 8], scopeCost: 4, plannable: true },
  elaborate: { difficulty: [8, 10], scopeCost: 5, plannable: false },
}

const SCENARIOS = {
  'Break the Bank': { category: 'advanced', difficulty: 8, participants: 6 },
  'Clinical Precision': { category: 'advanced', difficulty: 8, participants: 4 },
  'Blast from the Past': { category: 'advanced', difficulty: 7, participants: 6 },
  'Bidding War': { category: 'intermediate', difficulty: 6, participants: 6 },
  'Stacking the Deck': { category: 'elaborate', difficulty: 8, participants: 4 },
  'Market Forces': { category: 'simple', difficulty: 3, participants: 5 },
}

const CPR_REQS = {
  'Break the Bank': { difficulty: 8, positions: { Robber: 60, 'Thief #2': 65 } },
  'Clinical Precision': { difficulty: 8, positions: { Imitator: 70 } },
  'Blast from the Past': { difficulty: 7, positions: { Bomber: 75 } },
  'Bidding War': { difficulty: 6, positions: { Driver: 75 } },
}

const HOUR = 3600
const categoryOf = makeCategoryResolver({ scenarios: SCENARIOS, categories: CATEGORIES })

describe('makeCategoryResolver', () => {
  it('resolves by name first (Lv8 splits Advanced vs Elaborate)', () => {
    expect(categoryOf('Break the Bank', 8)).toBe('advanced')
    expect(categoryOf('Stacking the Deck', 8)).toBe('elaborate')
  })
  it('falls back to difficulty for unknown names, preferring Advanced at Lv8', () => {
    expect(categoryOf('Some New Lv8 Crime', 8)).toBe('advanced')
    expect(categoryOf('Some New Lv5 Crime', 5)).toBe('intermediate')
    expect(categoryOf('Some New Lv10 Crime', 10)).toBe('elaborate')
  })
})

describe('advancedCrimeNames + qualifiesForAdvanced', () => {
  const advancedNames = advancedCrimeNames({ scenarios: SCENARIOS, cprRequirements: CPR_REQS })

  it('lists only Advanced-category crimes present in cprRequirements', () => {
    expect(advancedNames.sort()).toEqual(['Blast from the Past', 'Break the Bank', 'Clinical Precision'])
  })
  it('passes when a member clears ≥1 Advanced position', () => {
    const cpr = { 'Break the Bank||Robber': 62 }
    expect(qualifiesForAdvanced(cpr, { cprRequirements: CPR_REQS, advancedNames })).toBe(true)
  })
  it('fails when no Advanced position is met (Intermediate CPR does not count)', () => {
    const cpr = { 'Break the Bank||Robber': 55, 'Bidding War||Driver': 99 }
    expect(qualifiesForAdvanced(cpr, { cprRequirements: CPR_REQS, advancedNames })).toBe(false)
  })
})

describe('maxCategoryForMember', () => {
  it('maps tiers to categories with the T3 CPR split', () => {
    expect(maxCategoryForMember(1, false)).toBe('advanced')
    expect(maxCategoryForMember(2, false)).toBe('advanced')
    expect(maxCategoryForMember(3, true)).toBe('advanced')
    expect(maxCategoryForMember(3, false)).toBe('intermediate')
    expect(maxCategoryForMember(4, false)).toBe('intermediate')
    expect(maxCategoryForMember(5, false)).toBe('simple')
    expect(maxCategoryForMember(6, false)).toBe('simple')
    expect(maxCategoryForMember(0, true)).toBeNull()
  })
})

describe('buildBase + selects + buildSpawnPlan', () => {
  const now = 1_000_000

  const crimes = [
    // Recruiting Advanced (Break the Bank), pauses in 6h, 2 open seats → counts as 1 feed.
    {
      id: 1, name: 'Break the Bank', difficulty: 8, status: 'Recruiting',
      planning_at: now - HOUR, ready_at: now + 6 * HOUR,
      slots: [
        { position: 'Robber', user: { id: 100 } },
        { position: 'Thief #1', user: null },
        { position: 'Thief #2', user: null },
      ],
    },
    // Empty Intermediate (Bidding War) → always a feed, regardless of window.
    {
      id: 2, name: 'Bidding War', difficulty: 6, status: 'Recruiting',
      planning_at: null, expired_at: now + 40 * HOUR,
      slots: [{ position: 'Driver', user: null }, { position: 'Robber #1', user: null }],
    },
    // Recruiting Advanced that pauses far away (30h) → excluded at 12h/24h.
    {
      id: 3, name: 'Clinical Precision', difficulty: 8, status: 'Recruiting',
      planning_at: now - HOUR, ready_at: now + 30 * HOUR,
      slots: [{ position: 'Imitator', user: { id: 101 } }, { position: 'Hacker', user: null }],
    },
    // Planning Advanced executing in 6h → frees an Advanced + a Simple member.
    {
      id: 4, name: 'Blast from the Past', difficulty: 7, status: 'Planning',
      ready_at: now + 6 * HOUR,
      slots: [{ position: 'Bomber', user: { id: 200 } }, { position: 'Hacker', user: { id: 300 } }],
    },
  ]

  // Category pre-assigned per member (the view does the T3 CPR check).
  const currentMembers = [
    { id: 100, name: 'Alice', tier: 1, category: 'advanced' },
    { id: 101, name: 'Bo', tier: 2, category: 'advanced' },
    { id: 200, name: 'Cara', tier: 1, category: 'advanced' }, // coming out 6h
    { id: 300, name: 'Dan', tier: 5, category: 'simple' },    // coming out 6h
    { id: 400, name: 'Eve', tier: 2, category: 'advanced' },  // free now
    { id: 500, name: 'Finn', tier: 0, category: null },       // free now, review
  ]
  const memberCategory = { 100: 'advanced', 101: 'advanced', 200: 'advanced', 300: 'simple', 400: 'advanced', 500: null }
  const memberNames = { 100: 'Alice', 101: 'Bo', 200: 'Cara', 300: 'Dan', 400: 'Eve', 500: 'Finn' }
  const memberTiers = { 100: 1, 101: 2, 200: 1, 300: 5, 400: 2, 500: 0 }

  const base = buildBase({ crimes, currentMembers, memberCategory, memberNames, memberTiers, categoryOf })

  it('classifies pausing crimes by category and frees planning occupants', () => {
    expect(base.pausingCrimes.map((c) => c.category).sort()).toEqual(['advanced', 'advanced', 'intermediate'])
    expect(base.freeing.map((f) => f.id).sort()).toEqual(['200', '300'])
    expect(base.notInOc.map((m) => m.name)).toEqual(['Eve', 'Finn']) // 400, 500 not in any OC
  })

  it('counts each pausing crime as ONE feed, gated by the crimes window', () => {
    const p12 = selectPausingSlots(base, { now, crimesHorizonSecs: 12 * HOUR })
    // crime 1 (advanced, 6h) + crime 2 (intermediate, empty); crime 3 (30h) excluded.
    expect(p12.pausingByCategory).toEqual({ advanced: 1, intermediate: 1 })
    expect(p12.feedQueue[0].isEmpty).toBe(true) // empty crime is most urgent
  })

  it('projects spawn = member surplus and crewsShort = crime surplus', () => {
    const avail = selectAvailable(base, { now, memberHorizonSecs: 24 * HOUR })
    // Available advanced: Eve(free) + Cara(coming) = 2; simple: Dan(coming) = 1; review: Finn.
    expect(avail.membersByCategory).toEqual({ advanced: 2, simple: 1 })
    expect(avail.reviewCount).toBe(1)

    const pausing = selectPausingSlots(base, { now, crimesHorizonSecs: 24 * HOUR })
    const plan = buildSpawnPlan({ membersByCategory: avail.membersByCategory, pausingByCategory: pausing.pausingByCategory, categories: CATEGORIES })

    expect(plan.plannable).toEqual(['advanced', 'intermediate', 'simple']) // hardest first
    // advanced: 2 members − 1 pausing = spawn 1 (scope 4). intermediate: 0 − 1 = crews short 1.
    expect(plan.rows.advanced).toMatchObject({ members: 2, pausing: 1, scenariosToSpawn: 1, crewsShort: 0, scopeCost: 4 })
    expect(plan.rows.intermediate).toMatchObject({ members: 0, pausing: 1, scenariosToSpawn: 0, crewsShort: 1 })
    expect(plan.rows.simple).toMatchObject({ members: 1, pausing: 0, scenariosToSpawn: 1, scopeCost: 2 })
    expect(plan.scenariosTotal).toBe(2)
    expect(plan.scopeTotal).toBe(6)
    expect(plan.crewsShortTotal).toBe(1)
  })

  it('shrinks availability under a short member window without touching crimes', () => {
    const avail = selectAvailable(base, { now, memberHorizonSecs: 3 * HOUR })
    // Cara/Dan come out in 6h → excluded at 3h; only Eve (free) remains.
    expect(avail.comingOutCount).toBe(0)
    expect(avail.membersByCategory).toEqual({ advanced: 1 })
  })
})
