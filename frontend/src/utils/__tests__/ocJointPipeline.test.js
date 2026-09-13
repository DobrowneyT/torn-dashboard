// #714 wiring — running the joint solve against the crimes on screen.
import { describe, expect, it, vi } from 'vitest'
import { solveForSelection } from '../ocJointPipeline'

const roles = (n) => Array.from({ length: n }, (_, i) => ({ position_id: `P${i + 1}`, role_name: `R${i}`, weight: 100 / n }))
const crime = (name, n) => ({
  name, roles: roles(n),
  endings: [
    { ending_key: 'goodEnding1', kind: 'good', resolved: true, node_id: 'A', money_avg: 100_000_000 },
    { ending_key: 'badEnding1', kind: 'bad', resolved: true, node_id: 'F' },
  ],
})
const CRIMES = [crime('Alpha', 4), crime('Beta', 4)]

const pool = (n = 24) => Array.from({ length: n }, (_, i) => ({ member_id: `m${i}`, cpr: 95 - i }))
const readingsFor = (c) => Object.fromEntries(c.roles.map((r) => [r.position_id, pool()]))

const call = vi.fn(async (n, p) => {
  const avg = p.reduce((a, b) => a + b, 0) / p.length
  const g = Math.min(0.95, Math.max(0.01, (avg - 40) / 60))
  return { result: { successChance: g, failureChance: 1 - g, goodEnding1: g, badEnding1: 1 - g } }
})

const base = {
  crimes: CRIMES,
  fetchReadings: async (name) => ({
    readings: readingsFor(CRIMES.find((c) => c.name === name)), roster_size: 24,
  }),
  categoryOf: () => ({ scopeCost: 4, scopeReward: 5 }),
  call, days: 20, spawnsPerDay: 1, gap: 0.5,
}

describe('solveForSelection', () => {
  it('solves the selected crimes together', async () => {
    const out = await solveForSelection(base)
    expect(Object.keys(out.chosen).sort()).toEqual(['Alpha', 'Beta'])
    expect(out.rosterSize).toBe(24)
  })

  it('reports nothing selected rather than pretending to solve', async () => {
    const out = await solveForSelection({ ...base, crimes: [] })
    expect(out.reason).toBe('nothing-selected')
  })

  it('⚠️ keeps solving when one crime\'s roster cannot be fetched', async () => {
    // One endpoint failing must not cost the whole plan.
    const out = await solveForSelection({
      ...base,
      fetchReadings: async (name) => {
        if (name === 'Beta') throw new Error('500')
        return { readings: readingsFor(CRIMES[0]), roster_size: 24 }
      },
    })
    expect(out.chosen.Alpha).toBeDefined()
    expect(out.skipped.Beta).toBe('roster-unavailable')
  })

  it('⚠️ preserves "never observed" as its own reason', async () => {
    // tnl has readings for ten crimes and history for twenty-one. The other
    // eleven are a measurement gap, not an impossible crime (#351).
    const out = await solveForSelection({
      ...base,
      fetchReadings: async (name) => ({
        readings: name === 'Beta'
          ? { ...readingsFor(CRIMES[1]), P1: [] }
          : readingsFor(CRIMES[0]),
        roster_size: 24,
      }),
    })
    expect(out.skipped.Beta).toBe('no-readings')
  })

  it('takes the roster size from the faction, not from a crime', async () => {
    const out = await solveForSelection({
      ...base,
      fetchReadings: async (name) => ({
        readings: readingsFor(CRIMES.find((c) => c.name === name)),
        roster_size: name === 'Alpha' ? 24 : 0,
      }),
    })
    expect(out.rosterSize).toBe(24)
  })
})
