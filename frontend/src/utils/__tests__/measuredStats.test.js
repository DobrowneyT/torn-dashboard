// #996 — a measured score applied to a target row.
import { describe, expect, it } from 'vitest'
import { applyMeasuredStats, statsSourceLabel } from '../warRoomBattleStats'
import { battleStatsScore, scoreIsEstimated, targetBattleStats, fairFight } from '../fairFight'

const row = {
  member_id: 9, bsp_total: 4e8, bsp_str: 2e8, bsp_spd: 1e8, bsp_def: 5e7, bsp_dex: 5e7,
  spy_source: 'tornstats',
}

describe('applyMeasuredStats', () => {
  it('leaves a row without a measurement untouched', () => {
    expect(applyMeasuredStats(row)).toBe(row)
  })

  it('scales the spy breakdown to the measured score, keeping its shape', () => {
    const spy = battleStatsScore({ strength: 2e8, speed: 1e8, defense: 5e7, dexterity: 5e7 })
    const out = applyMeasuredStats({ ...row, measured_score: spy * 1.5, measured_bound: 'exact' })
    expect(battleStatsScore(targetBattleStats(out))).toBeCloseTo(spy * 1.5, 0)
    expect(out.bsp_str / out.bsp_spd).toBeCloseTo(2, 3)
    expect(out).toMatchObject({ spy_source: 'measured', measured_split: 'spy', est_total: 4e8, est_source: 'tornstats' })
    expect(statsSourceLabel(out.spy_source)).toBe('DB')
  })

  it('splits evenly with no breakdown, and the FF is not marked as estimated', () => {
    const out = applyMeasuredStats({ member_id: 9, bsp_total: 1e8, spy_source: 'bsp', measured_score: 15000 })
    expect(out.measured_split).toBe('even')
    expect(battleStatsScore(targetBattleStats(out))).toBeCloseTo(15000, 0)
    expect(scoreIsEstimated(targetBattleStats(out))).toBe(false)
    // A hitter of score 40,000 gets FF 2.00 against it — the hit it came from.
    expect(fairFight({ strength: 1e8, speed: 1e8, defense: 1e8, dexterity: 1e8 }, targetBattleStats(out))).toBeCloseTo(2, 2)
  })
})
