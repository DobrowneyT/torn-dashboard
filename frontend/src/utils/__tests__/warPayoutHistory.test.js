// Saved RW payout history — the reload path that regenerates a batch URL.
import { describe, it, expect } from 'vitest'
import {
  summariseWarPayoutRow,
  restoredWarPayoutSettings,
  restoredEligibilityOverrides,
  restoredMultiplierOverrides,
  driftAgainst,
} from '../warPayoutHistory'

const payout = {
  id: 7,
  war_id: 46877,
  war_type: 'real',
  faction_cut_percent: 20,
  total_payout: 4053760000,
  member_count: 100,
  min_score_threshold: 50,
  created_by: 2749598,
  // What the API actually serves: Postgres timestamptz text, bare "+00".
  created_at: '2026-08-09T18:04:11.512345+00',
  notes: 'war 46877 final',
  war_opponent_name: 'Natural Selection',
  war_opponent_id: 9001,
  war_start_at: 1754179200,
  war_end_at: 1754438400,
  war_payout_members: [
    { member_id: 1, member_name: 'A', score: 400, payout_amount: 3000, is_eligible: true },
    { member_id: 2, member_name: 'B', score: 100, payout_amount: 1000, is_eligible: true },
    { member_id: 3, member_name: 'C', score: 10, payout_amount: 0, is_eligible: false },
  ],
}

describe('summariseWarPayoutRow', () => {
  it('parses the saved-at timestamp instead of rendering "Invalid Date"', () => {
    // The bug this whole change started from: `new Date` on a bare "+00"
    // offset is NaN, and every row in the history read "Invalid Date".
    expect(Number.isNaN(Date.parse(payout.created_at))).toBe(true)
    const row = summariseWarPayoutRow(payout)
    expect(row.savedAt?.getTime()).toBe(Date.UTC(2026, 7, 9, 18, 4, 11, 512))
  })

  it('totals only the eligible members', () => {
    expect(summariseWarPayoutRow(payout).totalPayout).toBe(4000)
    expect(summariseWarPayoutRow(payout).eligibleCount).toBe(2)
    expect(summariseWarPayoutRow(payout).memberCount).toBe(3)
  })

  it('falls back to the stored total when the member rows are gone', () => {
    const row = summariseWarPayoutRow({ ...payout, war_payout_members: [] })
    expect(row.totalPayout).toBe(4053760000)
    expect(row.memberCount).toBe(100)
  })

  it('carries the opponent, and reports its absence as null not ""', () => {
    expect(summariseWarPayoutRow(payout).opponent).toBe('Natural Selection')
    // A LEFT JOIN can legitimately produce no war row; the caller renders a
    // dash for null, which is different from a faction whose name is blank.
    expect(summariseWarPayoutRow({ ...payout, war_opponent_name: null }).opponent).toBeNull()
  })

  it('survives a row with no created_at rather than throwing', () => {
    expect(summariseWarPayoutRow({ ...payout, created_at: null }).savedAt).toBeNull()
  })
})

describe('restoredWarPayoutSettings', () => {
  it('restores the controls the payout was computed with', () => {
    const s = restoredWarPayoutSettings({
      ...payout,
      war_type: 'termed',
      total_reward: 5_000_000_000,
      post_dist_mode: 'flat',
      post_scale_enabled: true,
      post_scale_hours: 24,
      race_pre_cutoff_percent: 0,
      race_cutoff_timestamp: 1754179200,
    })
    expect(s.warClass).toBe('termed')
    expect(s.totalReward).toBe(5_000_000_000)
    expect(s.postDistMode).toBe('flat')
    expect(s.postScaleEnabled).toBe(true)
    expect(s.postScaleHours).toBe(24)
    expect(s.racePreCutoffPercent).toBe(0)
    expect(s.raceCutoffTimestamp).toBe(1754179200)
  })

  it('pins the cutoff to manual', () => {
    // A payout saved in 'auto' has a cutoff the detector picked at the time.
    // Reloading in 'auto' lets it re-detect against data that has since
    // changed, moving the cutoff off the one the money was calculated with.
    expect(restoredWarPayoutSettings({ ...payout, race_cutoff_mode: 'auto' }).raceCutoffMode).toBe('manual')
  })

  it('does not feed outputs back in as inputs', () => {
    const s = restoredWarPayoutSettings(payout)
    expect(s).not.toHaveProperty('totalPayout')
    expect(s).not.toHaveProperty('memberCount')
  })

  it('uses defaults for a legacy payout missing the newer columns', () => {
    const s = restoredWarPayoutSettings({ war_id: 1, war_type: 'real' })
    expect(s.factionCutPercent).toBe(20)
    expect(s.minScoreThreshold).toBe(50)
    expect(s.postDistMode).toBe('formula')
    expect(s.postScaleEnabled).toBe(false)
    expect(Number.isNaN(s.totalReward)).toBe(false)
  })

  it('keeps a stored zero rather than treating it as missing', () => {
    // The Number(null) === 0 trap from the other side: 0% pre-cutoff is the
    // termed preset, and defaulting it to 50 would rewrite the payout.
    expect(restoredWarPayoutSettings({ ...payout, race_pre_cutoff_percent: 0 }).racePreCutoffPercent).toBe(0)
    expect(restoredWarPayoutSettings({ ...payout, war_hit_multiplier: 0 }).warHitMult).toBe(0)
  })
})

describe('restoredEligibilityOverrides', () => {
  it('writes an override only where the saved sheet disagrees with the threshold', () => {
    const overrides = restoredEligibilityOverrides({
      min_score_threshold: 50,
      war_payout_members: [
        { member_id: 1, score: 400, is_eligible: true },   // agrees → no override
        { member_id: 2, score: 10, is_eligible: true },    // forced eligible
        { member_id: 3, score: 400, is_eligible: false },  // forced ineligible
        { member_id: 4, score: 10, is_eligible: false },   // agrees → no override
      ],
    })
    expect(overrides).toEqual({ 2: true, 3: false })
  })

  it('leaves the map empty when nothing was overridden', () => {
    expect(restoredEligibilityOverrides({
      min_score_threshold: 50,
      war_payout_members: [{ member_id: 1, score: 400, is_eligible: true }],
    })).toEqual({})
  })
})

describe('restoredMultiplierOverrides', () => {
  it('keys the saved per-member tweaks by member id', () => {
    expect(restoredMultiplierOverrides({
      war_payout_members: [
        { member_id: 1, multiplier_overrides: { warHit: 2 } },
        { member_id: 2, multiplier_overrides: null },
      ],
    })).toEqual({ 1: { warHit: 2 } })
  })
})

describe('driftAgainst', () => {
  const recomputed = [
    { memberId: 1, payoutAmount: 3000, isEligible: true },
    { memberId: 2, payoutAmount: 1000, isEligible: true },
    { memberId: 3, payoutAmount: 0, isEligible: false },
  ]

  it('reports a clean match when the recalculation reproduces the sheet', () => {
    const d = driftAgainst(payout, recomputed)
    expect(d.matches).toBe(true)
    expect(d.changed).toEqual([])
    expect(d.savedTotal).toBe(4000)
    expect(d.recomputedTotal).toBe(4000)
  })

  it('catches an amount that moved', () => {
    const d = driftAgainst(payout, [{ ...recomputed[0], payoutAmount: 3500 }, recomputed[1], recomputed[2]])
    expect(d.matches).toBe(false)
    expect(d.changed).toEqual([{ memberId: 1, saved: 3000, now: 3500 }])
  })

  it('catches a member who dropped out of the sheet', () => {
    const d = driftAgainst(payout, [recomputed[0], recomputed[2]])
    expect(d.changed).toEqual([{ memberId: 2, saved: 1000, now: null }])
  })

  it('catches a member who appeared since', () => {
    const d = driftAgainst(payout, [...recomputed, { memberId: 9, payoutAmount: 500, isEligible: true }])
    expect(d.changed).toEqual([{ memberId: 9, saved: null, now: 500 }])
  })

  it('ignores sub-currency differences the batch URL would floor away anyway', () => {
    // generateWarBatchPayoutURL floors, so a fractional cent is not drift the
    // user can act on — flagging it would train them to ignore the warning.
    const d = driftAgainst(payout, [{ ...recomputed[0], payoutAmount: 3000.4 }, recomputed[1], recomputed[2]])
    expect(d.matches).toBe(true)
  })
})

// ── #871 verification: RW payouts are already static ─────────────────────────
//
// ⚠️ The RW half of #871 is VERIFICATION, not construction. `war_payouts` was
// built to this principle from the start: it stores the cache prices as used
// (`price_*_cache`), every multiplier and weight, and `total_reward` — the pot
// itself. Loading a saved payout restores those as INPUTS and recomputes from
// them, so the result is deterministic and reproduces what was paid.
//
// That is a different design from OC, which rebuilt its item breakdown from
// live data and re-priced it at the current market. These tests pin the
// property so a future change cannot quietly give RW the OC bug.
describe('#871 — a saved war payout recomputes from stored inputs only', () => {
  it('takes the pot from the stored row, not from live cache prices', () => {
    // `total_reward` is the money the payout was built against. Re-deriving it
    // from today's cache prices is exactly the OC bug.
    const s = restoredWarPayoutSettings({ total_reward: 4_200_000_000, faction_cut_percent: 15 })
    expect(s.totalReward).toBe(4_200_000_000)
    expect(s.factionCutPercent).toBe(15)
  })

  it('⚠️ never feeds an OUTPUT back in as an input', () => {
    // total_payout / member_count are results of the calculation. Restoring
    // them as inputs is how a reloaded payout quietly stops matching itself.
    const s = restoredWarPayoutSettings({
      total_reward: 100, total_payout: 999_999, member_count: 42, war_id: 7,
    })
    expect(Object.values(s)).not.toContain(999_999)
    expect(Object.values(s)).not.toContain(42)
    expect(s).not.toHaveProperty('totalPayout')
    expect(s).not.toHaveProperty('memberCount')
  })

  it('restores every weight that moves the split', () => {
    const s = restoredWarPayoutSettings({
      attacks_weight: 0.7, assist_multiplier: 0.3, min_score_threshold: 25,
      merc_cost: 11, reviver_cost: 22, faction_top_up: 33,
    })
    expect(s.minScoreThreshold).toBe(25)
    expect(s.mercCost).toBe(11)
    expect(s.reviverCost).toBe(22)
    expect(s.factionTopUp).toBe(33)
  })

  it('falls back to documented defaults rather than inventing a number', () => {
    const s = restoredWarPayoutSettings({})
    expect(s.factionCutPercent).toBe(20)
    expect(s.totalReward).toBe(0)
    expect(s.minScoreThreshold).toBe(50)
  })
})
