// #473 — the oracle we had been asking at only one point.
//
// `successChance` at all-high is exact for all 31 live scenarios, so validating
// there says nothing. Asked at a dropped CPR, twelve of them disagree with the
// flowchart, and this is the check that says so by role name.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseScenarioTree } from '../src/oc/scenarioTree.js'
import { roleFidelity, MAX_ROLE_FIDELITY_ERROR } from '../src/oc/roleFidelity.js'
import { simulatedSuccess } from '../src/oc/scenarioSimulator.js'
import type { Probe } from '../src/oc/endingMap.js'

const here = dirname(fileURLToPath(import.meta.url))
const tree = parseScenarioTree(readFileSync(join(here, 'fixtures', 'pet-project.mmd'), 'utf8'))
const ROLES = ['Kidnapper', 'Muscle', 'Picklock']

/** A probe whose successChance is whatever the diagram itself produces. */
const truthful = (cprs: Record<string, number>, droppedRole: string | null): Probe => ({
  droppedRole,
  droppedTo: droppedRole ? cprs[droppedRole] : undefined,
  cprs,
  endings: { successChance: simulatedSuccess(tree, ROLES, cprs) },
})

const high = { Kidnapper: 99, Muscle: 99, Picklock: 99 }

describe('roleFidelity', () => {
  it('passes a diagram that reproduces the service at every probe', () => {
    const probes = [
      truthful(high, null),
      truthful({ ...high, Picklock: 50 }, 'Picklock'),
      truthful({ ...high, Muscle: 1 }, 'Muscle'),
    ]
    const f = roleFidelity(tree, ROLES, probes)
    expect(f.ok).toBe(true)
    expect(f.misModelledRoles).toEqual([])
    expect(f.worstError).toBeLessThan(1e-9)
  })

  it('⚠️ names the role whose drop the flowchart does not reproduce', () => {
    // Window of Opportunity in miniature: the service says dropping this role
    // barely matters, the diagram says it is decisive. Naming the role is the
    // point — "this crime is wrong" is unactionable.
    const probes = [
      truthful(high, null),
      // 0.30 against the diagram's own 0.9802 — the shape of Window of
      // Opportunity's Looter 1, where the two models genuinely part company.
      { ...truthful({ ...high, Picklock: 1 }, 'Picklock'), endings: { successChance: 0.30 } },
    ]
    const f = roleFidelity(tree, ROLES, probes)
    expect(f.ok).toBe(false)
    expect(f.misModelledRoles).toEqual(['Picklock'])
    expect(f.worstProbe).toBe('Picklock@1')
  })

  it('⚠️ blames no role for a baseline disagreement', () => {
    // A crime that is wrong with every role at 99 is wrong as a whole. Pinning
    // that on whichever probe happened to be worst would name a role at random.
    const probes = [{ ...truthful(high, null), endings: { successChance: 0.2 } }]
    const f = roleFidelity(tree, ROLES, probes)
    expect(f.ok).toBe(false)
    expect(f.misModelledRoles).toEqual([])
    expect(f.worstProbe).toBe('baseline')
  })

  it('tolerates the API rounding its own numbers', () => {
    // The service reports four decimals, so an exact diagram still lands a few
    // 1e-4 away. The threshold is far above that and far below the real faults,
    // which start at 0.05.
    const probes = [
      { ...truthful(high, null), endings: { successChance: simulatedSuccess(tree, ROLES, high) + 0.0001 } },
    ]
    expect(roleFidelity(tree, ROLES, probes).ok).toBe(true)
    expect(MAX_ROLE_FIDELITY_ERROR).toBeGreaterThan(0.001)
    expect(MAX_ROLE_FIDELITY_ERROR).toBeLessThan(0.05)
  })

  it('ignores a probe that did not record its CPR vector', () => {
    // Nothing can be simulated for it, so it is evidence we do not have rather
    // than evidence of a fault.
    const probes: Probe[] = [{ droppedRole: 'Muscle', endings: { successChance: 0.1 } }]
    expect(roleFidelity(tree, ROLES, probes).ok).toBe(true)
  })
})
