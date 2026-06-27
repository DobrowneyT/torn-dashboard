import { describe, it, expect } from 'vitest'
import {
  inferCrimeTierMap,
  buildPositionTierMap,
  makeCrimeTierResolver,
  slotTierForOpenSlots,
  buildPlannerSummary,
  selectOpenSlots,
  planForHorizon,
} from '../ocPlanner'

const TIER_REQS = {
  1: [{ crime: 'Break the Bank', role: 'Muscle #3', minCpr: 65 }],
  2: [
    { crime: 'Break the Bank', role: 'Robber', minCpr: 60 },
    { crime: 'Blast from the Past', role: 'Bomber', minCpr: 75 },
  ],
  3: [{ crime: 'Break the Bank', role: 'Thief #2', minCpr: 65 }, { crime: 'Bidding War', role: 'Driver', minCpr: 75 }],
  4: [{ crime: 'Bidding War', role: 'Robber #1', minCpr: 70 }],
  5: [{ level: 5, role: 'Average', minCpr: 75, isAverage: true }],
}

const HOUR = 3600
const resolveTier = makeCrimeTierResolver({ tierRequirements: TIER_REQS })
const positionTierMap = buildPositionTierMap(TIER_REQS)

describe('inferCrimeTierMap', () => {
  it('maps each crime to the lowest (strongest) tier that references it', () => {
    const map = inferCrimeTierMap(TIER_REQS)
    expect(map['Break the Bank']).toBe(1)
    expect(map['Blast from the Past']).toBe(2)
    expect(map['Bidding War']).toBe(3)
  })
})

describe('buildPositionTierMap', () => {
  it('keys per crime+role', () => {
    expect(positionTierMap['Break the Bank||Muscle #3']).toBe(1)
    expect(positionTierMap['Break the Bank||Robber']).toBe(2)
    expect(positionTierMap['Break the Bank||Thief #2']).toBe(3)
  })
})

describe('slotTierForOpenSlots (weakest = highest number)', () => {
  const crime = {
    name: 'Break the Bank',
    difficulty: 8,
    slots: [
      { position: 'Muscle #3', user: { id: 1 } }, // filled (T1) — ignored
      { position: 'Robber', user: null }, // open, T2
      { position: 'Thief #2', user: null }, // open, T3
    ],
  }
  it('picks the highest-numbered tier among OPEN positions', () => {
    expect(slotTierForOpenSlots(crime, { positionTierMap, resolveTier })).toBe(3)
  })
  it('can pick strongest when preferWeakest=false', () => {
    expect(slotTierForOpenSlots(crime, { positionTierMap, resolveTier, preferWeakest: false })).toBe(2)
  })
  it('falls back to the crime-level tier when no open position maps', () => {
    const unmapped = { name: 'Break the Bank', difficulty: 8, slots: [{ position: 'Muscle #2', user: null }] }
    expect(slotTierForOpenSlots(unmapped, { positionTierMap, resolveTier })).toBe(1) // crime-level
  })
})

describe('buildPlannerSummary + selectOpenSlots + planForHorizon', () => {
  const now = 1_000_000

  const crimes = [
    // Recruiting Break the Bank, pauses in 6h. Open: Robber(T2), Thief #2(T3)
    // → counts as 1 slot at T3 (weakest).
    {
      id: 1,
      name: 'Break the Bank',
      difficulty: 8,
      status: 'Recruiting',
      planning_at: now - HOUR,
      ready_at: now + 6 * HOUR,
      slots: [
        { position: 'Muscle #3', user: { id: 100 } },
        { position: 'Robber', user: null },
        { position: 'Thief #2', user: null },
      ],
    },
    // Empty Bidding War (no planning_at) → always counts. Open: Driver(T3),
    // Robber #1(T4) → 1 slot at T4 (weakest).
    {
      id: 2,
      name: 'Bidding War',
      difficulty: 6,
      status: 'Recruiting',
      planning_at: null,
      expired_at: now + 40 * HOUR,
      slots: [
        { position: 'Driver', user: null },
        { position: 'Robber #1', user: null },
      ],
    },
    // Recruiting crime that pauses far in the future (30h) → excluded at 12h/24h.
    {
      id: 3,
      name: 'Blast from the Past',
      difficulty: 7,
      status: 'Recruiting',
      planning_at: now - HOUR,
      ready_at: now + 30 * HOUR,
      slots: [
        { position: 'Bomber', user: { id: 101 } },
        { position: 'Hacker', user: null },
      ],
    },
    // Planning crime executing in 6h → frees a T3 and a T4 member.
    {
      id: 4,
      name: 'Bidding War',
      difficulty: 6,
      status: 'Planning',
      ready_at: now + 6 * HOUR,
      slots: [
        { position: 'Driver', user: { id: 200 } },
        { position: 'Robber #1', user: { id: 300 } },
      ],
    },
  ]

  const currentMembers = [
    { id: 100, name: 'Alice', tier: 1 },
    { id: 101, name: 'Bo', tier: 2 },
    { id: 200, name: 'Cara', tier: 3 }, // coming out in 6h
    { id: 300, name: 'Dan', tier: 4 }, // coming out in 6h
    { id: 400, name: 'Eve', tier: 3 }, // free now
    { id: 500, name: 'Finn', tier: 0 }, // free now, review
  ]
  const memberTiers = { 100: 1, 101: 2, 200: 3, 300: 4, 400: 3, 500: 0 }
  const memberNames = { 100: 'Alice', 101: 'Bo', 200: 'Cara', 300: 'Dan', 400: 'Eve', 500: 'Finn' }

  const summary = buildPlannerSummary({
    crimes, currentMembers, memberTiers, memberNames, resolveTier, positionTierMap,
  })

  it('records each recruiting/empty crime once with its weakest open tier', () => {
    const byId = Object.fromEntries(summary.pausingCrimes.map((c) => [c.id, c]))
    expect(byId[1].slotTier).toBe(3) // BtB weakest open = Thief #2
    expect(byId[2].slotTier).toBe(4) // Bidding War weakest open = Robber #1
    expect(byId[2].isEmpty).toBe(true)
    expect(byId[3].slotTier).toBe(2) // Blast: only Hacker open, unmapped → crime-level T2
  })

  it('gates open slots by the pause horizon (empty always; far-future excluded)', () => {
    const open12 = selectOpenSlots(summary.pausingCrimes, { now, pauseHorizonSecs: 12 * HOUR })
    // crime 1 (pauses 6h, T3) + crime 2 (empty, T4); crime 3 (30h) excluded.
    expect(open12.openSlotsByTier).toEqual({ 3: 1, 4: 1 })
    expect(open12.openSlotsTotal).toBe(2)

    const open24 = selectOpenSlots(summary.pausingCrimes, { now, pauseHorizonSecs: 24 * HOUR })
    expect(open24.openSlotsTotal).toBe(2) // crime 3 still beyond 24h
  })

  it('counts a multi-slot crime as exactly one slot', () => {
    const open = selectOpenSlots(summary.pausingCrimes, { now, pauseHorizonSecs: 24 * HOUR })
    const totalOpenPositions = summary.pausingCrimes.reduce((n, c) => n + c.openCount, 0)
    expect(totalOpenPositions).toBeGreaterThan(open.openSlotsTotal) // collapsed to 1 each
  })

  it('projects spawn need from independent member + pause horizons', () => {
    const open = selectOpenSlots(summary.pausingCrimes, { now, pauseHorizonSecs: 12 * HOUR })
    const plan = planForHorizon(summary, open, { now, memberHorizonSecs: 24 * HOUR })

    // Available: free now Eve(T3), Finn(review); coming ≤24h Cara(T3), Dan(T4).
    expect(plan.availableByTier).toEqual({ 3: 2, 4: 1, review: 1 })
    // Open slots: T3:1, T4:1 → T3 need = 2−1 = 1, T4 need = 1−1 = 0.
    expect(plan.spawnNeedByTier).toEqual({ 1: 0, 2: 0, 3: 1, 4: 0, 5: 0, 6: 0 })
    expect(plan.spawnTotal).toBe(1)
    expect(plan.reviewCount).toBe(1)
  })

  it('member horizon shrinks availability without touching open slots', () => {
    const open = selectOpenSlots(summary.pausingCrimes, { now, pauseHorizonSecs: 24 * HOUR })
    const plan = planForHorizon(summary, open, { now, memberHorizonSecs: 3 * HOUR })
    // Cara/Dan come out in 6h → excluded at 3h. Only free-now members remain.
    expect(plan.comingOutCount).toBe(0)
    expect(plan.availableByTier).toEqual({ 3: 1, review: 1 })
  })
})
