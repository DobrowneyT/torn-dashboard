/**
 * Forward-simulating a crime's flowchart (#471).
 *
 * The ending map used to be *inferred* — depth heuristics, which roles raise
 * which ending, tie-breaking rules. Three measured attempts at improving that
 * inference gained nothing and one made it worse. It was the wrong tool: the
 * diagram is not a hint about the probability model, it **is** the probability
 * model, and it can simply be evaluated.
 *
 * Walking it forward reproduces the service's own numbers:
 *
 *     Pet Project, Picklock dropped to CPR 50
 *       SIMULATED               API
 *       _B3S_  = 0.49005   goodEnding4 = 0.49005
 *       _A7S1_ = 0.24742   goodEnding1 = 0.24742
 *       _A7S2_ = 0.24495   goodEnding2 = 0.24495
 *
 * Which also solves the problem inference could not. Two endings tie under role
 * evidence because they *look* alike; they do not have the same probability:
 *
 *     all 99        _B3S_ = 0.00990   _C3S_ = 0.00990   ← indistinguishable
 *     Picklock@50   _B3S_ = 0.49005   _C3S_ = 0.00254   ← 200x apart
 */
import { type ScenarioTree } from './scenarioTree.js'
import { rolesInText } from './endingMap.js'

/**
 * The chance a checkpoint passes.
 *
 * ⚠️ **Several named roles AVERAGE — they are not all required to pass.** Both
 * MonChoon and I assumed a product ("both must clear it"), and it is the worst
 * fitting rule of the five tested: across all 31 scenarios, mean absolute error
 * against the service's own `successChance` was 0.0350 for a product against
 * **0.0131** for the average, with the average landing on *exactly* zero for
 * seven scenarios that genuinely contain multi-role checkpoints. Confirmed with
 * MonChoon 2026-08-15, who also confirmed it holds for three roles and more.
 *
 * A weak member is therefore carried by a strong partner rather than dragging
 * the pair down — which changes which crimes are worth running, so getting it
 * backwards would have quietly mis-ranked the whole simulator.
 *
 * ⚠️ A checkpoint naming NO role is treated as the whole crew — *"The whole
 * team assaults the guards"*, *"The crew finds the side entrance locked"*. Six
 * of 604 checkpoints read this way.
 *
 * ⚠️ **Measured, and the nickname hypothesis it used to carry is dead** (#473).
 * The suspicion was that checkpoints referring to the crew by nickname
 * attributed to nobody and were hiding behind this rule. Dumping every no-role
 * checkpoint in all 31 diagrams and reading them settled it:
 *
 *   - Only TWO of the six were mis-attributed — Lock Stock's *"The bruisers
 *     feign defeat"* (Muscle #1 + #2) and Bidding War's *"The Humvee crashes
 *     into the wall"* (the Driver). Both are now resolved by `rolesInText`.
 *   - The other four genuinely mean everyone — *"The whole team assaults the
 *     guards"*, *"The crew finds the side entrance locked"* — so this rule is
 *     right for them, not a fallback hiding a fault.
 *   - ⚠️ And both mis-attributed checkpoints were in scenarios that ALREADY
 *     fit tightly, so fixing them improved nothing that was loose. Eight of the
 *     ten loose fits contain no no-role checkpoint at all.
 *
 * The fault in the loose group is the OPPOSITE one: over-attribution, where a
 * role named only in the possessive gets averaged in as a participant. Manifest
 * Cruelty's *"Reviver curses Interrogator's overexuberance"* made a fatal
 * Reviver failure look survivable and cost that crime 0.113 of residual. See
 * `dropPossessiveReferents` in endingMap.ts.
 */
export function checkpointPass(
  text: string,
  roleNames: string[],
  cpr: Record<string, number>
): number {
  const named = rolesInText(text, roleNames)
  // Mentioned roles count even when the prose makes them sound incidental:
  // Stacking the Deck's "Seeing Cat Burglar struggle, Imitator tries to help"
  // fits to 1e-05 only when Cat Burglar is included. The narrative is written
  // around the maths, not the other way round (MonChoon, 2026-08-15).
  const involved = named.length > 0 ? named : roleNames
  if (involved.length === 0) return 0
  const total = involved.reduce((sum, r) => sum + (cpr[r] ?? 0), 0)
  return clamp01(total / involved.length / 100)
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n)

/**
 * Probability mass reaching each terminal, for one CPR vector.
 *
 * A topological walk, so every node is settled before anything downstream reads
 * it — which matters because these diagrams are not trees. A checkpoint failure
 * often rejoins the main line (Pet Project fails `_A2_C1_`, passes `_A2_C2_`,
 * and arrives at the same ending as if it had never failed), so the same
 * terminal accumulates mass down several paths and a depth-first walk would
 * either miss paths or count them twice.
 *
 * ⚠️ That rejoining is exactly what made `CPR/100` look wrong. Dropping Pet
 * Project's Kidnapper to 50 leaves the all-pass ending at 0.74 of baseline, not
 * 0.50, because `0.5 + 0.5 x 0.5 = 0.75` — fail, then recover. Only a forward
 * walk over the real graph sees that.
 */
export function simulateScenario(
  tree: ScenarioTree,
  roleNames: string[],
  cpr: Record<string, number>
): Map<string, number> {
  const mass = new Map<string, number>()
  const results = new Map<string, number>()
  if (!tree.root) return results
  mass.set(tree.root, 1)

  for (const id of topologicalOrder(tree)) {
    const m = mass.get(id) ?? 0
    const node = tree.nodes.get(id)
    const kids = tree.edges.get(id) ?? []

    if (kids.length === 0) {
      // A terminal with zero mass is still a real ending — recorded at 0 rather
      // than omitted, so callers can tell "unreachable at these CPRs" from
      // "not in this diagram".
      if (node?.kind === 'terminal') results.set(id, m)
      continue
    }
    if (m === 0) continue

    if (node?.kind === 'checkpoint') {
      const p = checkpointPass(node.text, roleNames, cpr)
      for (const kid of kids) {
        const failed = isFailEdge(tree, id, kid)
        mass.set(kid, (mass.get(kid) ?? 0) + m * (failed ? 1 - p : p))
      }
    } else {
      // Narrative nodes have one way out. More than one has never been observed
      // and would mean the diagram encodes a branch we do not understand, so
      // the mass is split evenly and the caller can spot it in the residual
      // rather than the simulation silently losing probability.
      for (const kid of kids) mass.set(kid, (mass.get(kid) ?? 0) + m / kids.length)
    }
  }
  return results
}

/** Total probability of any GOOD ending — comparable to the API's `successChance`. */
export function simulatedSuccess(
  tree: ScenarioTree,
  roleNames: string[],
  cpr: Record<string, number>
): number {
  let total = 0
  for (const [id, p] of simulateScenario(tree, roleNames, cpr)) {
    if (tree.nodes.get(id)?.ending === 'good') total += p
  }
  return total
}

/**
 * The diagram labels checkpoint edges "Pass"/"Fail". The id convention
 * (`_A1_C1_` → `_A1_C1F_`) agrees today but the label is the actual statement,
 * so it wins and the convention is only the fallback.
 */
function isFailEdge(tree: ScenarioTree, from: string, to: string): boolean {
  const label = tree.edgeLabels.get(`${from}>${to}`)?.toLowerCase()
  if (label === 'fail') return true
  if (label === 'pass') return false
  return to === `${from.slice(0, -1)}F_`
}

/**
 * Kahn's algorithm.
 *
 * ⚠️ Nodes still holding an in-degree at the end are in a cycle and are
 * appended rather than dropped. A cycle should not exist in these diagrams, but
 * silently discarding nodes would lose probability mass and show up only as an
 * ending that is mysteriously too cheap.
 */
function topologicalOrder(tree: ScenarioTree): string[] {
  const indegree = new Map<string, number>()
  for (const id of tree.nodes.keys()) indegree.set(id, 0)
  for (const kids of tree.edges.values()) {
    for (const kid of kids) indegree.set(kid, (indegree.get(kid) ?? 0) + 1)
  }

  const queue = [...tree.nodes.keys()].filter((id) => (indegree.get(id) ?? 0) === 0)
  const order: string[] = []
  const seen = new Set<string>()
  while (queue.length > 0) {
    const id = queue.shift()!
    order.push(id)
    seen.add(id)
    for (const kid of tree.edges.get(id) ?? []) {
      const left = (indegree.get(kid) ?? 0) - 1
      indegree.set(kid, left)
      if (left === 0) queue.push(kid)
    }
  }
  for (const id of tree.nodes.keys()) if (!seen.has(id)) order.push(id)
  return order
}
