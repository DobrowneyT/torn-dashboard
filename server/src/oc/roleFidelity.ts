/**
 * Does the flowchart model each ROLE the way the service's own model does?
 * (#473)
 *
 * ⚠️ The whole simulator has been validated against `successChance` at ONE
 * point — every role at CPR 99 — and it is exact there for all 31 scenarios.
 * That is why this went unnoticed. Ask the same oracle at a *dropped* CPR and
 * twelve of the thirty-one disagree, several catastrophically:
 *
 *     Window of Opportunity, Looter 1 at CPR 1
 *       API 0.9804          the Looters barely matter
 *       SIM 0.3897          the flowchart makes them decisive
 *
 * Engineer and Muscle 2 in that same crime match the API to four decimals
 * across the whole curve (99 / 75 / 50 / 25 / 1), so the walk, the CPR/100 pass
 * rule and the multi-role average are all sound. What differs is confined to
 * particular roles: the diagram draws a Looter failure cascade
 * (`_A5_C1_` → `_A5_C2_` → `_B5_C1..C3_` → `_B5F_`) that the service does not
 * score, and no amount of role attribution fixes a branch that should not be
 * there.
 *
 * ⚠️ **This is an upstream disagreement between the two things we mirror, not a
 * bug in this code**, and the ruled-out list matters as much as the finding:
 *
 *   - Not role attribution — the checkpoints name the Looters explicitly.
 *   - Not parameter ordering — verified P1..P5 against `GetRoleNames`.
 *   - Not terminal classification — `_B5F_` really is a failure, confirmed
 *     against the diagram's own `fill:#C62828`.
 *   - Not an incomplete diagram — 768 observed paths and `is_complete`, the
 *     best-observed scenario in the whole set.
 *
 * So this module measures the disagreement rather than papering over it. A
 * crime whose roles all check out can have its per-ending numbers trusted; one
 * that fails here is telling you which roles to distrust, by name.
 */
import { type ScenarioTree } from './scenarioTree.js'
import { simulatedSuccess } from './scenarioSimulator.js'
import { type Probe } from './endingMap.js'

/**
 * Disagreement above which a role is reported as mis-modelled.
 *
 * ⚠️ A discovered split, like the other two thresholds in this feature. Sorted
 * across all 31 scenarios the maximum per-scenario error falls in two groups
 * with an order of magnitude between them:
 *
 *     0.699 … 0.245  0.053        12 scenarios
 *     ── gap ──
 *     0.0098 … 0.0000              19 scenarios
 *
 * 0.02 sits inside it. The tight group is not merely small, it is mostly
 * *exactly* zero, which is the signature of a diagram that is simply right.
 */
export const MAX_ROLE_FIDELITY_ERROR = 0.02

export interface RoleFidelity {
  /** Largest |simulated − API| success over every probe. */
  worstError: number
  /** The probe that produced it, for a human to reproduce. */
  worstProbe: string
  /** Roles whose own drop the flowchart does not reproduce. */
  misModelledRoles: string[]
  ok: boolean
}

export function roleFidelity(
  tree: ScenarioTree,
  roleNames: string[],
  probes: Probe[]
): RoleFidelity {
  let worstError = 0
  let worstProbe = 'baseline'
  const misModelled = new Set<string>()

  for (const probe of probes) {
    if (!probe.cprs) continue
    const api = Number(probe.endings?.successChance)
    if (!Number.isFinite(api)) continue

    const error = Math.abs(simulatedSuccess(tree, roleNames, probe.cprs) - api)
    const label = probe.droppedRole ? `${probe.droppedRole}@${probe.droppedTo}` : 'baseline'
    if (error > worstError) {
      worstError = error
      worstProbe = label
    }
    // ⚠️ Only a probe that DROPPED a role can blame one. A baseline
    // disagreement is a fault in the diagram as a whole and belongs to
    // `worstError`, not to any particular role's name.
    if (probe.droppedRole && error > MAX_ROLE_FIDELITY_ERROR) {
      misModelled.add(probe.droppedRole)
    }
  }

  return {
    worstError,
    worstProbe,
    misModelledRoles: [...misModelled].sort(),
    ok: misModelled.size === 0 && worstError <= MAX_ROLE_FIDELITY_ERROR,
  }
}
