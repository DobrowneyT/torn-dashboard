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

/**
 * CPR used for the baseline probe, and for the roles NOT being dropped.
 *
 * High enough that the all-pass ending dominates by orders of magnitude, which
 * is what makes failure depth readable straight off the response. 100 would be
 * cleaner still but risks the model treating it as a special case; 99 is the
 * value the mapping was derived and verified against.
 */
const HIGH_CPR = 99

/** CPR for the single dropped role in each probe. */
const LOW_CPR = 1

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
      const good = deriveEndingMap(tree, roleList, probes, 'good')
      const bad = deriveEndingMap(tree, roleList, probes, 'bad')

      await writeEndings(db, scenario.name, good, bad)
      if (good.ok) mapped++
      else problems.push(`${scenario.name}: ${good.problems.join('; ')}`)
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

  probes.push({ droppedRole: null, endings: await client.calculateSuccess(scenario, baseline) })
  await sleep(spacing)

  for (let i = 0; i < roles.length; i++) {
    const parameters = baseline.map((v, j) => (j === i ? LOW_CPR : v))
    probes.push({
      droppedRole: roles[i].roleName,
      endings: await client.calculateSuccess(scenario, parameters),
    })
    await sleep(spacing)
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
  stats: Record<string, { n: number; money: any; respect: any }> | null
) {
  if (!stats || Object.keys(stats).length === 0) return
  await db.query('DELETE FROM oc_scenario_node_stats WHERE scenario_name = $1', [scenario])
  for (const [nodeId, s] of Object.entries(stats)) {
    await db.query(
      `INSERT INTO oc_scenario_node_stats
         (scenario_name, node_id, n, money_min, money_max, money_avg,
          respect_min, respect_max, respect_avg, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())`,
      [scenario, nodeId, s.n,
       Math.round(s.money.min), Math.round(s.money.max), Math.round(s.money.avg),
       s.respect.min, s.respect.max, s.respect.avg]
    )
  }
}

async function clearEndings(db: JobDeps['db'], scenario: string) {
  await db.query('DELETE FROM oc_scenario_endings WHERE scenario_name = $1', [scenario])
}

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
  good: ReturnType<typeof deriveEndingMap>,
  bad: ReturnType<typeof deriveEndingMap>
) {
  await clearEndings(db, scenario)
  for (const [kind, result] of [['good', good], ['bad', bad]] as const) {
    const keys = new Set([...Object.keys(result.map)])
    // Problems name their ending key first ("goodEnding3: ties between ..."),
    // so unresolved endings are recoverable from them.
    for (const problem of result.problems) {
      const key = /^(\w+Ending\d+):/.exec(problem)?.[1]
      if (key) keys.add(key)
    }
    for (const key of keys) {
      const nodeId = result.map[key] ?? null
      const problem = result.problems.find((p) => p.startsWith(`${key}:`)) ?? null
      await db.query(
        `INSERT INTO oc_scenario_endings (scenario_name, ending_key, node_id, kind, resolved, problem)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (scenario_name, ending_key) DO UPDATE SET
           node_id = EXCLUDED.node_id, kind = EXCLUDED.kind,
           resolved = EXCLUDED.resolved, problem = EXCLUDED.problem`,
        [scenario, key, nodeId, kind, nodeId !== null, problem]
      )
    }
  }
}
