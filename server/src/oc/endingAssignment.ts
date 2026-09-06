/**
 * Assigning `goodEndingN` to diagram terminals by simulated probability (#471).
 *
 * The old derivation reasoned about endings one at a time — pick the best
 * terminal for this ending, mark it taken, move on. That greedy pass is the
 * source of "no unclaimed ending at depth N": an early ending takes a node a
 * later one had no alternative for, and the whole scenario is refused.
 *
 * This assigns them **all at once**, minimising total disagreement between the
 * simulated distribution and the API's, over every probe. It is the same shape
 * as the assignment problem, so it gets the same solution: Hungarian, which is
 * exact, rather than greedy, which is not.
 *
 * ⚠️ The distinguishing power comes from using the whole probe sweep. Two
 * endings can be identical at the baseline and separated by orders of magnitude
 * once a role is dropped:
 *
 *     all 99        _B3S_ = 0.00990   _C3S_ = 0.00990
 *     Picklock@50   _B3S_ = 0.49005   _C3S_ = 0.00382
 */
import { type ScenarioTree } from './scenarioTree.js'
import { simulateScenario } from './scenarioSimulator.js'
import { realEndingKeys, type Probe } from './endingMap.js'

export interface AssignmentResult {
  /** ending key → node id. Only when the assignment covers every ending. */
  map: Record<string, string>
  ok: boolean
  problems: string[]
  /**
   * Mean per-ending disagreement, 0 (perfect) to 1 (nothing matches).
   *
   * ⚠️ Stored and surfaced rather than only tested, because a bad fit is the
   * one failure this whole module can produce silently: an assignment always
   * returns *something*, and without a residual a confidently wrong mapping
   * looks exactly like a right one.
   */
  residual: number
  /** Endings with no terminal to take, or terminals with no ending. */
  unmatched: { endings: string[]; terminals: string[] }
  /** Per-ending mean disagreement, for the pairs that were accepted. */
  perEnding: Record<string, number>
  /**
   * The same disagreement, weighted by how much probability each ending
   * actually carries (#473).
   *
   * ⚠️ `residual` is scale-free on purpose — see `disagreement` — which is
   * right for CHOOSING an assignment and misleading as a measure of how wrong
   * the resulting MONEY is. An ending at 1e-4 that we simulate at 3e-4 moves
   * the plain residual as much as the dominant ending being wrong by half,
   * while costing nothing at all in E(x), because E(x) weights every ending by
   * its probability.
   *
   * Measured across all 31 scenarios the two disagree in BOTH directions.
   * Mob Mentality reads 0.145 plain (flagged as a loose fit) and 0.003
   * weighted — its whole disagreement sits in endings that essentially never
   * happen. Before the possessive fix in this same issue, Plucking the Lotus
   * Petal read 0.061 plain (comfortably "confident") and 0.108 weighted, with
   * the error in the ending carrying 98% of the mass.
   *
   * So this is the figure to trust the per-ending money on, and `residual`
   * stays the figure to judge the assignment on. Both are reported because
   * they answer different questions.
   */
  massWeightedResidual: number
  /**
   * Whether the per-ending MONEY can be trusted — `confident` for E(x).
   *
   * Separate from `confident` for the reason above: a mapping can be a poor
   * fit overall while being right about everything that pays, and vice versa.
   */
  moneyConfident: boolean
  /**
   * Whether the fit is tight enough to trust the per-ending money.
   *
   * ⚠️ Separate from `ok` on purpose. `ok` says every reported ending got a
   * node; `confident` says the numbers behind that assignment line up. A
   * mapping can be complete and still be wrong about which ending is which.
   */
  confident: boolean
}

/**
 * Residual above which a scenario's mapping is reported as **not confident**.
 *
 * ⚠️ A per-SCENARIO judgement, and the first attempt got this wrong. Rejecting
 * individual PAIRS above a threshold sounds safer and measured *worse*: 15/31
 * against 28/31, because a rare ending can disagree loudly on its own while the
 * assignment as a whole is plainly right. Fit is a property of the whole
 * assignment, not of one row of it.
 *
 * 0.10 is where the measured population actually splits. Across all 31
 * scenarios the residuals fall into two groups with nothing in between:
 *
 *     tight   0.0008 - 0.082   21 scenarios
 *     loose   0.10   - 0.31    10 scenarios
 *
 * ⚠️ The loose group nearly all report `successChance` EXACTLY right, so the
 * simulation is sound and the total is right while the split between endings is
 * not. They are mapped, and flagged, rather than dropped — but their per-ending
 * money should not be trusted until the cause is found. The live suspects are
 * the crew rule and role nicknames ("The bruisers" = Muscle #1 + #2).
 */
export const MAX_CONFIDENT_RESIDUAL = 0.10

/**
 * Mass-weighted residual above which the per-ending money is not trusted.
 *
 * ⚠️ A DISCOVERED split, not a chosen one — held to the same standard as
 * MAX_CONFIDENT_RESIDUAL above. Sorting all 31 scenarios by their mass-weighted
 * residual leaves one order-of-magnitude gap and no other:
 *
 *     0.3700 … 0.0390  0.0365  0.0353      14 scenarios
 *                      ── x10.4 gap ──
 *     0.0034  0.0025 … 0.0000               17 scenarios
 *
 * Every other adjacent gap in that range is 1.5x or less. 0.01 sits inside the
 * only real discontinuity in the population.
 */
export const MAX_MONEY_RESIDUAL = 0.01

/**
 * Scale-free disagreement between two probabilities, in [0, 1].
 *
 * ⚠️ Not the absolute difference. The dominant all-pass ending sits near 0.97
 * and the rare ones near 1e-4, so absolute error would be almost entirely
 * about the big one — and swapping two rare endings would cost nothing, making
 * their assignment arbitrary. The epsilon floor keeps the API's 4-decimal
 * rounding from dominating the comparison of two near-zero values.
 */
export function disagreement(a: number, b: number): number {
  const denom = a + b + 1e-4
  return Math.abs(a - b) / denom
}

/**
 * Match the API's ending keys onto diagram terminals.
 *
 * `probes` must each carry the CPR vector that produced them — the simulation
 * is re-run per probe, and a probe whose vector we do not know is evidence we
 * cannot use.
 */
export function assignEndings(
  tree: ScenarioTree,
  roleNames: string[],
  probes: Probe[],
  kind: 'good' | 'bad' = 'good'
): AssignmentResult {
  const problems: string[] = []
  const usable = probes.filter((p) => p.cprs)
  if (usable.length === 0) {
    return {
      map: {}, ok: false, confident: false, residual: 1, perEnding: {},
      massWeightedResidual: 1, moneyConfident: false,
      problems: ['no probe carried its CPR vector, so nothing can be simulated'],
      unmatched: { endings: [], terminals: [] },
    }
  }

  const endingKeys = realEndingKeys(kind === 'good' ? 'goodEnding' : 'badEnding', probes)
  const terminals = tree.terminals.filter((t) => t.ending === kind).map((t) => t.id)

  // Simulate once per probe; every ending/terminal pair reads the same columns.
  const simulated = usable.map((p) => simulateScenario(tree, roleNames, p.cprs!))

  const cost: number[][] = endingKeys.map((key) =>
    terminals.map((id) =>
      usable.reduce((sum, probe, i) =>
        sum + disagreement(probe.endings[key] ?? 0, simulated[i].get(id) ?? 0), 0)
    )
  )

  const pairs = hungarian(cost)
  const map: Record<string, string> = {}
  const perEnding: Record<string, number> = {}
  let totalCost = 0
  for (const [row, col] of pairs) {
    perEnding[endingKeys[row]] = Number((cost[row][col] / usable.length).toFixed(5))
    map[endingKeys[row]] = terminals[col]
    totalCost += cost[row][col]
  }

  const accepted = Object.keys(map).length
  const residual = accepted > 0 ? totalCost / (accepted * usable.length) : 1
  const unmatchedEndings = endingKeys.filter((k) => !(k in map))
  // An ending with no terminal AT ALL — more endings than the diagram has
  // nodes, so Hungarian pairs it with padding and it never reaches `map`.
  const starved = unmatchedEndings
  if (starved.length > 0) {
    problems.push(
      `the diagram has no ${kind} ending left for ${starved.join(', ')} — ` +
      `the API reports ${endingKeys.length} but the flowchart draws ${terminals.length}`
    )
  }
  const takenNodes = new Set(Object.values(map))
  const unmatchedTerminals = terminals.filter((t) => !takenNodes.has(t))

  // ⚠️ A SPARE TERMINAL is not a failure. Snow Blind's diagram draws a sixth
  // good ending the API never reports; every ending we were asked to price
  // still got a node. Only an unmatched ENDING leaves money unpriced.
  if (unmatchedTerminals.length > 0) {
    problems.push(
      `the diagram draws ${unmatchedTerminals.length} ${kind} ending(s) the API never reports: ` +
      unmatchedTerminals.join(', ')
    )
  }

  // ⚠️ Weighted by the BASELINE probabilities — the all-high probe, which is
  // the closest thing to "how often this ending actually happens" that the
  // sweep contains. Weighting by each probe's own numbers would let the
  // deliberately crippled low-CPR probes, which exist to separate endings
  // rather than to describe reality, dominate a figure about money.
  const baseline = usable.find((p) => p.droppedRole == null) ?? usable[0]
  let massSum = 0
  let weighted = 0
  for (const [key, dis] of Object.entries(perEnding)) {
    const m = Number(baseline?.endings?.[key] ?? 0)
    if (!Number.isFinite(m) || m <= 0) continue
    massSum += m
    weighted += m * dis
  }
  const massWeightedResidual = massSum > 0 ? weighted / massSum : 0

  return {
    map,
    // Success is "every ending the API reports has a node", which is what
    // pricing needs. Spare terminals are reported but do not fail the crime.
    ok: unmatchedEndings.length === 0,
    confident: unmatchedEndings.length === 0 && residual <= MAX_CONFIDENT_RESIDUAL,
    moneyConfident: unmatchedEndings.length === 0 && massWeightedResidual <= MAX_MONEY_RESIDUAL,
    problems,
    residual,
    massWeightedResidual,
    unmatched: { endings: unmatchedEndings, terminals: unmatchedTerminals },
    perEnding,
  }
}

/**
 * Hungarian algorithm (Jonker–Volgenant shortest-augmenting-path form), O(n^3).
 *
 * Returns `[row, col]` pairs minimising total cost. Rectangular input is fine:
 * the smaller side is fully matched and the surplus reported by the caller.
 *
 * Written out rather than pulled in — it is forty lines, it runs on matrices of
 * at most about ten by ten, and a dependency here would be a supply-chain risk
 * taken to avoid an afternoon's arithmetic.
 */
export function hungarian(cost: number[][]): Array<[number, number]> {
  const rows = cost.length
  if (rows === 0) return []
  const cols = cost[0].length
  if (cols === 0) return []

  // Work on a square padded matrix; padding costs zero so it never competes.
  const n = Math.max(rows, cols)
  const INF = Number.POSITIVE_INFINITY
  const a: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i < rows && j < cols ? cost[i][j] : 0))
  )

  const u = new Array(n + 1).fill(0)
  const v = new Array(n + 1).fill(0)
  const p = new Array(n + 1).fill(0) // column → row
  const way = new Array(n + 1).fill(0)

  for (let i = 1; i <= n; i++) {
    p[0] = i
    let j0 = 0
    const minv = new Array(n + 1).fill(INF)
    const used = new Array(n + 1).fill(false)
    do {
      used[j0] = true
      const i0 = p[j0]
      let delta = INF
      let j1 = 0
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue
        const cur = a[i0 - 1][j - 1] - u[i0] - v[j]
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0 }
        if (minv[j] < delta) { delta = minv[j]; j1 = j }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta }
        else minv[j] -= delta
      }
      j0 = j1
    } while (p[j0] !== 0)
    do {
      const j1 = way[j0]
      p[j0] = p[j1]
      j0 = j1
    } while (j0 !== 0)
  }

  const out: Array<[number, number]> = []
  for (let j = 1; j <= n; j++) {
    const i = p[j] - 1
    const col = j - 1
    if (i >= 0 && i < rows && col < cols) out.push([i, col])
  }
  return out.sort((x, y) => x[0] - y[0])
}
