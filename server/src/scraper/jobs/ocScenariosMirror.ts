// #390 — mirror the OC probability model into our own tables.
//
// tornprobability.com:3000 is one person's server on a non-standard port with
// no SLA, and a dataset still being filled in. The simulator computes against
// THIS copy: an outage degrades to stale numbers instead of a dead page, and
// the browser never talks to it, so there is no CORS problem and no third-party
// request originating from a member's machine.
//
// The data is effectively static — a model someone is slowly extending — so
// this runs once a day, not on demand.
import type { JobDeps } from './itemsSync.js'
import type { RunResult } from '../runLog.js'
import {
  createProbabilityClient, joinRoles, type ScenarioRole,
} from '../../oc/probabilityClient.js'
import { parseScenarioTree, validateScenarioTree } from '../../oc/scenarioTree.js'
import { deriveEndingMap, type Probe } from '../../oc/endingMap.js'
import { assignEndings } from '../../oc/endingAssignment.js'
import { roleFidelity } from '../../oc/roleFidelity.js'

/**
 * CPR used for the baseline probe, and for the roles NOT being dropped.
 *
 * High enough that the all-pass ending dominates by orders of magnitude, which
 * is what makes failure depth readable straight off the response. 100 would be
 * cleaner still but risks the model treating it as a special case; 99 is the
 * value the mapping was derived and verified against.
 */
const HIGH_CPR = 99

/**
 * CPRs the probed role is dropped to, strongest signal first.
 *
 * ⚠️ **50 before 1, and 1 alone is not enough.** Dropping a role to CPR 1 was
 * the original design and it SATURATES: a role gating several checkpoints then
 * fails all of them, so the endings that need exactly ONE of its failures
 * collapse instead of appearing. Pet Project's `goodEnding2` is flat on
 * Picklock at CPR 1 and rises 25x at CPR 50 — the evidence was always there,
 * the probe was blind to it.
 *
 * Measured across all 31 live scenarios: switching to 50 took good-ending
 * mapping from 18/31 to 21/31 with no regressions, and eliminated the "no role
 * evidence" failure entirely. 1 is kept as a second level because it still
 * reveals the deep multi-failure endings that 50 leaves rare.
 */
const LOW_CPRS = [50, 1]

/** Be a good neighbour: a small pause between calls to someone else's server. */
const CALL_SPACING_MS = 250

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface MirrorOptions {
  baseUrl?: string
  fetchImpl?: typeof fetch
  /** Skip the inter-call pause in tests. */
  spacingMs?: number
}

export async function ocScenariosMirrorJob(
  { db }: JobDeps,
  opts: MirrorOptions = {}
): Promise<RunResult> {
  const client = createProbabilityClient({ baseUrl: opts.baseUrl, fetchImpl: opts.fetchImpl })
  const spacing = opts.spacingMs ?? CALL_SPACING_MS

  const [scenarios, roleNames, roleWeights] = await Promise.all([
    client.scenarios(),
    client.roleNames(),
    client.roleWeights(),
  ])

  // Completeness lives only on the HTML page and is the thing most likely to
  // break on a redesign. A failure here must not lose the whole mirror run —
  // it just means we cannot say how complete each scenario is, which is stored
  // as NULL rather than assumed.
  let completeness: Awaited<ReturnType<typeof client.completeness>> = []
  let completenessError: string | null = null
  try {
    completeness = await client.completeness()
  } catch (e) {
    completenessError = e instanceof Error ? e.message : String(e)
  }
  const completeByName = new Map(completeness.map((c) => [c.name.toLowerCase(), c]))

  let mirrored = 0
  let mapped = 0
  const problems: string[] = []

  for (const scenario of scenarios) {
    try {
      const roles = joinRoles(scenario.name, roleNames, roleWeights)
      if (roles.length !== scenario.parameters) {
        // The role list and the parameter count disagree, so we cannot build a
        // CPR vector we can defend. Store what we know and skip the mapping.
        problems.push(
          `${scenario.name}: ${roles.length} roles listed but the crime takes ${scenario.parameters}`
        )
      }

      // ONE connection carries both the flowchart and the per-node money and
      // respect (#440). Reading the stats frame costs no extra request — we
      // were already receiving it and throwing it away.
      const feed = await client.scenarioFeed(scenario.name)
      await sleep(spacing)
      const diagram = feed.diagram
      if (!diagram) throw new Error('no diagram frame')

      const tree = parseScenarioTree(diagram)
      const validation = validateScenarioTree(tree)
      const meta = completeByName.get(scenario.name.toLowerCase())

      await db.query(
        `INSERT INTO oc_scenarios
           (name, parameter_count, is_complete, observed_paths, diagram,
            diagram_valid, diagram_problems, fetched_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, now(), now())
         ON CONFLICT (name) DO UPDATE SET
           parameter_count  = EXCLUDED.parameter_count,
           is_complete      = EXCLUDED.is_complete,
           observed_paths   = EXCLUDED.observed_paths,
           diagram          = EXCLUDED.diagram,
           diagram_valid    = EXCLUDED.diagram_valid,
           diagram_problems = EXCLUDED.diagram_problems,
           fetched_at       = now(),
           updated_at       = now()`,
        [
          scenario.name,
          scenario.parameters,
          // NULL, not false, when the page could not be read. "We do not know
          // whether this model is finished" is not "it is unfinished".
          meta ? meta.isComplete : null,
          meta?.paths ?? null,
          diagram,
          validation.mappable,
          JSON.stringify(validation.problems),
        ]
      )
      await replaceRoles(db, scenario.name, roles)
      await replaceNodeStats(db, scenario.name, feed.stats)
      mirrored++

      if (!validation.mappable) {
        problems.push(`${scenario.name}: diagram not mappable — ${validation.problems.join('; ')}`)
        await clearEndings(db, scenario.name)
        continue
      }
      if (roles.length !== scenario.parameters) {
        await clearEndings(db, scenario.name)
        continue
      }

      const probes = await runProbes(client, scenario.name, roles, spacing)
      const roleList = roles.map((r) => r.roleName)

      // ⚠️ Simulation, not inference (#471). The old heuristic derivation
      // mapped 21 of 31 scenarios after three measured attempts to improve it;
      // evaluating the diagram directly maps 29. `deriveEndingMap` is kept only
      // for bad endings, which pay nothing and are not worth a second sweep.
      const good = assignEndings(tree, roleList, probes, 'good')
      // ⚠️ Asked at every probe, not just the all-high baseline. The baseline
      // is exact for all 31 scenarios, so checking only there says nothing.
      const fidelity = roleFidelity(tree, roleList, probes)
      const bad = deriveEndingMap(tree, roleList, probes, 'bad')

      await writeEndings(db, scenario.name, good, bad)
      await db.query(
        `UPDATE oc_scenarios
            SET ending_map_residual = $2, ending_map_confident = $3,
                ending_map_money_residual = $4, ending_map_money_confident = $5,
                role_fidelity_error = $6, role_fidelity_roles = $7
          WHERE name = $1`,
        [scenario.name, good.residual, good.confident,
         good.massWeightedResidual, good.moneyConfident,
         fidelity.worstError, JSON.stringify(fidelity.misModelledRoles)]
      )
      if (good.ok) mapped++
      if (good.problems.length > 0) problems.push(`${scenario.name}: ${good.problems.join('; ')}`)
      // ⚠️ Reported even when the mapping is complete. Ten scenarios reproduce
      // successChance exactly while the split between endings does not fit, so
      // "mapped" and "trustworthy" have to be separately visible.
      else if (!good.confident) {
        problems.push(`${scenario.name}: mapped but a loose fit (residual ${good.residual.toFixed(3)})`)
      }
      // ⚠️ Reported SEPARATELY from the loose-fit warning above, because the
      // two disagree in both directions (#473). Mob Mentality is a loose fit
      // whose money is fine; a scenario can also fit tightly overall and be
      // wrong about the ending that carries almost all the probability, which
      // is the one that actually costs money.
      // ⚠️ Distinct from both residuals: this says the DIAGRAM disagrees with
      // the service about a role, which no assignment can repair. Named roles,
      // because "this crime is wrong" is unactionable and "Looter 1 and Looter
      // 2 are wrong" tells you which sliders to distrust.
      if (!fidelity.ok) {
        problems.push(
          `${scenario.name}: the flowchart does not reproduce the service's own ` +
          `success for ${fidelity.misModelledRoles.join(', ') || 'this crime'} ` +
          `(worst ${fidelity.worstError.toFixed(3)} at ${fidelity.worstProbe})`
        )
      }
      if (good.ok && !good.moneyConfident) {
        problems.push(
          `${scenario.name}: per-ending money is not trustworthy ` +
          `(mass-weighted residual ${good.massWeightedResidual.toFixed(3)})`
        )
      }
    } catch (e) {
      problems.push(`${scenario.name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return {
    rows: mirrored,
    details: {
      scenarios: scenarios.length,
      mirrored,
      // Deliberately reported separately from `mirrored`: a scenario whose
      // diagram we hold but whose endings we could not resolve is half-useful,
      // and collapsing the two would hide that.
      mapped,
      completeness_read: completeness.length,
      completeness_error: completenessError,
      problems: problems.slice(0, 20),
      problem_count: problems.length,
    },
  }
}

/**
 * One baseline probe plus one per role, each dropping a single role to CPR 1.
 *
 * This is the sweep `deriveEndingMap` reads role evidence from. It is the
 * expensive part of the job — 1 + N calls per scenario, about 150 in total —
 * which is precisely why the whole thing runs once a day rather than on demand.
 */
async function runProbes(
  client: ReturnType<typeof createProbabilityClient>,
  scenario: string,
  roles: ScenarioRole[],
  spacing: number
): Promise<Probe[]> {
  const probes: Probe[] = []
  const baseline = roles.map(() => HIGH_CPR)

  probes.push({
    droppedRole: null,
    cprs: Object.fromEntries(roles.map((r) => [r.roleName, HIGH_CPR])),
    endings: await client.calculateSuccess(scenario, baseline),
  })
  await sleep(spacing)

  for (const low of LOW_CPRS) {
    for (let i = 0; i < roles.length; i++) {
      const parameters = baseline.map((v, j) => (j === i ? low : v))
      probes.push({
        droppedRole: roles[i].roleName,
        droppedTo: low,
        cprs: Object.fromEntries(roles.map((r, j) => [r.roleName, parameters[j]])),
        endings: await client.calculateSuccess(scenario, parameters),
      })
      await sleep(spacing)
    }
  }
  return probes
}

async function replaceRoles(db: JobDeps['db'], scenario: string, roles: ScenarioRole[]) {
  await db.query('DELETE FROM oc_scenario_roles WHERE scenario_name = $1', [scenario])
  for (const role of roles) {
    await db.query(
      `INSERT INTO oc_scenario_roles (scenario_name, position_id, role_name, weight)
       VALUES ($1, $2, $3, $4)`,
      [scenario, role.positionId, role.roleName, role.weight]
    )
  }
}

/**
 * Store observed money/respect per node (#440).
 *
 * ⚠️ A missing stats frame leaves the EXISTING rows alone rather than deleting
 * them. The feed occasionally sends the diagram without stats, and wiping a
 * priced crime because one nightly run arrived early would turn a real E(x)
 * into a lower bound of zero overnight — silently, and only on that crime.
 */
async function replaceNodeStats(
  db: JobDeps['db'],
  scenario: string,
  stats: Record<string, { n: number; money: any; respect: any; items?: any[] }> | null
) {
  if (!stats || Object.keys(stats).length === 0) return
  await db.query('DELETE FROM oc_scenario_node_stats WHERE scenario_name = $1', [scenario])
  for (const [nodeId, s] of Object.entries(stats)) {
    await db.query(
      `INSERT INTO oc_scenario_node_stats
         (scenario_name, node_id, n, money_min, money_max, money_avg,
          respect_min, respect_max, respect_avg, items, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb, now())`,
      [scenario, nodeId, s.n,
       Math.round(s.money.min), Math.round(s.money.max), Math.round(s.money.avg),
       s.respect.min, s.respect.max, s.respect.avg,
       JSON.stringify(s.items ?? [])]
    )
  }
}

async function clearEndings(db: JobDeps['db'], scenario: string) {
  await db.query('DELETE FROM oc_scenario_endings WHERE scenario_name = $1', [scenario])
}

/** Explains a starved ending wherever one is written — kept in one place. */
const STARVED_PROBLEM =
  'no diagram counterpart — the API reports more good endings than the ' +
  'flowchart draws terminals for; priced at $0 pending an upstream diagram fix'

/**
 * Store the mapping, including the endings it could NOT resolve.
 *
 * An unresolved ending keeps a row with `resolved = false` and the reason. The
 * alternative — omitting it — makes "we could not work this one out" look
 * identical to "this ending does not exist", and the simulator would quietly
 * price a crime on a subset of its outcomes.
 */
async function writeEndings(
  db: JobDeps['db'],
  scenario: string,
  // The simulation-based assignment (#471) additionally carries `unmatched`
  // — the heuristic derivation (bad endings only) does not, and its
  // unresolved keys are still recovered from `problems` below.
  good: { map: Record<string, string>; problems: string[]; unmatched?: { endings: string[] } },
  bad: { map: Record<string, string>; problems: string[] }
) {
  await clearEndings(db, scenario)

  const upsert = (key: string, nodeId: string | null, kind: 'good' | 'bad', resolved: boolean, starved: boolean, problem: string | null) =>
    db.query(
      `INSERT INTO oc_scenario_endings (scenario_name, ending_key, node_id, kind, resolved, starved, problem)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (scenario_name, ending_key) DO UPDATE SET
         node_id = EXCLUDED.node_id, kind = EXCLUDED.kind, resolved = EXCLUDED.resolved,
         starved = EXCLUDED.starved, problem = EXCLUDED.problem`,
      [scenario, key, nodeId, kind, resolved, starved, problem]
    )

  for (const [kind, result] of [['good', good], ['bad', bad]] as const) {
    const keys = new Set([...Object.keys(result.map)])
    // Problems name their ending key first ("goodEnding3: ties between ..."),
    // so unresolved endings are recoverable from them. Still needed for the
    // bad-ending path (the legacy heuristic derivation); good endings report
    // their unresolved keys directly via `unmatched.endings` instead — see
    // below — so this only ever adds keys for `bad`.
    for (const problem of result.problems) {
      const key = /^(\w+Ending\d+):/.exec(problem)?.[1]
      if (key) keys.add(key)
    }
    for (const key of keys) {
      const nodeId = result.map[key] ?? null
      const problem = result.problems.find((p) => p.startsWith(`${key}:`)) ?? null
      await upsert(key, nodeId, kind, nodeId !== null, false, problem)
    }
  }

  // #473, MonChoon 2026-08-28: "let's softly mark those endings as 0s for
  // the moment" — a starved good ending (the API reports it, the diagram has
  // no terminal for it) is a CONFIRMED state, not an open question. The
  // mirror's reward tracking is keyed strictly by diagram node id, so no
  // amount of better mapping ever prices one from this source. Marked
  // `starved` (not `resolved`, which stays accurate: no node was found) so
  // pricing can treat it as $0 instead of a permanent lower bound, and
  // reversible the moment an upstream fix gives it a real terminal.
  for (const key of good.unmatched?.endings ?? []) {
    await upsert(key, null, 'good', false, true, STARVED_PROBLEM)
  }
}
