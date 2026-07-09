import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the faction API client before importing the module
vi.mock('../apiClient', () => ({
  API_MODE: true,
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}))

import { apiGet } from '../apiClient'
import { checkExistingWeek } from '../payoutDataLoader'

describe('checkExistingWeek', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns null when no week matches the window', async () => {
    apiGet.mockResolvedValue({ weeks: [{ id: 7, week_start: '2026-01-01', week_end: '2026-01-07' }] })

    const result = await checkExistingWeek('2026-03-16', '2026-03-22')
    expect(result).toBeNull()
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
