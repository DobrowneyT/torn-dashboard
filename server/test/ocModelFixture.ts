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
import type { OcScenarioModel, OcModelEnding, OcModelRole } from '../src/oc/modelLoader.js'

export interface FixtureScenario {
  name: string
  parameterCount?: number
  isComplete?: boolean
  roles?: Array<[positionId: string, roleName: string, weight?: number]>
  endings?: Array<Partial<OcModelEnding> & { key: string }>
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
      reward: e.reward ?? null,
    }))
    model.set(s.name, {
      name: s.name,
      slug: s.name.toLowerCase().replace(/[^a-z0-9]/g, ''),
      parameterCount: s.parameterCount ?? roles.length,
      isComplete: s.isComplete ?? true,
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
