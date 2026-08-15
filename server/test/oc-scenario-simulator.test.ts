// Forward-simulating the flowchart (#471).
//
// Every expected number here was captured from the LIVE service on 2026-08-15,
// not computed by the code under test. That is the whole point: the simulator's
// claim is that it reproduces tornprobability's own arithmetic, and a fixture I
// generated would only confirm my assumptions back to me.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseScenarioTree } from '../src/oc/scenarioTree.js'
import { simulateScenario, simulatedSuccess, checkpointPass } from '../src/oc/scenarioSimulator.js'

const here = dirname(fileURLToPath(import.meta.url))
const petProject = parseScenarioTree(readFileSync(join(here, 'fixtures', 'pet-project.mmd'), 'utf8'))
const PET_ROLES = ['Kidnapper', 'Muscle', 'Picklock']

const cprs = (over: Record<string, number> = {}) =>
  ({ Kidnapper: 99, Muscle: 99, Picklock: 99, ...over })

const sim = (over?: Record<string, number>) => simulateScenario(petProject, PET_ROLES, cprs(over))

describe('checkpointPass', () => {
  it('uses the named role\'s CPR', () => {
    expect(checkpointPass('Picklock tries to pick the lock.', PET_ROLES, cprs({ Picklock: 50 })))
      .toBeCloseTo(0.5, 6)
  })

  it('⚠️ AVERAGES several named roles — they are not all required to pass', () => {
    // Both MonChoon and I assumed a product. Measured against the service's own
    // successChance across all 31 scenarios, a product was the WORST of five
    // candidate rules (0.0350 mean error) and the average the best (0.0131,
    // exactly zero on seven scenarios). Confirmed by MonChoon 2026-08-15.
    //
    // 40 and 80 average to 60% — not 32% (product) and not 40% (weakest link).
    const p = checkpointPass('Looter 1 and Looter 2 heave the cabinet over.',
      ['Looter 1', 'Looter 2'], { 'Looter 1': 40, 'Looter 2': 80 })
    expect(p).toBeCloseTo(0.6, 6)
    expect(p).not.toBeCloseTo(0.32, 2)
    expect(p).not.toBeCloseTo(0.4, 2)
  })

  it('averages three roles the same way as two', () => {
    // MonChoon: "doesnt matter if its 2, 3, or more".
    expect(checkpointPass('A and B hold the doors while C moves the dish.',
      ['A', 'B', 'C'], { A: 30, B: 60, C: 90 })).toBeCloseTo(0.6, 6)
  })

  it('⚠️ treats a checkpoint naming NO role as the whole crew', () => {
    // "The whole team assaults the guards", "The crew finds the side entrance
    // locked" — six of 604 checkpoints read this way. A hard-coded default
    // would be a number nobody measured.
    expect(checkpointPass('The whole team rushes the guards.', PET_ROLES,
      cprs({ Kidnapper: 30, Muscle: 60, Picklock: 90 }))).toBeCloseTo(0.6, 6)
  })

  it('counts a role the prose makes sound incidental', () => {
    // Stacking the Deck: "Seeing Cat Burglar struggle, Imitator tries to help"
    // fits to 1e-05 only with Cat Burglar included. MonChoon confirmed the
    // narrative is written around the maths, not the other way round.
    expect(checkpointPass('Seeing Cat Burglar struggle, Imitator tries to help.',
      ['Cat Burglar', 'Imitator'], { 'Cat Burglar': 0, Imitator: 100 })).toBeCloseTo(0.5, 6)
  })
})

describe('simulateScenario against the live service', () => {
  it('reproduces the all-99 distribution', () => {
    // Captured live: g1=0.97 g5=0.01 g4=0.0099 g2=0.0097 g3=0.0001
    const s = sim()
    expect(s.get('_A7S1_')).toBeCloseTo(0.97, 4)   // goodEnding1
    expect(s.get('_C3S_')).toBeCloseTo(0.01, 4)    // goodEnding5
    expect(s.get('_B3S_')).toBeCloseTo(0.0099, 4)  // goodEnding4
    expect(s.get('_A7S2_')).toBeCloseTo(0.0097, 4) // goodEnding2
    expect(s.get('_A8S_')).toBeCloseTo(0.0001, 4)  // goodEnding3
  })

  it('⚠️ reproduces a dropped-role distribution, which is where ties break', () => {
    // Captured live at Picklock=50: g4=0.49005 g1=0.24742 g2=0.24495 g3=0.00247
    //
    // _B3S_ and _C3S_ are identical at the baseline and 200x apart here. That
    // separation is the entire reason inference could not finish the job and
    // simulation can.
    const s = sim({ Picklock: 50 })
    expect(s.get('_B3S_')).toBeCloseTo(0.49005, 4)   // goodEnding4
    expect(s.get('_A7S1_')).toBeCloseTo(0.24742, 4)  // goodEnding1
    expect(s.get('_A7S2_')).toBeCloseTo(0.24495, 4)  // goodEnding2
    expect(s.get('_C3S_')).toBeCloseTo(0.00381, 4)   // goodEnding5
    expect(s.get('_A8S_')).toBeCloseTo(0.00247, 4)   // goodEnding3

    // ⚠️ _C3S_ above is the number that caught the multi-role rule. Under a
    // product it simulated to 0.00254 against the API's 0.00381 — four endings
    // exact and one wrong, which is precisely how a bad model hides.
  })

  it('⚠️ handles a failure that REJOINS the main line', () => {
    // Dropping Kidnapper to 50 leaves the all-pass ending at 0.74 of baseline,
    // not 0.50, because failing _A2_C1_ and passing _A2_C2_ recovers to the
    // same ending: 0.5 + 0.5 x 0.5 = 0.75. This is what made CPR/100 look
    // wrong, and only a forward walk over the real graph sees it.
    const s = sim({ Kidnapper: 50 })
    expect(s.get('_A7S1_')).toBeCloseTo(0.72046, 3)
  })

  it('conserves probability — no mass invented or lost', () => {
    for (const v of [cprs(), cprs({ Picklock: 50 }), cprs({ Muscle: 1, Picklock: 25 })]) {
      const total = [...simulateScenario(petProject, PET_ROLES, v).values()]
        .reduce((a, b) => a + b, 0)
      expect(total).toBeCloseTo(1, 6)
    }
  })

  it('records an unreachable terminal at zero rather than omitting it', () => {
    // "Cannot happen at these CPRs" and "not in this diagram" are different
    // facts, and the assignment step needs to tell them apart.
    const s = sim({ Picklock: 100, Muscle: 100, Kidnapper: 100 })
    expect(s.has('_A8S_')).toBe(true)
    expect(s.get('_A8S_')).toBeCloseTo(0, 6)
  })
})

describe('simulatedSuccess', () => {
  it('matches the API successChance at the baseline', () => {
    // Live: successChance 0.9997 at all-99.
    expect(simulatedSuccess(petProject, PET_ROLES, cprs())).toBeCloseTo(0.9997, 4)
  })

  it('matches it with a role dropped', () => {
    // ⚠️ This is the check that settled the multi-role rule, because it needs
    // no ending map at all — the model can be validated independently of the
    // thing it is being built to derive.
    // Live per-ending values at Picklock=50 sum to 0.98870.
    expect(simulatedSuccess(petProject, PET_ROLES, cprs({ Picklock: 50 })))
      .toBeCloseTo(0.9887, 3)
    expect(simulatedSuccess(petProject, PET_ROLES, cprs({ Muscle: 50 })))
      .toBeCloseTo(0.98994, 3)
  })
})
