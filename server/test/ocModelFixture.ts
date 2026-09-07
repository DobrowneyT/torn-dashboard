/**
 * A small OC scenario model for tests (#606).
 *
 * ⚠️ The suite injects this rather than asserting against the dataset committed
 * in `src/oc/model/`. Torn adds crimes and revises flowcharts, so a routine
 * model refresh would otherwise break tests that have nothing to do with the
 * change — the coupling this seam exists to avoid.
 *
 * Tests that care about the REAL dataset (`oc-model.test.ts`) load it directly
 * and are the only place that should.
 */
import type { OcScenarioModel, OcModelEnding, OcModelNodeStat, OcModelRole } from '../src/oc/modelLoader.js'

export interface FixtureScenario {
  name: string
  parameterCount?: number
  isComplete?: boolean
  roles?: Array<[positionId: string, roleName: string, weight?: number]>
  endings?: Array<Partial<OcModelEnding> & { key: string }>
  /** #606 slice 3 — both ship with the model now. */
  observedPaths?: number | null
  /** #606: the other source's success chance, where the two disagree. */
  disputedSuccessChance?: number | null
  nodeStats?: OcModelNodeStat[]
}

export function ocModelFixture(scenarios: FixtureScenario[]): Map<string, OcScenarioModel> {
  const model = new Map<string, OcScenarioModel>()
  for (const s of scenarios) {
    const roles: OcModelRole[] = (s.roles ?? []).map(([positionId, roleName, weight]) => ({
      positionId, roleName, weight: weight ?? 25,
    }))
    const endings: OcModelEnding[] = (s.endings ?? []).map((e) => ({
      key: e.key,
      nodeId: e.nodeId ?? null,
      kind: e.kind ?? 'good',
      resolved: e.resolved ?? true,
      problem: e.problem ?? null,
      starved: e.starved ?? false,
      // #606: a fixture ending is its own outcome unless a test says otherwise.
      aliasOf: e.aliasOf ?? null,
      disputedKind: e.disputedKind ?? null,
      reward: e.reward ?? null,
    }))
    model.set(s.name, {
      name: s.name,
      slug: s.name.toLowerCase().replace(/[^a-z0-9]/g, ''),
      parameterCount: s.parameterCount ?? roles.length,
      isComplete: s.isComplete ?? true,
      // #606 slice 3: both now travel with the model. `nodeStats` defaults to
      // empty rather than to invented figures — a scenario nobody has mapped
      // has no observations, and a fixture that fabricated some would let a
      // test pass against numbers no tenant could ever see.
      observedPaths: s.observedPaths ?? null,
      disputedSuccessChance: s.disputedSuccessChance ?? null,
      nodeStats: s.nodeStats ?? [],
      diagramValid: true,
      diagramProblems: null,
      roles,
      endings,
      roleFidelity: null,
      sources: { structure: 'tornprobability', roles: 'tornprobability', rewards: null },
    })
  }
  return model
}
