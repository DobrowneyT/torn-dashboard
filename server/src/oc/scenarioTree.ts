/**
 * OC scenario flowcharts from tornprobability.com (#390).
 *
 * The site serves each scenario as a base64 mermaid flowchart on an SSE feed
 * (`/events/x7k2?s=<scenario>`, `event: diagram`), alongside per-ending money
 * statistics keyed by DIAGRAM NODE ID (`_A8S_`). The probability API answers in
 * a completely different vocabulary — `goodEnding1..N` — and nothing in either
 * response states the correspondence.
 *
 * That join is the whole risk of this feature. Get it wrong and every ending is
 * paired with a different ending's money: all the numbers stay plausible, the
 * expected values are all wrong, and an OC manager schedules real crimes around
 * them. This module exists to make the join derivable from structure rather
 * than assumed from ordering.
 *
 * ⚠️ The obvious shortcut is provably wrong. For Break the Bank the terminals
 * are declared `_A8S_, _A10S_, _A9S_, _B3S_`, so position-matching would make
 * `goodEnding1` = `_A8S_`. But probing the API at all-99 CPRs puts 97% of the
 * mass on `goodEnding1`, which has to be the every-checkpoint-passed path — and
 * that is not `_A8S_`.
 */

/** Mermaid node shapes, which encode what a node MEANS on this site. */
export type NodeKind =
  | 'narrative'   // ([...]) — a story beat, no branching
  | 'checkpoint'  // {...}   — a CPR roll; the thing that can fail
  | 'outcome'     // [...]   — the branch taken after a checkpoint resolves
  | 'terminal'    // an ending: id ends S (success) or F (failure)

export interface ScenarioNode {
  id: string
  kind: NodeKind
  text: string
  /** Set on terminals only. */
  ending?: 'good' | 'bad'
}

export interface ScenarioTree {
  nodes: Map<string, ScenarioNode>
  /** Adjacency, parent id → child ids, in declaration order. */
  edges: Map<string, string[]>
  /** Reverse adjacency — terminals need to be walked back to the root. */
  parents: Map<string, string[]>
  /** `"<from>><to>"` → edge label. Checkpoints label theirs "Pass" / "Fail". */
  edgeLabels: Map<string, string>
  root: string | null
  terminals: ScenarioNode[]
}

/** `&#39;` and friends: the diagram is HTML-escaped for the browser. */
function unescapeHtml(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

/**
 * A terminal is a node whose id ends in `S` or `F` before the trailing
 * underscore — `_A8S_`, `_B3S_`, `_A1F_`.
 *
 * ⚠️ NOT every `F`-suffixed id is a terminal. `_A1_C1F_` is the *failure
 * branch* of checkpoint `_A1_C1_` and the story continues from it — the crime
 * has not ended. The distinguishing feature is having no outgoing edges, which
 * is why this is only ever applied together with the edge map.
 */
function terminalEnding(id: string): 'good' | 'bad' | null {
  // The variant digit is load-bearing: `_A8S2_` is a SECOND success ending at
  // A8, and it carries its own money statistics. Requiring the letter to be
  // last dropped it entirely, leaving four good endings against the API's five.
  const m = /^_.*?([SF])\d*_$/.exec(id)
  if (!m) return null
  return m[1] === 'S' ? 'good' : 'bad'
}

const NODE_DECL = /^\s*(_[A-Za-z0-9_]+_)\s*(\(\[|\{|\[)/

/**
 * An edge, with its optional label.
 *
 * Mermaid spells labels two ways and this site uses the first:
 *   `_A8_C1_ -- "Pass" --> _A8_C1P_`
 *   `_A8_C1_ -->|Pass| _A8_C1P_`
 *
 * ⚠️ Missing the labelled form is not a cosmetic loss. Every checkpoint's Pass
 * and Fail edges are labelled, so a regex that only matched the bare `-->`
 * silently dropped all 36 of them — severing each checkpoint from both its
 * branches and leaving whole subtrees unreachable from the root.
 */
const EDGE = /^\s*(_[A-Za-z0-9_]+_)\s*(?:--\s*"([^"]*)"\s*)?-->\s*(?:\|([^|]*)\|\s*)?(_[A-Za-z0-9_]+_)/

/**
 * Parse a mermaid flowchart into a tree.
 *
 * Deliberately tolerant of unknown syntax rather than strict: this is someone
 * else's rendering format and it will change without notice. A node shape we do
 * not recognise becomes `narrative`, which is inert — whereas throwing would
 * take the whole mirror job down over a cosmetic edit upstream.
 */
export function parseScenarioTree(mermaid: string): ScenarioTree {
  const nodes = new Map<string, ScenarioNode>()
  const edges = new Map<string, string[]>()
  const parents = new Map<string, string[]>()
  const edgeLabels = new Map<string, string>()

  for (const rawLine of mermaid.split('\n')) {
    const line = rawLine.trimEnd()

    const edge = EDGE.exec(line)
    if (edge) {
      const [, from, dashLabel, pipeLabel, to] = edge
      const label = (dashLabel ?? pipeLabel ?? '').trim()
      if (!edges.has(from)) edges.set(from, [])
      if (!edges.get(from)!.includes(to)) edges.get(from)!.push(to)
      if (!parents.has(to)) parents.set(to, [])
      if (!parents.get(to)!.includes(from)) parents.get(to)!.push(from)
      if (label) edgeLabels.set(`${from}>${to}`, label)
      continue
    }

    const decl = NODE_DECL.exec(line)
    if (!decl) continue
    const [, id, open] = decl
    const kind: NodeKind = open === '{' ? 'checkpoint' : open === '([' ? 'narrative' : 'outcome'
    const text = unescapeHtml((/"([\s\S]*)"/.exec(line)?.[1] ?? '').trim())
    if (!nodes.has(id)) nodes.set(id, { id, kind, text })
  }

  // Nodes can appear in an edge before (or without) a declaration line.
  for (const id of [...edges.keys(), ...parents.keys()]) {
    if (!nodes.has(id)) nodes.set(id, { id, kind: 'narrative', text: '' })
  }

  // Terminals: an ending suffix AND no way out.
  const terminals: ScenarioNode[] = []
  for (const node of nodes.values()) {
    const ending = terminalEnding(node.id)
    if (!ending) continue
    if ((edges.get(node.id) ?? []).length > 0) continue
    node.kind = 'terminal'
    node.ending = ending
    terminals.push(node)
  }

  // The root is the only node nothing points at. `_Prelude_` by convention, but
  // derived rather than assumed — the convention is theirs to change.
  const root = [...nodes.keys()].find((id) => (parents.get(id) ?? []).length === 0) ?? null

  return { nodes, edges, parents, edgeLabels, root, terminals }
}

/**
 * Every path from the root to `terminalId`, as node-id lists.
 *
 * Cycle-guarded. The flowcharts are DAGs today, but a rendering bug upstream
 * that introduced a loop would otherwise hang the mirror job rather than
 * failing, and a hung cron is much harder to notice than a failed one.
 */
export function pathsToTerminal(tree: ScenarioTree, terminalId: string): string[][] {
  const out: string[][] = []
  const walk = (id: string, path: string[], seen: Set<string>) => {
    if (seen.has(id)) return
    const next = [...path, id]
    if (id === tree.root) { out.push([...next].reverse()); return }
    for (const parent of tree.parents.get(id) ?? []) {
      walk(parent, next, new Set([...seen, id]))
    }
  }
  walk(terminalId, [], new Set())
  return out
}

/**
 * How many checkpoints a path had to PASS, and how many it failed.
 *
 * This is what ranks endings against each other. A path that fails no
 * checkpoint is the all-pass ending — the one that dominates when every CPR is
 * near 100 — and that single fact anchors the whole mapping, because the API's
 * behaviour at extreme inputs is observable while its numbering is not.
 *
 * A checkpoint is "failed" on a path when the path goes through that
 * checkpoint's `F` branch: `_A1_C1_` → `_A1_C1F_`.
 */
export function checkpointsOnPath(tree: ScenarioTree, path: string[]): { passed: number; failed: number } {
  let passed = 0
  let failed = 0
  for (let i = 0; i < path.length; i++) {
    const node = tree.nodes.get(path[i])
    if (node?.kind !== 'checkpoint') continue
    const next = path[i + 1]
    if (!next) continue
    // The diagram labels every checkpoint edge "Pass" or "Fail", so read what
    // it says rather than inferring from the child's id. The id convention
    // (`_A1_C1F_`) happens to agree today, but it is a convention and the
    // label is the actual statement.
    const label = tree.edgeLabels.get(`${node.id}>${next}`)?.toLowerCase()
    if (label === 'fail') failed += 1
    else if (label === 'pass') passed += 1
    else if (next === `${node.id.slice(0, -1)}F_`) failed += 1
    else passed += 1
  }
  return { passed, failed }
}

/**
 * The terminal reached when every checkpoint passes, or null if that is not
 * unique.
 *
 * Null is the honest answer for a scenario whose structure does not have a
 * single all-pass ending, and callers must treat it as "cannot map" rather than
 * picking one. An ambiguous anchor is exactly how a plausible-but-wrong mapping
 * would get made.
 */
export function allPassTerminal(tree: ScenarioTree): ScenarioNode | null {
  const candidates = tree.terminals.filter((t) => {
    if (t.ending !== 'good') return false
    return pathsToTerminal(tree, t.id).some((p) => checkpointsOnPath(tree, p).failed === 0)
  })
  return candidates.length === 1 ? candidates[0] : null
}

/**
 * Structural problems with a parsed tree.
 *
 * MonChoon's invariant (2026-08-13): "every branch should go to some leaf and
 * have either a pass / fail case, so we should be able to verify the outcomes
 * and that we have parsed it correctly."
 *
 * That is exactly right, and it is worth far more than a spot check. These are
 * properties the SOURCE must have — a crime always resolves, and a checkpoint
 * always has both outcomes — so any violation means one of two things, and both
 * matter: either the diagram changed shape upstream, or the parser dropped
 * something. The labelled-edge bug that severed 36 checkpoint branches would
 * have been caught instantly by `checkpointsMissingBranch`, rather than by my
 * noticing a path count was zero.
 *
 * This is therefore the mirror job's gate: a scenario that fails validation is
 * refused rather than mapped, because a partial tree still produces confident
 * numbers.
 */
export interface TreeValidation {
  ok: boolean
  /** Checkpoints without exactly one Pass and one Fail edge. */
  checkpointsMissingBranch: string[]
  /** Non-terminal nodes with nowhere to go — the story stops without ending. */
  deadEnds: string[]
  /** Nodes with no path back to the root; they can never be reached. */
  unreachable: string[]
  /** Terminals the root cannot reach — an ending that can never happen. */
  unreachableTerminals: string[]
}

export function validateScenarioTree(tree: ScenarioTree): TreeValidation {
  const checkpointsMissingBranch: string[] = []
  const deadEnds: string[] = []

  for (const node of tree.nodes.values()) {
    const out = tree.edges.get(node.id) ?? []

    if (node.kind === 'checkpoint') {
      const labels = out.map((to) => (tree.edgeLabels.get(`${node.id}>${to}`) ?? '').toLowerCase())
      const hasPass = labels.includes('pass')
      const hasFail = labels.includes('fail')
      // Both outcomes, or it is not a decision — it is a fork we have half of.
      if (!hasPass || !hasFail) checkpointsMissingBranch.push(node.id)
      continue
    }

    // A terminal is SUPPOSED to have no way out; anything else that does not
    // is a branch that never reaches a leaf.
    if (node.kind !== 'terminal' && out.length === 0) deadEnds.push(node.id)
  }

  // Reachability from the root, forwards.
  const seen = new Set<string>()
  const stack = tree.root ? [tree.root] : []
  while (stack.length > 0) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    for (const to of tree.edges.get(id) ?? []) stack.push(to)
  }
  const unreachable = [...tree.nodes.keys()].filter((id) => !seen.has(id))
  const unreachableTerminals = tree.terminals.filter((t) => !seen.has(t.id)).map((t) => t.id)

  return {
    ok: checkpointsMissingBranch.length === 0 && deadEnds.length === 0 && unreachable.length === 0,
    checkpointsMissingBranch,
    deadEnds,
    unreachable,
    unreachableTerminals,
  }
}
