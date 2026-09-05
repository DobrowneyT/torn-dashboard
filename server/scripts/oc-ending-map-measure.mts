/**
 * Measurement harness for the ending map (#473).
 *
 * #473 asks a question that can only be answered by measurement: ten scenarios
 * fit their flowchart loosely, `successChance` is exact on every one of them, so
 * the walk and the averaging rule are right and the error is in WHICH ROLES a
 * given checkpoint tests. The proposed fix is a nickname mapping — Lock Stock's
 * *"The bruisers feign defeat"* meaning Muscle #1 and Muscle #2 rather than
 * nobody — and the only honest way to accept or reject one is to re-simulate
 * all 31 scenarios and read the residuals.
 *
 * ⚠️ **The cache is the point.** Measuring 31 scenarios costs ~340 calls to one
 * person's small server. Doing that once per hypothesis would be both slow and
 * rude, and it would tempt whoever is iterating to test fewer ideas than they
 * should. So the probe sweep is fetched ONCE into a JSON cache and every
 * subsequent measurement is pure local computation over it.
 *
 *   npm run oc:measure -- --fetch     refresh the cache from tornprobability
 *   npm run oc:measure                measure against the cached sweep
 *   npm run oc:measure -- --texts     dump checkpoint text with no role match
 *
 * ⚠️ This is a DEV script, not a job. It is deliberately not wired into the
 * scheduler: it exists to answer a question during development, and the answer
 * gets committed as a code change plus a number in the issue, not re-derived
 * nightly against a service that might be down.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createProbabilityClient, joinRoles } from '../src/oc/probabilityClient.js'
import { parseScenarioTree } from '../src/oc/scenarioTree.js'
import { rolesInText, type Probe } from '../src/oc/endingMap.js'
import { assignEndings } from '../src/oc/endingAssignment.js'
import { simulatedSuccess } from '../src/oc/scenarioSimulator.js'
import { roleFidelity } from '../src/oc/roleFidelity.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const CACHE = resolve(HERE, '../.cache/oc-ending-map-sweep.json')

/** Same sweep the mirror job uses — see ocScenariosMirror.ts for why 50 then 1. */
const HIGH_CPR = 99
const LOW_CPRS = [50, 1]
const CALL_SPACING_MS = 250
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface CachedScenario {
  name: string
  parameterCount: number
  roleNames: string[]
  diagram: string
  probes: Probe[]
  /** The service's own successChance at the all-high baseline. */
  apiSuccess: number
}

async function fetchSweep(): Promise<CachedScenario[]> {
  const client = createProbabilityClient()
  const [scenarios, roleNames, roleWeights] = await Promise.all([
    client.scenarios(), client.roleNames(), client.roleWeights(),
  ])

  const out: CachedScenario[] = []
  for (const s of scenarios) {
    process.stderr.write(`  ${s.name} … `)
    try {
      const roles = joinRoles(s.name, roleNames, roleWeights)
      const names = roles.map((r) => r.roleName)
      const diagram = await client.diagram(s.name)
      await sleep(CALL_SPACING_MS)

      // ⚠️ Exactly the sweep runProbes() builds in ocScenariosMirror — same
      // order, same levels, same shape. A harness that probed differently would
      // measure a residual the production job never sees, and residuals are not
      // comparable across different sweeps (see oc-ending-assignment.test.ts).
      const probes: Probe[] = []
      const base = names.map(() => HIGH_CPR)
      const baseline = await client.calculateSuccess(s.name, base)
      probes.push({
        droppedRole: null,
        cprs: Object.fromEntries(names.map((n) => [n, HIGH_CPR])),
        endings: baseline,
      })
      await sleep(CALL_SPACING_MS)

      for (const low of LOW_CPRS) {
        for (let i = 0; i < names.length; i++) {
          const parameters = base.map((v, j) => (j === i ? low : v))
          probes.push({
            droppedRole: names[i],
            droppedTo: low,
            cprs: Object.fromEntries(names.map((n, j) => [n, parameters[j]])),
            endings: await client.calculateSuccess(s.name, parameters),
          })
          await sleep(CALL_SPACING_MS)
        }
      }

      out.push({
        name: s.name, parameterCount: s.parameters, roleNames: names,
        diagram, probes, apiSuccess: Number(baseline.successChance),
      })
      process.stderr.write(`${probes.length} probes\n`)
    } catch (e) {
      process.stderr.write(`FAILED: ${e instanceof Error ? e.message : String(e)}\n`)
    }
  }
  return out
}

interface Measured {
  name: string
  residual: number
  ok: boolean
  confident: boolean
  successError: number
  noRoleCheckpoints: number
  checkpoints: number
  multiRole: number
  endings: number
  terminals: number
  roles: number
  /** The single worst-disagreeing ending, which says whether the residual is
   *  concentrated in one outcome or spread across all of them. */
  worstEnding: string
  worstValue: number
  /** Baseline (all-high) probability of the worst-disagreeing ending. */
  worstMass: number
  /**
   * Residual re-weighted by how much probability each ending actually carries.
   *
   * ⚠️ `disagreement` is scale-free by design, so an ending at 1e-5 that we
   * simulate at 3e-5 contributes as much to the plain residual as the dominant
   * ending being wrong by half. That is right for CHOOSING an assignment and
   * misleading as a measure of how wrong the resulting MONEY is — money is
   * proportional to mass. Reported alongside, never instead: a mapping can be
   * wrong in a way that costs nothing today and everything at a different CPR.
   */
  massWeighted: number
  /** Largest |simulated - API| success over the sweep, and who is to blame. */
  fidelityError: number
  misModelled: string[]
}

function measure(cached: CachedScenario[]): Measured[] {
  const out: Measured[] = []
  for (const s of cached) {
    const tree = parseScenarioTree(s.diagram)
    const assignment = assignEndings(tree, s.roleNames, s.probes)

    // The oracle. If this is not ~0 the walk itself is wrong and no amount of
    // role attribution will fix the split.
    const high = Object.fromEntries(s.roleNames.map((n) => [n, HIGH_CPR]))
    const successError = Math.abs(simulatedSuccess(tree, s.roleNames, high) - s.apiSuccess)

    let noRole = 0
    let checkpoints = 0
    let multiRole = 0
    for (const node of tree.nodes.values()) {
      if (node.kind !== 'checkpoint') continue
      checkpoints++
      const named = rolesInText(node.text, s.roleNames)
      if (named.length === 0) noRole++
      if (named.length > 1) multiRole++
    }

    const fid = roleFidelity(tree, s.roleNames, s.probes)
    const perEnding = Object.entries(assignment.perEnding).sort((a, b) => b[1] - a[1])
    const goodTerminals = tree.terminals.filter((t) => t.ending === 'good').length

    // Baseline probabilities, straight from the service.
    const baselineProbe = s.probes.find((p) => p.droppedRole === null)
    const massOf = (key: string) => Number(baselineProbe?.endings?.[key] ?? 0)
    let massSum = 0
    let weighted = 0
    for (const [key, dis] of Object.entries(assignment.perEnding)) {
      const m = massOf(key)
      massSum += m
      weighted += m * dis
    }

    out.push({
      name: s.name,
      residual: assignment.residual,
      ok: assignment.ok,
      confident: assignment.confident,
      successError,
      noRoleCheckpoints: noRole,
      checkpoints,
      multiRole,
      endings: Object.keys(assignment.perEnding).length,
      terminals: goodTerminals,
      roles: s.roleNames.length,
      worstEnding: perEnding[0]?.[0] ?? '-',
      worstValue: perEnding[0]?.[1] ?? 0,
      worstMass: perEnding[0] ? massOf(perEnding[0][0]) : 0,
      massWeighted: massSum > 0 ? weighted / massSum : 0,
      fidelityError: fid.worstError,
      misModelled: fid.misModelledRoles,
    })
  }
  return out.sort((a, b) => b.residual - a.residual)
}

/**
 * Every checkpoint whose text names no role, with its scenario's role list.
 *
 * ⚠️ This is the evidence a nickname mapping has to be proposed FROM, not
 * justified by. #473's first guard: a mapping must be a plain reading of the
 * sentence. Reading the sentences first, before seeing which ones would help a
 * number, is what keeps that honest.
 */
function dumpTexts(cached: CachedScenario[]) {
  for (const s of cached) {
    const tree = parseScenarioTree(s.diagram)
    const orphans: string[] = []
    for (const node of tree.nodes.values()) {
      if (node.kind !== 'checkpoint') continue
      if (rolesInText(node.text, s.roleNames).length === 0) orphans.push(`    ${node.id}  ${node.text}`)
    }
    if (orphans.length === 0) continue
    console.log(`\n${s.name}  [roles: ${s.roleNames.join(', ')}]`)
    for (const o of orphans) console.log(o)
  }
}

function report(rows: Measured[], baseline: Record<string, number> | null) {
  const LOOSE = 0.10
  console.log('residual  massWtd   fidelity  mis-modelled roles              scenario')
  console.log('────────  ────────  ────────  ──────────────────────────────  ────────────────────')
  for (const r of rows) {
    const before = baseline?.[r.name]
    const delta = before === undefined ? '' : (r.residual - before)
    const arrow = typeof delta === 'number'
      ? (Math.abs(delta) < 1e-9 ? '    ·   ' : `${delta > 0 ? '+' : ''}${delta.toFixed(4)}`)
      : ''
    const flag = r.residual > LOOSE ? ' ⚠️' : ''
    console.log(
      `${r.residual.toFixed(4).padStart(8)}  ${r.massWeighted.toFixed(4).padStart(8)}  ` +
      `${r.fidelityError.toFixed(4).padStart(8)}  ` +
      `${(r.misModelled.join(', ') || '—').slice(0, 30).padEnd(30)}  ${r.name}${flag}`
    )
  }
  const loose = rows.filter((r) => r.residual > LOOSE)
  const mean = rows.reduce((a, r) => a + r.residual, 0) / rows.length
  console.log('────────')
  console.log(`${rows.length} scenarios, ${loose.length} loose (> ${LOOSE}), mean residual ${mean.toFixed(4)}`)

  if (baseline) {
    // ⚠️ #473's second guard: report movement PER SCENARIO, never only the mean.
    // A mapping that fixes eight crimes and breaks two is a different thing from
    // one that fixes ten, and averaging hides exactly that difference.
    const improved = rows.filter((r) => baseline[r.name] !== undefined && r.residual < baseline[r.name] - 1e-9)
    const worsened = rows.filter((r) => baseline[r.name] !== undefined && r.residual > baseline[r.name] + 1e-9)
    console.log(`improved ${improved.length}, worsened ${worsened.length}, unchanged ${rows.length - improved.length - worsened.length}`)
    if (worsened.length > 0) {
      console.log(`⚠️ worsened: ${worsened.map((r) => r.name).join(', ')}`)
    }
  }
}

const args = process.argv.slice(2)

if (args.includes('--fetch')) {
  console.error('Fetching the probe sweep from tornprobability (this takes a few minutes)…')
  const sweep = await fetchSweep()
  mkdirSync(dirname(CACHE), { recursive: true })
  writeFileSync(CACHE, JSON.stringify(sweep))
  console.error(`Cached ${sweep.length} scenarios to ${CACHE}`)
}

if (!existsSync(CACHE)) {
  console.error(`No cache at ${CACHE}. Run with --fetch first.`)
  process.exit(1)
}

const cached: CachedScenario[] = JSON.parse(readFileSync(CACHE, 'utf8'))

if (args.includes('--texts')) {
  dumpTexts(cached)
} else {
  const baselineArg = args.find((a) => a.startsWith('--baseline='))
  const baseline = baselineArg
    ? JSON.parse(readFileSync(baselineArg.slice('--baseline='.length), 'utf8'))
    : null
  const rows = measure(cached)
  report(rows, baseline)

  const saveArg = args.find((a) => a.startsWith('--save='))
  if (saveArg) {
    const path = saveArg.slice('--save='.length)
    writeFileSync(path, JSON.stringify(Object.fromEntries(rows.map((r) => [r.name, r.residual])), null, 2))
    console.log(`\nSaved residuals to ${path}`)
  }
}
