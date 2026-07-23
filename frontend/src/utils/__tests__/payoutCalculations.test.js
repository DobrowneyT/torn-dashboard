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
  getCrimeStats,
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
})
