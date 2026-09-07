import { describe, it, expect, vi } from 'vitest'
import {
  calculateTimeSpent,
  getWeekRangeFromDate,
  getCurrentWeekRange,
  getPreviousWeekRange,
  formatDateUTC,
  parseDateAsUTC,
  calculatePayouts,
  formatCurrency,
  formatCurrencyShort,
  exportPayoutFilename,
  weekCrimeRowsToMap,
  buildHistoricalWeekCrimesData,
  getCrimeStats,
  PAYOUT_MODES,
  DEFAULT_PAYOUT_MODE,
  factionUsesTiers,
  bankedTimeByMember,
  mergeIntervalSeconds,
} from '../payoutCalculations.js'

// Suppress console.log in tests
vi.spyOn(console, 'log').mockImplementation(() => {})

// ─── Helper ────────────────────────────────────────────────────────
const HOUR = 3600
const DAY = 86400

/**
 * Build a minimal crimesData + membersData fixture for calculatePayouts.
 */
function makeCrimeFixture({
  crimeId = 'c1',
  status = 'Successful',
  executedAt,
  createdAt,
  difficulty = 5,
  rewardsMoney = 1_000_000,
  itemRewardValue = 0,
  itemCostValue = 0,
  slots = [],
} = {}) {
  return {
    crimes: {
      [crimeId]: {
        crime_id: crimeId,
        name: 'Test Crime',
        status,
        executed_at: executedAt,
        created_at: createdAt || executedAt - DAY,
        difficulty,
        total_slots: slots.length,
        filled_slots: slots.filter(s => s.user).length,
        rewards: { money: rewardsMoney },
        item_reward_value: itemRewardValue,
        item_cost_value: itemCostValue,
        slots,
        reward_items: [],
        required_items: [],
      },
    },
  }
}

function makeSlot(userId, joinedAt, name = 'TestUser') {
  return {
    position: 'Muscle',
    checkpoint_pass_rate: 85,
    user: { id: userId, name, joined_at: joinedAt },
  }
}

function makeMembers(ids, tier = 6) {
  const members = {}
  for (const id of ids) {
    members[id.toString()] = {
      member_id: id.toString(),
      name: `User${id}`,
      tier,
      is_current: true,
    }
  }
  return { members }
}

// ─── getWeekRangeFromDate ──────────────────────────────────────────
describe('bankedTimeByMember (#168)', () => {
  const seg = (member_id, crime_id, joined_at, left_at, crime_name = 'C') =>
    ({ member_id, crime_id, joined_at, left_at, crime_name })

  it('sums each member\'s left-early time, clipped to the window, with a per-crime breakdown', () => {
    const from = 1000, to = 2000
    const banked = bankedTimeByMember([
      seg('7', '100', 1100, 1300, 'Break the Bank'), // fully inside → 200
      seg('7', '101', 900, 1200, 'Pet Store'),       // straddles start → clip to [1000,1200] = 200
    ], from, to)
    expect(banked['7'].seconds).toBe(400)
    expect(banked['7'].crimes).toEqual([
      { crime_id: '100', crime_name: 'Break the Bank', seconds: 200 },
      { crime_id: '101', crime_name: 'Pet Store', seconds: 200 },
    ])
  })

  it('clips a stint that runs past the window end', () => {
    const banked = bankedTimeByMember([seg('9', '200', 1800, 2500)], 1000, 2000)
    expect(banked['9'].seconds).toBe(200) // [1800, 2000]
  })

  it('ignores stints entirely outside the window', () => {
    expect(bankedTimeByMember([seg('9', '200', 100, 500)], 1000, 2000)).toEqual({})
    expect(bankedTimeByMember([seg('9', '200', 3000, 4000)], 1000, 2000)).toEqual({})
  })

  it('keeps members separate and tolerates empty input', () => {
    const banked = bankedTimeByMember([
      seg('7', '100', 1000, 1500),
      seg('8', '100', 1000, 1200),
    ], 1000, 2000)
    expect(banked['7'].seconds).toBe(500)
    expect(banked['8'].seconds).toBe(200)
    expect(bankedTimeByMember([], 1000, 2000)).toEqual({})
    expect(bankedTimeByMember(undefined, 1000, 2000)).toEqual({})
  })
})

describe('mergeIntervalSeconds (#262)', () => {
  it('sums disjoint intervals', () => {
    expect(mergeIntervalSeconds([[0, 100], [200, 350]])).toBe(250)
  })

  it('collapses overlapping intervals so time is not double-counted', () => {
    // Two intervals sharing wall-clock time: naive sum 100+80=180, real span 120.
    expect(mergeIntervalSeconds([[0, 100], [80, 120]])).toBe(120)
  })

  it('absorbs a fully-nested interval', () => {
    // A member can only be in one OC at a time — an inner stint adds nothing.
    expect(mergeIntervalSeconds([[0, 300], [100, 200]])).toBe(300)
  })

  it('treats touching intervals as contiguous', () => {
    expect(mergeIntervalSeconds([[0, 100], [100, 250]])).toBe(250)
  })

  it('ignores empty/invalid intervals and is order-independent', () => {
    expect(mergeIntervalSeconds([[200, 350], [0, 100], [50, 50], [400, 390]])).toBe(250)
    expect(mergeIntervalSeconds([])).toBe(0)
  })
})

describe('factionUsesTiers', () => {
  it('is true only for the tiered mode', () => {
    expect(factionUsesTiers('tiered')).toBe(true)
    expect(factionUsesTiers('flat-weighted')).toBe(false)
    expect(factionUsesTiers('equal')).toBe(false)
  })

  it('treats an absent/unknown mode as the default (no tiers)', () => {
    expect(factionUsesTiers(null)).toBe(false)
    expect(factionUsesTiers(undefined)).toBe(false)
    expect(factionUsesTiers('')).toBe(false)
    expect(factionUsesTiers('nonsense')).toBe(false)
  })
})

// #587: a faction that never saved a mode was silently paid flat-weighted,
// which is the one mode nobody had chosen — tiered is Forge-specific and
// flat-weighted was an arbitrary middle. Equal is the honest default: it
// needs no tier table and no ticket policy to be correct.
describe('DEFAULT_PAYOUT_MODE', () => {
  it('is equal, and is a real mode', () => {
    expect(DEFAULT_PAYOUT_MODE).toBe('equal')
    expect(PAYOUT_MODES).toContain(DEFAULT_PAYOUT_MODE)
  })

  it('does not turn on the tier machinery', () => {
    expect(factionUsesTiers(DEFAULT_PAYOUT_MODE)).toBe(false)
  })
})

describe('getWeekRangeFromDate', () => {
  it('returns correct Monday-Sunday range for a Wednesday', () => {
    // Wednesday 2026-03-18
    const result = getWeekRangeFromDate(new Date('2026-03-18T12:00:00Z'))
    expect(result.monday.getUTCDay()).toBe(1) // Monday
    expect(result.monday.getUTCDate()).toBe(16) // March 16
    expect(result.sunday.getUTCDate()).toBe(22)
    expect(result.sunday.getUTCDay()).toBe(0) // Sunday
  })

  it('returns same week when input is Monday', () => {
    const result = getWeekRangeFromDate(new Date('2026-03-16T00:00:00Z'))
    expect(result.monday.getUTCDate()).toBe(16)
    expect(result.mondayTimestamp).toBe(Math.floor(new Date('2026-03-16T00:00:00Z').getTime() / 1000))
  })

  it('returns same week when input is Sunday', () => {
    const result = getWeekRangeFromDate(new Date('2026-03-22T23:00:00Z'))
    expect(result.monday.getUTCDate()).toBe(16)
    expect(result.sunday.getUTCDate()).toBe(22)
  })

  it('handles year boundaries (Dec 31 mid-week)', () => {
    // Dec 31, 2025 is a Wednesday
    const result = getWeekRangeFromDate(new Date('2025-12-31T00:00:00Z'))
    expect(result.monday.getUTCDate()).toBe(29) // Dec 29
    expect(result.sunday.getUTCFullYear()).toBe(2026)
    expect(result.sunday.getUTCMonth()).toBe(0) // January
    expect(result.sunday.getUTCDate()).toBe(4)
  })

  it('monday starts at 00:00:00 UTC and sunday ends at 23:59:59', () => {
    const result = getWeekRangeFromDate(new Date('2026-03-18T00:00:00Z'))
    expect(result.monday.getUTCHours()).toBe(0)
    expect(result.monday.getUTCMinutes()).toBe(0)
    expect(result.monday.getUTCSeconds()).toBe(0)
    expect(result.sunday.getUTCHours()).toBe(23)
    expect(result.sunday.getUTCMinutes()).toBe(59)
    expect(result.sunday.getUTCSeconds()).toBe(59)
  })
})

// ─── getCurrentWeekRange / getPreviousWeekRange ────────────────────
describe('getCurrentWeekRange & getPreviousWeekRange', () => {
  it('previous week is exactly 7 days before current week', () => {
    const current = getCurrentWeekRange()
    const previous = getPreviousWeekRange()
    expect(current.mondayTimestamp - previous.mondayTimestamp).toBe(7 * DAY)
  })
})

// ─── formatDateUTC / parseDateAsUTC ────────────────────────────────
describe('formatDateUTC & parseDateAsUTC', () => {
  it('round-trips correctly', () => {
    const dateStr = '2026-03-18'
    const parsed = parseDateAsUTC(dateStr)
    expect(formatDateUTC(parsed)).toBe(dateStr)
  })

  it('formats with zero-padded month and day', () => {
    const d = new Date(Date.UTC(2026, 0, 5)) // Jan 5
    expect(formatDateUTC(d)).toBe('2026-01-05')
  })
})

// ─── calculateTimeSpent ────────────────────────────────────────────
describe('calculateTimeSpent', () => {
  const FROM = 1000
  const TO = 2000

  it('returns time within window when all values in range', () => {
    expect(calculateTimeSpent(1200, 1800, FROM, TO)).toBe(600)
  })

  it('clamps joinedAt to fromTimestamp when joined before window', () => {
    // joinedAt is 500, but effective start is FROM=1000
    expect(calculateTimeSpent(500, 1800, FROM, TO)).toBe(800)
  })

  it('clamps timeReference to toTimestamp when reference is after window', () => {
    // timeReference is 2500, but effective end is TO=2000
    expect(calculateTimeSpent(1200, 2500, FROM, TO)).toBe(800)
  })

  it('returns 0 when joinedAt is after toTimestamp', () => {
    expect(calculateTimeSpent(2500, 3000, FROM, TO)).toBe(0)
  })

  it('returns 0 when joinedAt equals toTimestamp', () => {
    // joinedAt > toTimestamp check: joinedAt=2000 is NOT > 2000, so passes
    // effectiveStart = max(2000, 1000) = 2000
    // effectiveEnd = min(3000, 2000) = 2000
    // effectiveStart >= effectiveEnd → 0
    expect(calculateTimeSpent(2000, 3000, FROM, TO)).toBe(0)
  })

  it('returns 0 when joinedAt is null/undefined', () => {
    expect(calculateTimeSpent(null, 1800, FROM, TO)).toBe(0)
    expect(calculateTimeSpent(undefined, 1800, FROM, TO)).toBe(0)
  })

  it('returns full window when joined before and reference after', () => {
    expect(calculateTimeSpent(500, 2500, FROM, TO)).toBe(1000)
  })

  it('returns 0 when effectiveStart equals effectiveEnd', () => {
    expect(calculateTimeSpent(1500, 1500, FROM, TO)).toBe(0)
  })

  it('returns correct time when joinedAt equals fromTimestamp (inclusive)', () => {
    expect(calculateTimeSpent(FROM, 1500, FROM, TO)).toBe(500)
  })

  // Real-world scenario: member joins mid-week
  it('handles member joining mid-week correctly', () => {
    const mondayStart = 1742169600 // 2025-03-17 00:00 UTC (Monday)
    const sundayEnd = 1742774400   // 2025-03-23 24:00 UTC (end of Sunday)
    const wednesdayJoin = 1742428800 // 2025-03-20 00:00 UTC (Wednesday)
    const crimeExecuted = 1742688000 // 2025-03-23 00:00 UTC (Saturday)

    const time = calculateTimeSpent(wednesdayJoin, crimeExecuted, mondayStart, sundayEnd)
    expect(time).toBe(crimeExecuted - wednesdayJoin) // 3 days
    expect(time).toBe(3 * DAY)
  })
})

// ─── calculatePayouts (integration-level) ──────────────────────────
describe('calculatePayouts', () => {
  const FROM = 1000000
  const TO = FROM + 7 * DAY // One week

  it('returns empty result when no crimes data', () => {
    const result = calculatePayouts({ crimes: {} }, makeMembers([1]), FROM, TO)
    expect(result.members).toHaveLength(0)
    expect(result.crimesProcessed).toBe(0)
    expect(result.memberPayoutTotal).toBe(0)
  })

  it('calculates payout for single member in single successful crime', () => {
    const executedAt = FROM + 3 * DAY
    const joinedAt = FROM - DAY // Joined before window
    const crimes = makeCrimeFixture({
      executedAt,
      rewardsMoney: 1_000_000,
      slots: [makeSlot(1, joinedAt)],
    })
    const members = makeMembers([1], 6) // Tier 6 = 2 tickets

    const result = calculatePayouts(crimes, members, FROM, TO, 0.20)

    expect(result.crimesProcessed).toBe(1)
    expect(result.totalMoneyReward).toBe(1_000_000)
    expect(result.factionCut).toBe(200_000)
    expect(result.memberPayoutTotal).toBe(800_000)
    expect(result.members).toHaveLength(1)
    expect(result.members[0].payout).toBe(800_000)
    expect(result.members[0].sharePercent).toBe(1)
  })

  it('adds banked left-early time on top of a member\'s completed-crime time when disjoint (#168)', () => {
    const executedAt = FROM + 3 * DAY
    const crimes = makeCrimeFixture({ executedAt, rewardsMoney: 1_000_000, slots: [makeSlot(1, FROM - DAY, 'Mover')] })
    // After finishing that crime the member joined another and LEFT it early —
    // a disjoint stint (one OC at a time), so it's genuinely additive.
    crimes.participation = [
      { member_id: '1', crime_id: '999', crime_name: 'Abandoned Job', joined_at: FROM + 3 * DAY, left_at: FROM + 5 * DAY },
    ]
    const result = calculatePayouts(crimes, makeMembers([1], 6), FROM, TO, 0.20)
    const m = result.members.find(x => String(x.userId) === '1')
    // completed = executedAt − FROM (joined before window) = 3 days; + 2 banked, disjoint.
    expect(m.timeSpent).toBe(3 * DAY + 2 * DAY)
    expect(m.bankedSeconds).toBe(2 * DAY)
    expect(m.bankedCrimes).toEqual([{ crime_id: '999', crime_name: 'Abandoned Job', seconds: 2 * DAY }])
  })

  it('does not double-count banked time that overlaps completed-crime time (#262)', () => {
    const executedAt = FROM + 3 * DAY
    const crimes = makeCrimeFixture({ executedAt, rewardsMoney: 1_000_000, slots: [makeSlot(1, FROM - DAY, 'Mover')] })
    // A left-early stint whose wall-clock time falls INSIDE the completed crime's
    // window (data artifact — a member can't really be in two OCs at once). The
    // old additive code returned 5 days; the union is 3.
    crimes.participation = [
      { member_id: '1', crime_id: '999', crime_name: 'Overlap', joined_at: FROM + DAY, left_at: FROM + 2 * DAY },
    ]
    const result = calculatePayouts(crimes, makeMembers([1], 6), FROM, TO, 0.20)
    const m = result.members.find(x => String(x.userId) === '1')
    expect(m.timeSpent).toBe(3 * DAY)          // union, not 3+1 days
    expect(m.bankedSeconds).toBe(0)            // already covered by completed time
  })

  it('never lets a member\'s total time exceed the payout window (#262)', () => {
    // Pathological overlapping data whose naive per-crime/stint sum blows past a
    // one-week window (the reported 211h/week bug). The corrected total is clamped.
    const executedAt = FROM + 6 * DAY
    const crimes = makeCrimeFixture({ executedAt, rewardsMoney: 1_000_000, slots: [makeSlot(1, FROM - DAY, 'Grinder')] })
    crimes.participation = [
      { member_id: '1', crime_id: 'a', crime_name: 'A', joined_at: FROM, left_at: FROM + 5 * DAY },
      { member_id: '1', crime_id: 'b', crime_name: 'B', joined_at: FROM + DAY, left_at: FROM + 6 * DAY },
      { member_id: '1', crime_id: 'c', crime_name: 'C', joined_at: FROM + 2 * DAY, left_at: FROM + 7 * DAY },
    ]
    const result = calculatePayouts(crimes, makeMembers([1], 6), FROM, TO, 0.20)
    const m = result.members.find(x => String(x.userId) === '1')
    expect(m.timeSpent).toBeLessThanOrEqual(TO - FROM) // ≤ 7 days
    expect(m.timeSpent).toBe(7 * DAY)                   // union spans the whole window
  })

  it('credits a member whose ONLY window activity was a left-early stint (#168)', () => {
    const crimes = makeCrimeFixture({ executedAt: FROM + 3 * DAY, rewardsMoney: 1_000_000, slots: [makeSlot(1, FROM - DAY)] })
    crimes.participation = [
      { member_id: '2', crime_id: '888', crime_name: 'Bailed', joined_at: FROM, left_at: FROM + DAY },
    ]
    const members = {
      members: {
        '1': { member_id: '1', name: 'A', tier: 6, is_current: true },
        '2': { member_id: '2', name: 'B', tier: 6, is_current: true },
      },
    }
    const result = calculatePayouts(crimes, members, FROM, TO, 0.20)
    const m2 = result.members.find(x => String(x.userId) === '2')
    expect(m2).toBeTruthy()
    expect(m2.timeSpent).toBe(DAY)
    expect(m2.bankedSeconds).toBe(DAY)
  })

  it('distributes proportionally to tier tickets across multiple members', () => {
    const executedAt = FROM + 3 * DAY
    const joinedAt = FROM - DAY

    const crimes = makeCrimeFixture({
      executedAt,
      rewardsMoney: 10_000_000,
      slots: [
        makeSlot(1, joinedAt, 'Tier1User'),
        makeSlot(2, joinedAt, 'Tier6User'),
      ],
    })

    // Member 1 is Tier 1 (40 tickets), Member 2 is Tier 6 (2 tickets)
    const members = {
      members: {
        '1': { member_id: '1', name: 'Tier1User', tier: 1, is_current: true },
        '2': { member_id: '2', name: 'Tier6User', tier: 6, is_current: true },
      },
    }

    const result = calculatePayouts(crimes, members, FROM, TO, 0.20)
    const pool = 10_000_000 * 0.80 // 8,000,000

    // Tier 1 gets 40/(40+2) = ~95.24%, Tier 6 gets 2/(40+2) = ~4.76%
    // Both members had enough time (joined before window, ~full week)
    const tier1Member = result.members.find(m => m.userId === 1)
    const tier6Member = result.members.find(m => m.userId === 2)

    expect(tier1Member.baseTickets).toBe(40)
    expect(tier6Member.baseTickets).toBe(2)
    expect(tier1Member.payout + tier6Member.payout).toBeLessThanOrEqual(pool)
    expect(tier1Member.payout).toBeGreaterThan(tier6Member.payout)
  })

  it('excludes failed crimes from reward totals but includes in crime stats', () => {
    const executedAt = FROM + 3 * DAY
    const joinedAt = FROM - DAY

    const successCrime = makeCrimeFixture({
      crimeId: 'success1',
      executedAt,
      rewardsMoney: 1_000_000,
      slots: [makeSlot(1, joinedAt)],
    })
    const failedCrime = makeCrimeFixture({
      crimeId: 'fail1',
      status: 'Failed',
      executedAt: FROM + 4 * DAY,
      rewardsMoney: 500_000,
      slots: [makeSlot(1, joinedAt)],
    })

    const crimes = {
      crimes: {
        ...successCrime.crimes,
        ...failedCrime.crimes,
      },
    }
    const members = makeMembers([1], 6)

    const result = calculatePayouts(crimes, members, FROM, TO, 0.20)

    expect(result.crimesProcessed).toBe(1) // Only successful
    expect(result.totalMoneyReward).toBe(1_000_000) // Only from success
    expect(result.crimeStats.failed).toBe(1)
    expect(result.crimeStats.successful).toBe(1)
  })

  it('applies faction cut correctly', () => {
    const executedAt = FROM + 3 * DAY
    const joinedAt = FROM - DAY
    const crimes = makeCrimeFixture({
      executedAt,
      rewardsMoney: 5_000_000,
      slots: [makeSlot(1, joinedAt)],
    })
    const members = makeMembers([1], 6)

    // 15% faction cut
    const result = calculatePayouts(crimes, members, FROM, TO, 0.15)
    expect(result.factionCut).toBe(750_000)
    expect(result.memberPayoutTotal).toBe(4_250_000)
  })

  it('gives $0 payout when member has less than 48 hours', () => {
    const executedAt = FROM + 3 * DAY
    // Member joined only 10 hours before execution (< 48h threshold)
    const joinedAt = executedAt - 10 * HOUR
    const crimes = makeCrimeFixture({
      executedAt,
      rewardsMoney: 1_000_000,
      slots: [makeSlot(1, joinedAt)],
    })
    const members = makeMembers([1], 1) // Even Tier 1

    const result = calculatePayouts(crimes, members, FROM, TO, 0.20)
    const member = result.members.find(m => m.userId === 1)

    // Sit-out penalty should remove all tickets
    expect(member.sitOutPenalty).toBe(-member.baseTickets)
    expect(member.adjustedTickets).toBe(0)
    expect(member.payout).toBe(0)
  })

  it('gives full tickets when member has 120+ hours', () => {
    const executedAt = FROM + 6 * DAY
    // Member joined 130 hours before execution (> 120h threshold)
    const joinedAt = executedAt - 130 * HOUR
    const crimes = makeCrimeFixture({
      executedAt,
      rewardsMoney: 1_000_000,
      slots: [makeSlot(1, joinedAt)],
    })
    const members = makeMembers([1], 3) // Tier 3 = 15 tickets

    const result = calculatePayouts(crimes, members, FROM, TO, 0.20)
    const member = result.members.find(m => m.userId === 1)

    expect(member.sitOutPenalty).toBe(0)
    expect(member.adjustedTickets).toBe(15)
  })

  it('applies sliding scale penalty between 48-120 hours', () => {
    const executedAt = FROM + 6 * DAY
    // Member joined 84 hours before execution (midpoint of 48-120)
    const joinedAt = executedAt - 84 * HOUR
    const crimes = makeCrimeFixture({
      executedAt,
      rewardsMoney: 1_000_000,
      slots: [makeSlot(1, joinedAt)],
    })
    const members = makeMembers([1], 1) // Tier 1 = 40 tickets

    const result = calculatePayouts(crimes, members, FROM, TO, 0.20)
    const member = result.members.find(m => m.userId === 1)

    // 84h is exactly midpoint between 48h and 120h
    // percentOfRange = (84-48)/(120-48) = 36/72 = 0.5
    // penalty = -(1-0.5) * 40 = -20
    expect(member.sitOutPenalty).toBeCloseTo(-20, 1)
    expect(member.adjustedTickets).toBeCloseTo(20, 1)
  })

  it('ignores crimes executed outside the time window', () => {
    const joinedAt = FROM - DAY
    const beforeWindow = makeCrimeFixture({
      crimeId: 'before',
      executedAt: FROM - 100, // Before window
      rewardsMoney: 5_000_000,
      slots: [makeSlot(1, joinedAt)],
    })
    const afterWindow = makeCrimeFixture({
      crimeId: 'after',
      executedAt: TO + 100, // After window
      rewardsMoney: 5_000_000,
      slots: [makeSlot(1, joinedAt)],
    })
    const inWindow = makeCrimeFixture({
      crimeId: 'in',
      executedAt: FROM + 3 * DAY,
      rewardsMoney: 1_000_000,
      slots: [makeSlot(1, joinedAt)],
    })

    const crimes = {
      crimes: {
        ...beforeWindow.crimes,
        ...afterWindow.crimes,
        ...inWindow.crimes,
      },
    }
    const members = makeMembers([1], 6)
    const result = calculatePayouts(crimes, members, FROM, TO, 0.20)

    expect(result.crimesProcessed).toBe(1)
    expect(result.totalMoneyReward).toBe(1_000_000)
  })

  it('handles item rewards and costs in gross total', () => {
    const executedAt = FROM + 3 * DAY
    const joinedAt = FROM - DAY
    const crimes = makeCrimeFixture({
      executedAt,
      rewardsMoney: 1_000_000,
      itemRewardValue: 500_000,
      itemCostValue: 200_000,
      slots: [makeSlot(1, joinedAt)],
    })
    const members = makeMembers([1], 6)

    const result = calculatePayouts(crimes, members, FROM, TO, 0.20)

    expect(result.totalMoneyReward).toBe(1_000_000)
    expect(result.totalItemReward).toBe(500_000)
    expect(result.totalItemCost).toBe(200_000)
    expect(result.grossTotal).toBe(1_300_000)
    expect(result.factionCut).toBe(260_000)
    expect(result.memberPayoutTotal).toBe(1_040_000)
  })

  it('tracks time for in-progress (Planning/Recruiting) crimes but does not count rewards', () => {
    const joinedAt = FROM + 1 * DAY

    const planningCrime = makeCrimeFixture({
      crimeId: 'planning1',
      status: 'Planning',
      executedAt: 0,
      rewardsMoney: 5_000_000,
      slots: [makeSlot(1, joinedAt)],
    })
    const successCrime = makeCrimeFixture({
      crimeId: 'success1',
      executedAt: FROM + 5 * DAY,
      rewardsMoney: 1_000_000,
      slots: [makeSlot(1, FROM - DAY)],
    })

    const crimes = {
      crimes: {
        ...planningCrime.crimes,
        ...successCrime.crimes,
      },
    }
    const members = makeMembers([1], 6)

    const result = calculatePayouts(crimes, members, FROM, TO, 0.20)

    // Only the successful crime counts for rewards
    expect(result.crimesProcessed).toBe(1)
    expect(result.totalMoneyReward).toBe(1_000_000)

    // But time from the planning crime IS tracked
    const member = result.members.find(m => m.userId === 1)
    expect(member.timeSpent).toBeGreaterThan(0)
  })
})

// ─── formatCurrency / formatCurrencyShort ──────────────────────────
describe('formatCurrency', () => {
  it('formats with commas', () => {
    expect(formatCurrency(1234567)).toBe('$1,234,567')
  })

  it('handles null/undefined', () => {
    expect(formatCurrency(null)).toBe('$0')
    expect(formatCurrency(undefined)).toBe('$0')
  })
})

describe('formatCurrencyShort', () => {
  it('abbreviates billions', () => {
    expect(formatCurrencyShort(2_020_000_000)).toBe('$2.02B')
  })

  it('abbreviates millions', () => {
    expect(formatCurrencyShort(1_500_000)).toBe('$1.50M')
  })

  it('abbreviates thousands', () => {
    expect(formatCurrencyShort(5_000)).toBe('$5.0K')
  })

  it('handles negative values', () => {
    expect(formatCurrencyShort(-1_500_000)).toBe('-$1.50M')
  })
})

// ─── exportPayoutFilename ───────────────────────────────────────────
describe('exportPayoutFilename', () => {
  it('brands the downloaded file with the tenant\'s own faction, not Forge', () => {
    expect(exportPayoutFilename('20260719', 'Mayhem')).toBe('20260719-Mayhem_OC_Payout.csv')
  })

  it('strips characters unsafe in a filename from multi-word faction names', () => {
    expect(exportPayoutFilename('20260719', 'The Next Level - Forge'))
      .toBe('20260719-The_Next_Level_Forge_OC_Payout.csv')
  })

  it('falls back to a generic label when no faction name is available', () => {
    expect(exportPayoutFilename('20260719', '')).toBe('20260719-OC_Payout.csv')
    expect(exportPayoutFilename('20260719', undefined)).toBe('20260719-OC_Payout.csv')
  })
})

describe('calculatePayouts modes (#134)', () => {
  const FROM = 1000000
  const TO = FROM + 7 * DAY
  const executedAt = FROM + 6 * DAY

  const twoTierCrime = () => makeCrimeFixture({
    executedAt, rewardsMoney: 10_000_000,
    slots: [makeSlot(1, FROM - DAY, 'T1'), makeSlot(2, FROM - DAY, 'T6')],
  })
  const twoTierMembers = {
    members: {
      '1': { member_id: '1', name: 'T1', tier: 1, is_current: true },
      '2': { member_id: '2', name: 'T6', tier: 6, is_current: true },
    },
  }

  it('defaults to equal at the faction level, tiered is opt-in', () => {
    expect(DEFAULT_PAYOUT_MODE).toBe('equal')
    expect(PAYOUT_MODES).toEqual(['tiered', 'flat-weighted', 'equal'])
  })

  it('tiered is byte-identical to the default (regression)', () => {
    const shape = (r) => r.members.map(m => [m.userId, m.payout, m.sharePercent, m.baseTickets, m.adjustedTickets])
    const def = calculatePayouts(twoTierCrime(), twoTierMembers, FROM, TO, 0.20)
    const tiered = calculatePayouts(twoTierCrime(), twoTierMembers, FROM, TO, 0.20, 'tiered')
    expect(shape(tiered)).toEqual(shape(def))
    expect(tiered.payoutMode).toBe('tiered')
  })

  it('tiered weights by tier — T1 earns far more than T6', () => {
    const r = calculatePayouts(twoTierCrime(), twoTierMembers, FROM, TO, 0.20, 'tiered')
    const t1 = r.members.find(m => m.userId === 1)
    const t6 = r.members.find(m => m.userId === 2)
    expect(t1.payout).toBeGreaterThan(t6.payout * 10)
  })

  it('flat-weighted gives every tier the same base — full-time T1 and T6 split evenly', () => {
    const r = calculatePayouts(twoTierCrime(), twoTierMembers, FROM, TO, 0.20, 'flat-weighted')
    const t1 = r.members.find(m => m.userId === 1)
    const t6 = r.members.find(m => m.userId === 2)
    expect(t1.baseTickets).toBe(40)
    expect(t6.baseTickets).toBe(40)
    expect(t1.payout).toBe(t6.payout)
    expect(r.payoutMode).toBe('flat-weighted')
  })

  it('flat-weighted still applies the sit-out floor — a sub-48h member gets $0', () => {
    const crime = makeCrimeFixture({
      executedAt, rewardsMoney: 10_000_000,
      slots: [makeSlot(1, FROM - DAY, 'Full'), makeSlot(2, executedAt - 20 * 3600, 'Late')],
    })
    const members = { members: {
      '1': { member_id: '1', name: 'Full', tier: 1, is_current: true },
      '2': { member_id: '2', name: 'Late', tier: 1, is_current: true },
    } }
    const late = calculatePayouts(crime, members, FROM, TO, 0.20, 'flat-weighted').members.find(m => m.userId === 2)
    expect(late.payout).toBe(0)
  })

  it('equal splits evenly among everyone who did >=1 OC, ignoring time and tier', () => {
    const crime = makeCrimeFixture({
      executedAt, rewardsMoney: 10_000_000,
      slots: [
        makeSlot(1, FROM - DAY, 'Full'),          // full time
        makeSlot(2, executedAt - 20 * 3600, 'Late'), // ~20h, sub-floor
        makeSlot(3, executedAt, 'Zero'),          // joined at execution → 0h
      ],
    })
    const members = { members: {
      '1': { member_id: '1', name: 'Full', tier: 1, is_current: true },
      '2': { member_id: '2', name: 'Late', tier: 6, is_current: true },
      '3': { member_id: '3', name: 'Zero', tier: 1, is_current: true },
    } }
    const r = calculatePayouts(crime, members, FROM, TO, 0.20, 'equal')
    const full = r.members.find(m => m.userId === 1)
    const late = r.members.find(m => m.userId === 2)
    const zero = r.members.find(m => m.userId === 3)
    // Full and Late each did an OC → even split despite the time + tier gap.
    expect(full.payout).toBe(late.payout)
    expect(full.sharePercent).toBeCloseTo(0.5)
    // Zero time in-window → no OC participation → excluded from the split.
    expect(zero.timeSpent).toBe(0)
    expect(zero.payout).toBe(0)
  })
})

describe('weekCrimeRowsToMap', () => {
  const rows = [
    { crime_id: 101, name: 'Break the Bank', difficulty: 8, status: 'Successful', executed_at: 1700, rewards_money: 5000 },
    { crime_id: 102, name: 'Blast from the Past', difficulty: 7, status: 'Failure', executed_at: 1600, rewards_money: 0 },
  ]

  it('keys crimes by crime_id and nests rewards_money under rewards.money', () => {
    const map = weekCrimeRowsToMap(rows)
    expect(Object.keys(map)).toEqual(['101', '102'])
    expect(map[101]).toMatchObject({
      crime_id: 101, name: 'Break the Bank', difficulty: 8,
      status: 'Successful', executed_at: 1700, rewards: { money: 5000 }, slots: [],
    })
  })

  it('produces input getCrimeStats consumes directly', () => {
    const stats = getCrimeStats(weekCrimeRowsToMap(rows))
    expect(stats.totals.count).toBe(2)
    expect(stats.totals.success).toBe(1)
    expect(stats.totals.failed).toBe(1)
    expect(stats.totals.totalMoney).toBe(5000)
  })

  it('handles empty / missing input', () => {
    expect(weekCrimeRowsToMap([])).toEqual({})
    expect(weekCrimeRowsToMap(undefined)).toEqual({})
  })

  // #391 — the saved-week path used to hardcode `slots: []`, so Crime
  // Statistics reported "0 participants" for every archived week and the
  // expand showed "no data". The live calculator always had slots, which is
  // why it only broke when someone REOPENED a payout — exactly when they are
  // auditing who was in what.
  it('nests the slots it is given, keyed by crime', () => {
    const slots = [
      { crime_id: 101, position: 'Muscle', position_number: 1, user_id: '500', user_name: 'Alice', joined_at: 1650 },
      { crime_id: 101, position: 'Hacker', position_number: 2, user_id: '501', user_name: 'Bob', joined_at: 1655 },
      { crime_id: 102, position: 'Driver', position_number: 1, user_id: '502', user_name: 'Carol', joined_at: 1550 },
    ]
    const map = weekCrimeRowsToMap(rows, slots)
    expect(map[101].slots).toHaveLength(2)
    expect(map[102].slots).toHaveLength(1)
    expect(map[101].slots[0].user).toMatchObject({ id: 500, name: 'Alice', joined_at: 1650 })
  })

  it('feeds getCrimeStats a real participant count', () => {
    // The reported symptom, at the level the user sees it.
    const slots = [
      { crime_id: 101, position: 'Muscle', user_id: '500', user_name: 'Alice' },
      { crime_id: 101, position: 'Hacker', user_id: '501', user_name: 'Bob' },
    ]
    const stats = getCrimeStats(weekCrimeRowsToMap(rows, slots))
    const crime101 = stats.crimesList.find((c) => c.id === 101)
    expect(crime101.participants).toHaveLength(2)
    // …and the crime with no slots still reports zero rather than throwing.
    expect(stats.crimesList.find((c) => c.id === 102).participants).toHaveLength(0)
  })

  it('leaves an empty slot list when the caller passes none', () => {
    // Older callers must degrade to the previous behaviour, not throw.
    expect(weekCrimeRowsToMap(rows).slots).toBeUndefined()
    expect(weekCrimeRowsToMap(rows)[101].slots).toEqual([])
  })

  it('ignores an unfilled slot rather than inventing a participant', () => {
    const slots = [{ crime_id: 101, position: 'Muscle', user_id: null }]
    const map = weekCrimeRowsToMap(rows, slots)
    expect(map[101].slots[0].user).toBeNull()
    expect(getCrimeStats(map).crimesList.find((c) => c.id === 101).participants).toHaveLength(0)
  })

  it('prefers the current member name over the one stored on the slot', () => {
    // A member who renamed should read as who they are now.
    const slots = [{ crime_id: 101, position: 'Muscle', user_id: '500', user_name: 'OldName' }]
    const map = weekCrimeRowsToMap(rows, slots, { 500: 'NewName' })
    expect(map[101].slots[0].user.name).toBe('NewName')
  })
})

describe('buildHistoricalWeekCrimesData', () => {
  const rows = [
    { crime_id: 101, name: 'Break the Bank', difficulty: 8, status: 'Successful', executed_at: 1700, rewards_money: 5000 },
  ]

  // #389: reopening a saved week used to build crimesData from just
  // {crimes, slots} — silently dropping occupancy_polls, which OccupancyPanel
  // then read as an undefined-so-empty array and reported as "Not watched"
  // even for a week the poller genuinely covered.
  it('carries occupancy and occupancy_polls through alongside the crimes map', () => {
    const occupancyForWeek = {
      occupancy: [{ crime_id: 101, member_id: '500' }],
      occupancy_polls: [{ polled_at: 1700 }, { polled_at: 1760 }],
    }
    const result = buildHistoricalWeekCrimesData(rows, [], occupancyForWeek)
    expect(result.occupancy).toEqual(occupancyForWeek.occupancy)
    expect(result.occupancy_polls).toEqual(occupancyForWeek.occupancy_polls)
    expect(result.crimes).toEqual(weekCrimeRowsToMap(rows, []))
  })

  it('defaults to empty arrays rather than undefined when occupancyForWeek is missing fields', () => {
    const result = buildHistoricalWeekCrimesData(rows, [], {})
    expect(result.occupancy).toEqual([])
    expect(result.occupancy_polls).toEqual([])
  })

  it('defaults occupancyForWeek itself when the caller passes nothing', () => {
    const result = buildHistoricalWeekCrimesData(rows, [])
    expect(result.occupancy_polls).toEqual([])
  })
})

// ─── Time Spent: crimes that ended without executing (#392) ────────
//
// The status check that picks a crime's end time lists only the executed
// statuses:
//
//   if (status === 'Successful' || status === 'Failed' || status === 'Failure')
//     timeReference = executedAt
//   else
//     timeReference = min(now, toTimestamp)   // "still in progress"
//
// Torn also has **Expired** — an OC that never filled and lapsed. It is not in
// the list, so it takes the in-progress branch and its members are credited
// right up to the window edge, for a crime that stopped existing days earlier.
// A single expired crime therefore hands everyone who was sitting in it a full
// week of Time Spent, which is the whole-interval error #389 describes.
describe('Time Spent for expired crimes (#392)', () => {
  const FROM = 1_000_000
  const TO = FROM + 7 * DAY

  // An expired crime plus a real one, so there is a payout to divide.
  const fixture = ({ expiredStatus = 'Expired' } = {}) => ({
    crimes: {
      // Joined a day before the window, lapsed 6 hours into it.
      expired: {
        crime_id: 'expired',
        name: 'Never Filled',
        status: expiredStatus,
        executed_at: null,
        expired_at: FROM + 6 * HOUR,
        created_at: FROM - DAY,
        difficulty: 5,
        rewards: { money: 0 },
        slots: [makeSlot(1, FROM - DAY)],
      },
      // A normal crime the other member ran all week.
      done: {
        crime_id: 'done',
        name: 'Test Crime',
        status: 'Successful',
        executed_at: TO - HOUR,
        created_at: FROM,
        difficulty: 5,
        rewards: { money: 1_000_000 },
        slots: [makeSlot(2, FROM)],
      },
    },
  })

  it('credits an expired crime only up to when it expired', () => {
    const result = calculatePayouts(fixture(), makeMembers([1, 2]), FROM, TO, 0.20)
    const m1 = result.members.find(m => m.userId === 1)

    // Real time in the crime, inside the window: FROM → FROM + 6h.
    expect(m1.timeSpent).toBe(6 * HOUR)
  })

  it('does not hand an expired crime the whole payout window', () => {
    // The failure this guards: 6 hours of participation scoring as 168, which
    // then dominates the time-share split and moves real money.
    const result = calculatePayouts(fixture(), makeMembers([1, 2]), FROM, TO, 0.20)
    const m1 = result.members.find(m => m.userId === 1)
    expect(m1.timeSpent).toBeLessThan(TO - FROM)
  })

  it('treats an unrecognised status as ended, not as running', () => {
    // Same reasoning, one step more defensive: if Torn adds a status we do not
    // know, defaulting it to "still running to the window edge" is the failure
    // mode that costs money. Only the statuses we KNOW mean in-progress should
    // accrue to now.
    const result = calculatePayouts(fixture({ expiredStatus: 'Something New' }), makeMembers([1, 2]), FROM, TO, 0.20)
    const m1 = result.members.find(m => m.userId === 1)
    expect(m1.timeSpent).toBe(6 * HOUR)
  })

  it('still accrues a genuinely in-progress crime to the window edge', () => {
    // The behaviour that must survive the fix: Planning/Recruiting members are
    // in the crime right now and keep earning.
    const crimes = {
      crimes: {
        planning: {
          crime_id: 'planning',
          name: 'Still Going',
          status: 'Planning',
          executed_at: null,
          created_at: FROM,
          difficulty: 5,
          rewards: { money: 0 },
          slots: [makeSlot(1, FROM)],
        },
        done: fixture().crimes.done,
      },
    }
    const result = calculatePayouts(crimes, makeMembers([1, 2]), FROM, TO, 0.20)
    expect(result.members.find(m => m.userId === 1).timeSpent).toBe(TO - FROM)
  })
})

// ─── Banked time is shown but does not drive money (#389) ──────────
//
// MonChoon, 2026-08-12: "do not use the early leave in the calculation, only
// have the legacy time spent in crime as part of the ticket portion. I will
// observe the data for a few weeks until I can verify it's working."
//
// So the split is deliberate and temporary: `timeSpent` and `bankedSeconds`
// keep reporting left-early time for review, while `ticketTimeSpent` — the
// completed/current intervals alone — is what tickets, the sit-out penalty and
// the payout share are computed from.
describe('banked time is displayed but excluded from the payout (#389)', () => {
  const FROM = 1_000_000
  const TO = FROM + 7 * DAY

  // One member with a completed crime, one whose only activity was leaving
  // a crime early (banked). Both are in the window.
  const fixture = () => ({
    crimes: {
      done: {
        crime_id: 'done', name: 'Test Crime', status: 'Successful',
        executed_at: TO - HOUR, created_at: FROM, difficulty: 5,
        rewards: { money: 1_000_000 },
        slots: [makeSlot(1, FROM)],
      },
    },
    participation: [
      // Member 2 was in a crime for 3 days and left before it executed.
      { member_id: '2', crime_id: 'left', joined_at: FROM, left_at: FROM + 3 * DAY, crime_name: 'Bailed' },
      // Member 1 also banked a day on top of the crime they completed.
      { member_id: '1', crime_id: 'other', joined_at: FROM - DAY, left_at: FROM + DAY, crime_name: 'Also Bailed' },
    ],
  })

  it('still reports banked time, so it can be reviewed', () => {
    const result = calculatePayouts(fixture(), makeMembers([1, 2]), FROM, TO, 0.20)
    const m2 = result.members.find(m => m.userId === '2' || m.userId === 2)
    expect(m2.timeSpent).toBe(3 * DAY)
    expect(m2.bankedSeconds).toBe(3 * DAY)
  })

  it('gives banked-only time no ticket time, so it earns nothing', () => {
    const result = calculatePayouts(fixture(), makeMembers([1, 2]), FROM, TO, 0.20)
    const m2 = result.members.find(m => m.userId === '2' || m.userId === 2)
    expect(m2.ticketTimeSpent).toBe(0)
    expect(m2.payout).toBe(0)
  })

  it('pays the whole pool to the member with real crime time', () => {
    const result = calculatePayouts(fixture(), makeMembers([1, 2]), FROM, TO, 0.20)
    const m1 = result.members.find(m => m.userId === 1)
    expect(m1.payout).toBe(800_000)
    expect(m1.sharePercent).toBe(1)
  })

  it('does not let banked time inflate a real member\'s ticket time either', () => {
    // Member 1 completed a crime running FROM -> TO-1h and banked an extra day
    // that overlaps it. timeSpent unions both; ticketTimeSpent must not.
    const result = calculatePayouts(fixture(), makeMembers([1, 2]), FROM, TO, 0.20)
    const m1 = result.members.find(m => m.userId === 1)
    expect(m1.ticketTimeSpent).toBe(TO - HOUR - FROM)
    expect(m1.timeSpent).toBeGreaterThanOrEqual(m1.ticketTimeSpent)
  })

  it('keeps ticketTimeSpent equal to timeSpent when nobody left early', () => {
    // The no-banked-time case must be untouched by the split — otherwise this
    // change would quietly alter every ordinary payout.
    const crimes = makeCrimeFixture({
      executedAt: FROM + 3 * DAY, rewardsMoney: 1_000_000, slots: [makeSlot(1, FROM)],
    })
    const result = calculatePayouts(crimes, makeMembers([1]), FROM, TO, 0.20)
    expect(result.members[0].ticketTimeSpent).toBe(result.members[0].timeSpent)
    expect(result.members[0].payout).toBe(800_000)
  })
})

// ─── Observed occupancy is reported, not applied (#389 part 2) ─────
//
// The poller's figures ship alongside the inferred ones so MonChoon can watch
// them for a few weeks before they are allowed to move money. Switching the
// moment coverage looked complete would take that decision away.
describe('occupancy diagnostics ride along without changing the payout (#389)', () => {
  const FROM = 1_000_000
  const TO = FROM + 7 * DAY

  const base = () => makeCrimeFixture({
    executedAt: FROM + 3 * DAY, rewardsMoney: 1_000_000, slots: [makeSlot(1, FROM)],
  })

  it('reports observed seconds per member', () => {
    const data = {
      ...base(),
      occupancy: [
        { member_id: '1', torn_joined_at: FROM, first_seen_at: FROM + 60, last_seen_at: FROM + 2 * HOUR },
      ],
    }
    const result = calculatePayouts(data, makeMembers([1]), FROM, TO, 0.20)
    expect(result.members[0].observedSeconds).toBe(2 * HOUR)
  })

  it('does NOT let observed seconds change the payout', () => {
    // The observed figure here is 2h against an inferred 3 days. If it were
    // wired into the money, this payout would move — it must not.
    const withOcc = calculatePayouts({
      ...base(),
      occupancy: [{ member_id: '1', torn_joined_at: FROM, first_seen_at: FROM, last_seen_at: FROM + 2 * HOUR }],
    }, makeMembers([1]), FROM, TO, 0.20)
    const without = calculatePayouts(base(), makeMembers([1]), FROM, TO, 0.20)

    expect(withOcc.members[0].payout).toBe(without.members[0].payout)
    expect(withOcc.members[0].ticketTimeSpent).toBe(without.members[0].ticketTimeSpent)
  })

  it('reports a window the poller never watched as uncovered', () => {
    // Every window before the poller shipped. It must read as "unwatched",
    // never as "nobody moved".
    const result = calculatePayouts(base(), makeMembers([1]), FROM, TO, 0.20)
    expect(result.occupancyCoverage.covered).toBe(false)
    expect(result.occupancyCoverage.pollCount).toBe(0)
  })

  it('carries the joined_at drift so the poller can be judged before it is trusted', () => {
    const data = {
      ...base(),
      occupancy: [
        { member_id: '1', torn_joined_at: FROM, first_seen_at: FROM + 30, last_seen_at: FROM + HOUR },
      ],
    }
    const result = calculatePayouts(data, makeMembers([1]), FROM, TO, 0.20)
    expect(result.occupancyDrift.count).toBe(1)
    expect(result.occupancyDrift.max).toBe(30)
    expect(result.occupancyDrift.withinTolerance).toBe(true)
  })

  it('is inert when the server sent no occupancy at all', () => {
    const result = calculatePayouts(base(), makeMembers([1]), FROM, TO, 0.20)
    expect(result.members[0].observedSeconds).toBe(0)
    expect(result.occupancyDrift.count).toBe(0)
    expect(result.members[0].payout).toBe(800_000)
  })
})

// ─── Occupancy drives the payout once fully watched (#389 part 3) ──
//
// MonChoon, 2026-08-28, once crimeOccupancy.ts's position_id bug was fixed:
// "I think it makes sense to just switch over completely. The only issue
// would be if some faction did not have the container running constantly."
// So the switch is gated on occupancyCoverage.covered — any gap (including a
// window that predates the poller entirely) keeps the legacy calculation.
describe('occupancy drives tickets/payout for a fully-watched window (#389 part 3)', () => {
  const FROM = 1_000_000
  const TO = FROM + HOUR

  // Dense polls, well within the gap tolerance, spanning the whole window.
  const densePolls = () => {
    const polls = []
    for (let t = FROM; t <= TO; t += 150) polls.push({ polled_at: t })
    return polls
  }

  const base = () => makeCrimeFixture({
    executedAt: TO - 10, rewardsMoney: 1_000_000, slots: [makeSlot(1, FROM)],
  })

  it('reports timeSource "legacy" when there are no polls at all', () => {
    // `base()` carries no occupancy_polls, so this is the no-data case — the
    // only one that still falls back since #665.
    const result = calculatePayouts(base(), makeMembers([1]), FROM, TO, 0.20)
    expect(result.occupancyCoverage.hasPolls).toBe(false)
    expect(result.timeSource).toBe('legacy')
  })

  it('reports timeSource "occupancy" and drives ticketTimeSpent from it once fully watched', () => {
    const data = {
      ...base(),
      occupancy: [
        { member_id: '1', torn_joined_at: FROM, first_seen_at: FROM, last_seen_at: FROM + 2 * 60 },
      ],
      occupancy_polls: densePolls(),
    }
    const result = calculatePayouts(data, makeMembers([1]), FROM, TO, 0.20)
    expect(result.occupancyCoverage.covered).toBe(true)
    expect(result.timeSource).toBe('occupancy')
    const m1 = result.members.find(m => m.userId === 1 || m.userId === '1')
    expect(m1.observedSeconds).toBe(2 * 60)
    expect(m1.ticketTimeSpent).toBe(2 * 60)
    expect(m1.timeSpent).toBe(2 * 60)
  })

  it('keeps the legacy figures available for comparison once switched', () => {
    const data = {
      ...base(),
      occupancy: [
        { member_id: '1', torn_joined_at: FROM, first_seen_at: FROM, last_seen_at: FROM + 2 * 60 },
      ],
      occupancy_polls: densePolls(),
    }
    const result = calculatePayouts(data, makeMembers([1]), FROM, TO, 0.20)
    const m1 = result.members.find(m => m.userId === 1 || m.userId === '1')
    expect(m1.legacyTimeSpent).toBe(TO - 10 - FROM)
    expect(m1.legacyTicketTimeSpent).toBe(TO - 10 - FROM)
  })

  it('includes a member occupancy saw but crime_slots never captured', () => {
    // crimes-sync polls every 30 minutes; occupancy polls every minute. A
    // member who joined and left entirely between two crimes-sync runs can be
    // occupancy-only.
    const data = {
      ...base(),
      occupancy: [
        { member_id: '1', torn_joined_at: FROM, first_seen_at: FROM, last_seen_at: FROM + 2 * 60 },
        { member_id: '2', torn_joined_at: FROM + 10 * 60, first_seen_at: FROM + 10 * 60, last_seen_at: FROM + 15 * 60 },
      ],
      occupancy_polls: densePolls(),
    }
    const result = calculatePayouts(data, makeMembers([1, 2]), FROM, TO, 0.20)
    const m2 = result.members.find(m => m.userId === 2 || m.userId === '2')
    // Both members' observed time is well under the 48h sit-out floor for
    // this deliberately short test window, so payout share isn't the thing
    // being checked here — just that the occupancy-only member is present
    // at all, rather than silently dropped for having no crime_slots row.
    expect(m2).toBeDefined()
    expect(m2.observedSeconds).toBe(5 * 60)
    expect(m2.ticketTimeSpent).toBe(5 * 60)
    expect(m2.crimesCount).toBe(0)
  })

  it('\u26a0\ufe0f #665: KEEPS using occupancy when the window has a gap', () => {
    // Inverts #389's "does not switch when the window has even one gap beyond
    // tolerance". That rule discarded the accurate source over jitter: measured
    // across 30 days of production, forge and tnl poll 99.97% of minutes and
    // still accumulate four gaps over 180s each, so a week-long window almost
    // always contained one and almost always fell back to the snapshot
    // calculation — which loses an entire earlier stint on any seat change.
    const polls = densePolls()
    const gapped = polls.filter(p => p.polled_at < FROM + 20 * 60 || p.polled_at > FROM + 30 * 60)
    const data = {
      ...base(),
      occupancy: [
        { member_id: '1', torn_joined_at: FROM, first_seen_at: FROM, last_seen_at: FROM + 2 * 60 },
      ],
      occupancy_polls: gapped,
    }
    const result = calculatePayouts(data, makeMembers([1]), FROM, TO, 0.20)
    expect(result.occupancyCoverage.covered).toBe(false)   // still imperfect …
    expect(result.timeSource).toBe('occupancy')             // … and still used
    const m1 = result.members.find(m => m.userId === 1 || m.userId === '1')
    expect(m1.observedSeconds).toBe(2 * 60)
    expect(m1.ticketTimeSpent).toBe(2 * 60)
  })

  it('\u26a0\ufe0f #665: falls back to legacy ONLY when nothing was watched at all', () => {
    // The one surviving fallback, and it exists to protect history rather than
    // multi-tenancy. Occupancy data starts 2026-08-13; 22 of forge's 25 saved
    // payout weeks predate it. Under a pure-occupancy rule those windows would
    // credit every member zero, and re-saving one would overwrite the real
    // historical payout with zeros.
    const data = { ...base(), occupancy: [], occupancy_polls: [] }
    const result = calculatePayouts(data, makeMembers([1]), FROM, TO, 0.20)
    expect(result.occupancyCoverage.hasPolls).toBe(false)
    expect(result.timeSource).toBe('legacy')
    const m1 = result.members.find(m => m.userId === 1 || m.userId === '1')
    expect(m1.ticketTimeSpent).toBe(TO - 10 - FROM)
  })

  it('\u26a0\ufe0f #665: reports gaps of an hour or more separately from jitter', () => {
    // Short gaps are credited silently; an hour unwatched can hide an entire
    // stint start-to-finish, so it is surfaced rather than absorbed.
    //
    // ⚠️ Its own WEEK-long window on purpose: this block's TO is FROM + HOUR,
    // and a gap of an hour or more cannot exist inside an hour-long window, so
    // reusing the shared fixture makes the case impossible to construct rather
    // than merely awkward.
    const WEEK_TO = FROM + 7 * DAY
    const polls = []
    for (let t = FROM; t <= WEEK_TO; t += 150) polls.push({ polled_at: t })
    const bigGap = polls.filter(p => p.polled_at < FROM + 10 * 60 || p.polled_at > FROM + 80 * 60)

    const data = {
      ...makeCrimeFixture({
        executedAt: WEEK_TO - 10, rewardsMoney: 1_000_000, slots: [makeSlot(1, FROM)],
      }),
      occupancy: [],
      occupancy_polls: bigGap,
    }
    const result = calculatePayouts(data, makeMembers([1]), FROM, WEEK_TO, 0.20)
    expect(result.occupancyCoverage.significantGaps.length).toBeGreaterThan(0)
    expect(result.occupancyCoverage.significantGaps[0][1] - result.occupancyCoverage.significantGaps[0][0])
      .toBeGreaterThanOrEqual(3600)
    // Still used, not discarded — that is the whole point of #665.
    expect(result.timeSource).toBe('occupancy')
  })
})
