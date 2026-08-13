/**
 * Mapping `goodEndingN` / `badEndingN` onto diagram node ids (#390).
 *
 * This is the join the whole OC Simulator rests on. tornprobability's money
 * statistics are keyed by node id (`_A8S_`); its probability API answers in
 * `goodEnding1..N`; nothing in either response states the correspondence.
 *
 * Getting it wrong is the expensive kind of wrong: each ending is paired with a
 * DIFFERENT ending's money, every number stays plausible, and the resulting
 * E(x) is used to decide which crimes to run.
 *
 * ⚠️ Position matching is not merely unproven, it is WRONG. For Break the Bank
 * the derived mapping swaps positions 3 and 4 against declaration order:
 *
 *   declaration: _A8S_, _A8S2_, _A10S_, _A9S_, _B3S_
 *   derived:     _A8S_, _A8S2_, _A9S_,  _A10S_, _B3S_
 *
 * Two endings would have carried each other's payouts.
 *
 * The derivation uses two independent signals and requires them to agree:
 *
 *   DEPTH — the fewest checkpoint failures a path to this ending needs. At
 *           near-perfect CPRs an ending's probability falls by roughly an order
 *           of magnitude per required failure, so depth is readable straight
 *           off the baseline probe.
 *
 *   ROLES — which roles' failures lead to this ending, from the diagram, versus
 *           which roles' CPR drops actually raise it, from the probe sweep.
 */
import {
  type ScenarioTree, pathsToTerminal, checkpointsOnPath,
} from './scenarioTree.js'

/** One API response, with the CPR vector that produced it. */
export interface Probe {
  /** Which role was dropped, or null for the all-high baseline. */
  droppedRole: string | null
  /** `goodEnding1` / `badEnding1` → probability. */
  endings: Record<string, number>
}

export interface EndingMapping {
  /** ending key → node id. Only present when the derivation fully succeeded. */
  map: Record<string, string>
  ok: boolean
  /** Why it failed, in terms a reader can act on. */
  problems: string[]
}

/** "Muscle #2" in prose vs "Muscle 2" in the role list. */
const normalise = (s: string) => s.replace(/#/g, '').replace(/\s+/g, ' ').toLowerCase()

/** Which of `roleNames` a checkpoint's prose mentions. */
export function rolesInText(text: string, roleNames: string[]): string[] {
  const hay = normalise(text)
  return roleNames.filter((r) => hay.includes(normalise(r)))
}

/**
 * A terminal's depth and the roles whose FAILURE leads to it.
 *
 * Only minimum-depth paths contribute. A deeper path to the same ending exists
 * but is orders of magnitude less likely at high CPR, so including its roles
 * would blur the signature with contributions the probe sweep cannot see.
 */
export function terminalSignature(
  tree: ScenarioTree,
  terminalId: string,
  roleNames: string[]
): { depth: number; failRoles: Set<string> } {
  const paths = pathsToTerminal(tree, terminalId)
  if (paths.length === 0) return { depth: Infinity, failRoles: new Set() }

  const depths = paths.map((p) => checkpointsOnPath(tree, p).failed)
  const depth = Math.min(...depths)

  const failRoles = new Set<string>()
  paths.forEach((path, i) => {
    if (depths[i] !== depth) return
    for (let j = 0; j < path.length; j++) {
      const node = tree.nodes.get(path[j])
      if (node?.kind !== 'checkpoint') continue
      const label = tree.edgeLabels.get(`${node.id}>${path[j + 1]}`)?.toLowerCase()
      if (label === 'fail') for (const r of rolesInText(node.text, roleNames)) failRoles.add(r)
    }
  })
  return { depth, failRoles }
}

/**
 * Which roles' CPR drops RAISE an ending above its baseline.
 *
 * The observable counterpart of `failRoles`. A drop that raises an ending means
 * that role's failure is on the way there; a drop that lowers it means the role
 * gates a checkpoint the ending needed to pass.
 *
 * The 1.5x margin is not fussiness. Dropping any role perturbs every ending a
 * little, and a bare `>` would read that noise as signal — producing a
 * signature that matches several terminals and an ambiguity that has to be
 * broken by guessing.
 */
export function observedSignature(endingKey: string, probes: Probe[], margin = 1.5): Set<string> {
  const baseline = probes.find((p) => p.droppedRole === null)?.endings[endingKey]
  const out = new Set<string>()
  if (baseline === undefined) return out
  for (const probe of probes) {
    if (probe.droppedRole === null) continue
    const v = probe.endings[endingKey]
    if (v === undefined) continue
    if (v > Math.max(baseline * margin, baseline + 1e-9)) out.add(probe.droppedRole)
  }
  return out
}

/** Depth implied by a probability at the all-high baseline. */
function impliedDepth(p: number): number {
  // ~1% failure per checkpoint at CPR 99, so each required failure costs about
  // two orders of magnitude. Bucketed rather than exact — the derivation only
  // needs depth to GROUP endings, with roles doing the discrimination inside a
  // group, so a coarse bucket that cannot be fooled beats a precise one that can.
  if (p >= 0.1) return 0
  if (p >= 1e-3) return 1
  if (p >= 1e-5) return 2
  return 3
}

/**
 * Derive the ending→node mapping, or fail loudly.
 *
 * Returns `ok: false` with reasons rather than a partial map. A half-derived
 * mapping is the worst possible output here: the endings it did resolve look
 * exactly as trustworthy as the ones it guessed.
 */
export function deriveEndingMap(
  tree: ScenarioTree,
  roleNames: string[],
  probes: Probe[],
  kind: 'good' | 'bad' = 'good'
): EndingMapping {
  const problems: string[] = []
  const baseline = probes.find((p) => p.droppedRole === null)
  if (!baseline) {
    return { map: {}, ok: false, problems: ['no baseline probe (all roles high) supplied'] }
  }

  const prefix = kind === 'good' ? 'goodEnding' : 'badEnding'
  const endingKeys = Object.keys(baseline.endings).filter((k) => k.startsWith(prefix))
  const terminals = tree.terminals.filter((t) => t.ending === kind)

  if (endingKeys.length !== terminals.length) {
    problems.push(
      `the API reports ${endingKeys.length} ${kind} endings but the diagram has ` +
      `${terminals.length} — the two disagree about the crime's shape, so no mapping is trustworthy`
    )
    return { map: {}, ok: false, problems }
  }

  const termSigs = new Map(
    terminals.map((t) => [t.id, terminalSignature(tree, t.id, roleNames)])
  )

  // Score every (ending, terminal) pair; depth must agree, roles then rank.
  const map: Record<string, string> = {}
  const takenNodes = new Set<string>()

  // Resolve the least ambiguous endings first, so a forced choice never steals
  // a node that another ending had no alternative for.
  const ranked = endingKeys
    .map((key) => {
      const depth = impliedDepth(baseline.endings[key])
      const observed = observedSignature(key, probes)
      const candidates = terminals.filter((t) => termSigs.get(t.id)!.depth === depth)
      return { key, depth, observed, candidates }
    })
    .sort((a, b) => a.candidates.length - b.candidates.length)

  for (const { key, depth, observed, candidates } of ranked) {
    const free = candidates.filter((t) => !takenNodes.has(t.id))
    if (free.length === 0) {
      problems.push(`${key}: no unclaimed ending in the diagram at failure depth ${depth}`)
      continue
    }
    if (free.length === 1) {
      map[key] = free[0].id
      takenNodes.add(free[0].id)
      continue
    }

    // Several endings at this depth — the roles decide. Score by overlap with
    // the roles the diagram says lead here.
    const scored = free.map((t) => {
      const sig = termSigs.get(t.id)!.failRoles
      const overlap = [...observed].filter((r) => sig.has(r)).length
      return { t, overlap }
    }).sort((a, b) => b.overlap - a.overlap)

    if (scored[0].overlap === 0) {
      problems.push(`${key}: no role evidence links it to any ending at depth ${depth}`)
      continue
    }
    if (scored.length > 1 && scored[0].overlap === scored[1].overlap) {
      // ⚠️ Muscle 3 and Thief 2 gate the same checkpoint in Break the Bank and
      // are indistinguishable under single-role drops. An ending separated only
      // by such a pair lands here, and must be reported rather than guessed.
      problems.push(
        `${key}: ties between ${scored[0].t.id} and ${scored[1].t.id} on role evidence — ` +
        'needs a paired-role probe to separate them'
      )
      continue
    }

    map[key] = scored[0].t.id
    takenNodes.add(scored[0].t.id)
  }

  // The assertion that makes this safe to build on: a total bijection, or nothing.
  const mapped = Object.keys(map)
  if (mapped.length !== endingKeys.length) {
    problems.push(`only ${mapped.length} of ${endingKeys.length} ${kind} endings resolved`)
  }
  if (new Set(Object.values(map)).size !== mapped.length) {
    problems.push('two endings resolved to the same diagram node')
  }

  return { map, ok: problems.length === 0, problems }
}
