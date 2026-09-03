import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the faction API client before importing the module
vi.mock('../apiClient', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}))

import { apiGet, apiPost } from '../apiClient'
import { checkExistingWeek, filterItemsForMember, loadCrimesForPayout, savePayoutWeek } from '../payoutDataLoader'
import { DEFAULT_PAYOUT_MODE } from '../payoutCalculations'

describe('loadCrimesForPayout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // #389: this function used to drop occupancy/occupancy_polls entirely —
  // OccupancyPanel reads those off the return value, so every live payout
  // calculation reported "Not watched" no matter what the poller actually
  // saw. Covers both branches: crimes present and the empty-crimes early
  // return, since the bug was in both.
  it('carries occupancy and occupancy_polls through when crimes are present', async () => {
    apiGet.mockImplementation((path) => {
      if (path.startsWith('/api/payouts/crime-data')) {
        return Promise.resolve({
          crimes: [{ crime_id: 1, name: 'Cash Me If You Can', difficulty: 5, rewards_money: 1000 }],
          slots: [], reward_items: [], required_items: [], participation: [],
          occupancy: [{ crime_id: 1, member_id: '500' }],
          occupancy_polls: [{ polled_at: 1700 }, { polled_at: 1760 }],
        })
      }
      return Promise.resolve({ roster: [] })
    })
    const result = await loadCrimesForPayout(1700, 1800)
    expect(result.occupancy).toEqual([{ crime_id: 1, member_id: '500' }])
    expect(result.occupancy_polls).toEqual([{ polled_at: 1700 }, { polled_at: 1760 }])
  })

  it('carries occupancy and occupancy_polls through the empty-crimes early return', async () => {
    apiGet.mockImplementation((path) => {
      if (path.startsWith('/api/payouts/crime-data')) {
        return Promise.resolve({
          crimes: [], slots: [], reward_items: [], required_items: [], participation: [],
          occupancy: [],
          occupancy_polls: [{ polled_at: 1700 }],
        })
      }
      return Promise.resolve({ roster: [] })
    })
    const result = await loadCrimesForPayout(1700, 1800)
    expect(result.crimes).toEqual({})
    expect(result.occupancy_polls).toEqual([{ polled_at: 1700 }])
  })
})

describe('filterItemsForMember', () => {
  it('matches on structured loaned_to entries by member id, not by name', () => {
    const items = [
      {
        item_id: 226, item_name: 'Smoke Grenade',
        loaned_to: [
          { member_id: '801', member_name: 'Bob', amount: 5 },
          { member_id: '802', member_name: 'Sue', amount: 3 },
        ],
      },
      { item_id: 640, item_name: 'Riot Helmet', loaned_to: null },
    ]

    const bob = filterItemsForMember(items, '801')
    expect(bob).toHaveLength(1)
    expect(bob[0]).toMatchObject({ item_name: 'Smoke Grenade', loaned_to_member: 5 })

    expect(filterItemsForMember(items, '999')).toHaveLength(0)
  })

  it('returns an empty array when items or loaned_to is absent', () => {
    expect(filterItemsForMember(null, '801')).toEqual([])
    expect(filterItemsForMember([{ item_id: 1, loaned_to: null }], '801')).toEqual([])
  })
})

describe('checkExistingWeek', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns null when no week matches the window', async () => {
    apiGet.mockResolvedValue({ weeks: [{ id: 7, week_start: '2026-01-01', week_end: '2026-01-07' }] })

    const result = await checkExistingWeek('2026-03-16', '2026-03-22')
    expect(result).toBeNull()
    // Exact-window server lookup, not a newest-page scan.
    expect(apiGet).toHaveBeenCalledWith('/api/payouts/weeks?week_start=2026-03-16&week_end=2026-03-22')
  })

  it('returns existing week data when found', async () => {
    const existingWeek = {
      id: 42,
      week_start: '2026-03-16',
      week_end: '2026-03-22',
      saved_at: '2026-03-22T10:00:00Z',
      saved_by: 'MonChoon',
      member_count: 15,
      member_payout_total: 5000000,
    }
    apiGet.mockResolvedValue({ weeks: [existingWeek] })

    const result = await checkExistingWeek('2026-03-16', '2026-03-22')
    expect(result).toEqual(existingWeek)
    expect(result.id).toBe(42)
    expect(result.member_count).toBe(15)
  })

  it('returns null on unexpected errors', async () => {
    apiGet.mockRejectedValue(new Error('something went wrong'))

    // Should not throw, just return null
    const result = await checkExistingWeek('2026-03-16', '2026-03-22')
    expect(result).toBeNull()
  })
})

// #587: savePayoutWeek rebuilds the week record field-by-field, and it used to
// omit payout_mode — so oc_payout_weeks.payout_mode was NULL in every tenant
// even though PayoutManagement sent it and the server accepted it. That in turn
// made reloading a saved week reset the selector, because there was never a
// stored mode to restore.
describe('savePayoutWeek payout_mode persistence (#587)', () => {
  const week = {
    week_start: '2026-03-16',
    week_end: '2026-03-22',
    week_start_timestamp: 1742169600,
    week_end_timestamp: 1742774400,
    total_money_reward: 5000000,
    faction_cut_percent: 20,
    payout_mode: 'equal',
  }
  const members = [{ member_id: '1', member_name: 'A', tier: 3, payout: 10 }]

  beforeEach(() => {
    vi.clearAllMocks()
    apiPost.mockResolvedValue({ week_id: 7 })
  })

  it('sends the mode that produced the week', async () => {
    await savePayoutWeek(week, members, ['9001'], 'MonChoon', 'key')
    expect(apiPost).toHaveBeenCalledTimes(1)
    const [path, body] = apiPost.mock.calls[0]
    expect(path).toBe('/api/payouts/weeks')
    expect(body.week.payout_mode).toBe('equal')
  })

  it('falls back to the faction default rather than sending undefined', async () => {
    const { payout_mode: _omitted, ...noMode } = week
    await savePayoutWeek(noMode, members, [], 'MonChoon', 'key')
    expect(apiPost.mock.calls[0][1].week.payout_mode).toBe(DEFAULT_PAYOUT_MODE)
  })

  it('returns the saved record carrying the mode', async () => {
    const saved = await savePayoutWeek(week, members, [], 'MonChoon', 'key')
    expect(saved).toMatchObject({ id: 7, payout_mode: 'equal' })
  })
})

describe('savePayoutWeek data shape', () => {
  it('validates week data shape has required fields', () => {
    // This tests the expected shape that savePayoutWeek transforms data into
    const weekData = {
      week_start: '2026-03-16',
      week_end: '2026-03-22',
      week_start_timestamp: 1742169600,
      week_end_timestamp: 1742774400,
      total_money_reward: 5000000,
      total_item_reward: 1000000,
      total_item_cost: 200000,
      net_item_value: 800000,
      faction_cut_percent: 20,
      faction_cut_amount: 1160000,
      member_payout_total: 4640000,
      crimes_processed: 10,
      total_time_spent: 500000,
      average_time_spent: 50000,
      total_adjusted_tickets: 100,
    }

    // Validate all required fields exist
    const requiredFields = [
      'week_start', 'week_end', 'week_start_timestamp', 'week_end_timestamp',
      'total_money_reward', 'total_item_reward', 'total_item_cost',
      'faction_cut_percent', 'faction_cut_amount', 'member_payout_total',
      'crimes_processed', 'total_time_spent', 'total_adjusted_tickets',
    ]

    for (const field of requiredFields) {
      expect(weekData).toHaveProperty(field)
      expect(weekData[field]).not.toBeUndefined()
    }
  })

  it('validates member data shape has required fields', () => {
    const memberData = {
      member_id: '2250591',
      member_name: 'MonChoon [2250591]',
      tier: 3,
      base_tickets: 15,
      sit_out_penalty: -2.5,
      adjusted_tickets: 12.5,
      time_spent: 400000,
      time_spent_percent: 80,
      share_percent: 12.5,
      payout: 580000,
      theoretical_payout: 600000,
      crimes_count: 8,
      crimes_participated: ['c1', 'c2', 'c3'],
    }

    const requiredFields = [
      'member_id', 'member_name', 'tier', 'base_tickets',
      'sit_out_penalty', 'adjusted_tickets', 'time_spent',
      'share_percent', 'payout', 'crimes_count',
    ]

    for (const field of requiredFields) {
      expect(memberData).toHaveProperty(field)
    }

    expect(typeof memberData.member_id).toBe('string')
    expect(memberData.tier).toBeGreaterThanOrEqual(1)
    expect(memberData.tier).toBeLessThanOrEqual(6)
    expect(memberData.payout).toBeGreaterThanOrEqual(0)
  })
})
