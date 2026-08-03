// #249: the war utils must attribute attacks/contributions to the TENANT's own
// faction id (resolved at runtime via getFactionId), not a hard-coded Forge id.
// These mock getFactionId to a non-10739 value and assert attribution follows it
// — a regression guard against re-hardcoding.
import { describe, it, expect, vi } from 'vitest'

vi.mock('../factionIdentity', () => ({ getFactionId: () => 555 }))
vi.mock('../apiClient', () => ({ apiGet: vi.fn() }))

import { apiGet } from '../apiClient'
import { buildMemberAttackStats } from '../warPayoutCalculations.js'
import { loadLiveContributionsFromAttacks } from '../warDataLoader.js'

describe('war utils honour the tenant faction id (#249)', () => {
  it('buildMemberAttackStats counts our faction (555) and ignores others (10739)', () => {
    const attacks = [
      { attacker_id: 1, attacker_faction_id: 555, is_incoming: false, is_ranked_war: true, result: 'Attacked', respect_gain: 5, chain: 1 },
      { attacker_id: 2, attacker_faction_id: 10739, is_incoming: false, is_ranked_war: true, result: 'Attacked', respect_gain: 5, chain: 1 },
    ]
    const stats = buildMemberAttackStats(attacks)
    expect(stats.has(1)).toBe(true)   // our faction
    expect(stats.has(2)).toBe(false)  // not us (the old hard-coded id)
  })

  it('loadLiveContributionsFromAttacks derives a leaderboard for our faction (555)', async () => {
    apiGet.mockImplementation((path) => {
      if (path.startsWith('/api/members/roster')) return Promise.resolve({ roster: [] })
      if (path.startsWith('/api/attacks')) return Promise.resolve({ attacks: [
        { attacker_id: 1, attacker_name: 'Ours',  attacker_faction_id: 555,   is_ranked_war: true, is_incoming: false, result: 'Attacked', respect_gain: 8, chain: 1 },
        { attacker_id: 2, attacker_name: 'Enemy', attacker_faction_id: 10739, is_ranked_war: true, is_incoming: false, result: 'Attacked', respect_gain: 8, chain: 1 },
      ] })
      return Promise.resolve({})
    })

    const rows = await loadLiveContributionsFromAttacks({ start_at: 1000, end_at: 2000 })
    const ids = rows.map((r) => r.member_id)
    expect(ids).toContain(1)      // our-faction attacker counted
    expect(ids).not.toContain(2)  // enemy-faction attacker excluded
    expect(rows.find((r) => r.member_id === 1).faction_id).toBe(555)
  })
})
