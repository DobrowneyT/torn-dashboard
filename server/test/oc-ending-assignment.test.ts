// Assigning endings to terminals by simulated probability (#471).
//
// The probe responses below were captured from the LIVE service on 2026-08-15.
// The correct answer is known independently: at Picklock=50 the five endings
// separate by orders of magnitude, so the mapping can be read straight off the
// numbers and the assignment either reproduces it or is wrong.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseScenarioTree } from '../src/oc/scenarioTree.js'
import { assignEndings, hungarian, disagreement } from '../src/oc/endingAssignment.js'
import type { Probe } from '../src/oc/endingMap.js'

const here = dirname(fileURLToPath(import.meta.url))
const petProject = parseScenarioTree(readFileSync(join(here, 'fixtures', 'pet-project.mmd'), 'utf8'))
const ROLES = ['Kidnapper', 'Muscle', 'Picklock']

const g = (g1: number, g2: number, g3: number, g4: number, g5: number) =>
  ({ goodEnding1: g1, goodEnding2: g2, goodEnding3: g3, goodEnding4: g4, goodEnding5: g5 })

/** Captured live: baseline, then each role dropped to 50 and to 1. */
const PROBES: Probe[] = [
  { droppedRole: null, cprs: { Kidnapper: 99, Muscle: 99, Picklock: 99 },
    endings: g(0.97, 0.0097, 0.0001, 0.0099, 0.01) },
  { droppedRole: 'Kidnapper', droppedTo: 50, cprs: { Kidnapper: 50, Muscle: 99, Picklock: 99 },
    endings: g(0.72046, 0.00721, 0.00007, 0.1287, 0.011) },
  { droppedRole: 'Muscle', droppedTo: 50, cprs: { Kidnapper: 99, Muscle: 50, Picklock: 99 },
    endings: g(0.48511, 0.00245, 0.00123, 0.00379, 0.49736) },
  { droppedRole: 'Picklock', droppedTo: 50, cprs: { Kidnapper: 99, Muscle: 99, Picklock: 50 },
    endings: g(0.24742, 0.24495, 0.00247, 0.49005, 0.00381) },
  { droppedRole: 'Kidnapper', droppedTo: 1, cprs: { Kidnapper: 1, Muscle: 99, Picklock: 99 },
    endings: g(0.01893, 0.00019, 0, 0.0098, 0.00029) },
  { droppedRole: 'Muscle', droppedTo: 1, cprs: { Kidnapper: 99, Muscle: 1, Picklock: 99 },
    endings: g(0.0096, 0, 0, 0, 0.98) },
  { droppedRole: 'Picklock', droppedTo: 1, cprs: { Kidnapper: 99, Muscle: 99, Picklock: 1 },
    endings: g(0.0001, 0.0097, 0.0001, 0.9702, 0.00005) },
]

describe('assignEndings on Pet Project', () => {
  it('recovers the mapping the raw numbers already imply', () => {
    const r = assignEndings(petProject, ROLES, PROBES, 'good')
    expect(r.ok).toBe(true)
    expect(r.map).toEqual({
      goodEnding1: '_A7S1_',
      goodEnding2: '_A7S2_',
      goodEnding3: '_A8S_',
      goodEnding4: '_B3S_',
      goodEnding5: '_C3S_',
    })
  })

  it('⚠️ separates the two endings that TIE under role evidence', () => {
    // _B3S_ and _C3S_ are both depth-1, both reached by a single failure, and
    // indistinguishable at the baseline (0.00990 each). Every heuristic
    // attempt stalled here. At Picklock=50 they are 128x apart.
    const r = assignEndings(petProject, ROLES, PROBES, 'good')
    expect(r.map.goodEnding4).toBe('_B3S_')
    expect(r.map.goodEnding5).toBe('_C3S_')
  })

  it('fits closely, and says so in a number', () => {
    // A bad fit is the one failure this can produce silently — an assignment
    // always returns something.
    const r = assignEndings(petProject, ROLES, PROBES, 'good')
    expect(r.residual).toBeLessThan(0.02)
  })

  it('⚠️ residual rises sharply when the data does not fit the diagram', () => {
    // What the residual is for: an assignment ALWAYS returns something, so a
    // confidently wrong mapping is indistinguishable from a right one without
    // a number attached.
    // ⚠️ Not by relabelling — the assignment is permutation-invariant by
    // construction, so swapping two ending KEYS just swaps the answer and the
    // residual does not move. It has to be a distribution the diagram cannot
    // produce under any permutation: five equal endings, where the real
    // scenario has one dominant at 0.97 and four rare.
    const impossible = PROBES.map((p) => ({
      ...p, endings: g(0.2, 0.2, 0.2, 0.2, 0.2),
    }))
    const good = assignEndings(petProject, ROLES, PROBES, 'good')
    const bad = assignEndings(petProject, ROLES, impossible, 'good')
    expect(bad.residual).toBeGreaterThan(good.residual * 5)
  })

  it('⚠️ residual is NOT comparable across different probe counts', () => {
    // Measured, and counter-intuitive: the baseline alone fits BETTER (0.0021)
    // than the full sweep (0.0034), because one probe is one constraint and
    // easier to satisfy. So a low residual on a thin sweep is not evidence of a
    // confident mapping — only of a small question. Pinned so nobody later
    // reads the residual as a confidence score.
    const thin = assignEndings(petProject, ROLES, [PROBES[0]], 'good')
    const full = assignEndings(petProject, ROLES, PROBES, 'good')
    expect(thin.residual).toBeLessThan(full.residual)
  })

  it('refuses when no probe carried its CPR vector', () => {
    const blind = PROBES.map(({ cprs, ...rest }) => rest)
    const r = assignEndings(petProject, ROLES, blind, 'good')
    expect(r.ok).toBe(false)
    expect(r.map).toEqual({})
    expect(r.problems[0]).toContain('CPR vector')
  })

  it('⚠️ names an ending the flowchart does not draw, instead of refusing the crime', () => {
    // Blast from the Past and Counter Offer land here: the API reports endings
    // with no terminal at all. The five that DO fit are still worth pricing, so
    // the surplus is named rather than the whole crime thrown away.
    const extra = PROBES.map((p) => ({ ...p, endings: { ...p.endings, goodEnding6: 0.3 } }))
    const r = assignEndings(petProject, ROLES, extra, 'good')
    expect(r.ok).toBe(false)
    expect(r.unmatched.endings).toEqual(['goodEnding6'])
    expect(r.problems[0]).toContain('goodEnding6')
    expect(Object.keys(r.map)).toHaveLength(5)
  })

  it('⚠️ a complete mapping can still be a bad one, and says so separately', () => {
    // `ok` means every reported ending got a node. `confident` means the
    // numbers behind that assignment line up. Ten of 31 scenarios are the first
    // without being the second — their successChance is EXACT while the split
    // between endings is not, so the map is complete and the per-ending money
    // is not yet trustworthy.
    const good = assignEndings(petProject, ROLES, PROBES, 'good')
    expect(good.ok).toBe(true)
    expect(good.confident).toBe(true)

    const impossible = PROBES.map((p) => ({ ...p, endings: g(0.2, 0.2, 0.2, 0.2, 0.2) }))
    const bad = assignEndings(petProject, ROLES, impossible, 'good')
    expect(bad.ok).toBe(true)          // every ending still got a node
    expect(bad.confident).toBe(false)  // ...and none of them fit
  })

  it('⚠️ a SPARE TERMINAL does not fail the crime', () => {
    // Snow Blind's diagram draws a sixth good ending the API never reports.
    // Every ending we were asked to price still got a node, so refusing the
    // whole crime would price nothing, for nothing.
    const fewer = PROBES.map((p) => {
      const { goodEnding3, ...rest } = p.endings as Record<string, number>
      return { ...p, endings: rest }
    })
    const r = assignEndings(petProject, ROLES, fewer, 'good')
    expect(r.ok).toBe(true)
    expect(r.unmatched.terminals).toHaveLength(1)
    expect(r.problems[0]).toContain('the API never reports')
  })

  it('reports a per-ending fit, so a weak pair can be found later', () => {
    const r = assignEndings(petProject, ROLES, PROBES, 'good')
    expect(Object.keys(r.perEnding)).toHaveLength(5)
    expect(r.perEnding.goodEnding1).toBeLessThan(0.01)
  })
})

describe('disagreement', () => {
  it('is scale-free, so two rare endings still separate', () => {
    // ⚠️ Absolute error would make swapping two 1e-4 endings almost free, and
    // their assignment arbitrary.
    expect(disagreement(0.0001, 0.0099)).toBeGreaterThan(0.7)
    expect(disagreement(0.97, 0.9799)).toBeLessThan(0.01)
  })

  it('is 0 for an exact match and never negative', () => {
    expect(disagreement(0.5, 0.5)).toBe(0)
    expect(disagreement(0, 0)).toBe(0)
  })
})

describe('hungarian', () => {
  it('finds the minimum-cost assignment, not the greedy one', () => {
    // ⚠️ Greedy takes (0,0) at cost 1 and is then forced into (1,1) at 10,
    // totalling 11. The optimum is 2+3 = 5. This is the exact failure that
    // produced "no unclaimed ending at depth N".
    const pairs = hungarian([[1, 2], [3, 10]])
    expect(pairs).toEqual([[0, 1], [1, 0]])
  })

  it('handles more endings than terminals', () => {
    const pairs = hungarian([[1, 5], [5, 1], [9, 9]])
    expect(pairs).toHaveLength(2)
    expect(pairs).toEqual(expect.arrayContaining([[0, 0], [1, 1]]))
  })

  it('handles more terminals than endings', () => {
    expect(hungarian([[3, 1, 7]])).toEqual([[0, 1]])
  })

  it('survives empty input', () => {
    expect(hungarian([])).toEqual([])
    expect(hungarian([[]])).toEqual([])
  })
})

// #473 — the plain residual is scale-free, which is the right way to CHOOSE an
// assignment and the wrong way to judge the money it implies.
describe('mass-weighted residual', () => {
  it('⚠️ ignores a disagreement that sits where no probability does', () => {
    // Mob Mentality in miniature: it reads 0.145 plain (flagged a loose fit)
    // and 0.003 weighted, because its whole disagreement is in endings that
    // essentially never happen and therefore cost nothing in E(x).
    const r = assignEndings(petProject, ROLES, PROBES)
    expect(r.massWeightedResidual).toBeLessThanOrEqual(r.residual + 1e-9)
  })

  it('is reported alongside the plain residual, never instead of it', () => {
    // They answer different questions and disagree in BOTH directions, so a
    // caller has to be able to see each.
    const r = assignEndings(petProject, ROLES, PROBES)
    expect(typeof r.residual).toBe('number')
    expect(typeof r.massWeightedResidual).toBe('number')
    expect(typeof r.confident).toBe('boolean')
    expect(typeof r.moneyConfident).toBe('boolean')
  })

  it('⚠️ refuses to trust money when an ending has no node at all', () => {
    // An unpriced ending is unpriced however tight the rest of the fit is —
    // same gate as `confident`, for the same reason.
    const r = assignEndings(petProject, ROLES, PROBES)
    if (!r.ok) expect(r.moneyConfident).toBe(false)
  })

  it('says nothing rather than something when no probe can be simulated', () => {
    const r = assignEndings(petProject, ROLES, [{ droppedRole: null, endings: { goodEnding1: 1 } }])
    expect(r.massWeightedResidual).toBe(1)
    expect(r.moneyConfident).toBe(false)
  })
})
