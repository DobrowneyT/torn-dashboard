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
  /**
   * Two roles dropped together (#390 follow-up). Roles gating the SAME
   * checkpoint are indistinguishable one at a time — dropping either produces
   * the same lift on the same endings — so a pair probe is the only evidence
   * that separates the terminals behind them. Requested lazily: the derivation
   * reports which pairs it needs, and only those are fetched.
   */
  droppedRoles?: string[]
  /**
   * The CPR the dropped role was set to. ⚠️ Several levels are probed per role
   * and the level is load-bearing — see `observedLift`.
   */
  droppedTo?: number
  /** `goodEnding1` / `badEnding1` → probability. */
  endings: Record<string, number>
}

export interface EndingMapping {
  /** ending key → node id. Only present when the derivation fully succeeded. */
  map: Record<string, string>
  ok: boolean
  /** Why it failed, in terms a reader can act on. */
  problems: string[]
  /**
   * Role pairs whose joint drop would settle a tie this pass could not. The
   * caller fetches exactly these probes and re-derives — cheap, because only
   * scenarios that actually tie ask, and they ask for one or two pairs, not
   * all N(N-1)/2.
   */
  neededPairs: Array<[string, string]>
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
): { depth: number; failRoles: Set<string>; passRoles: Set<string>; ambiguousRoles: Set<string> } {
  const paths = pathsToTerminal(tree, terminalId)
  if (paths.length === 0) {
    return { depth: Infinity, failRoles: new Set(), passRoles: new Set(), ambiguousRoles: new Set() }
  }

  const depths = paths.map((p) => checkpointsOnPath(tree, p).failed)
  const depth = Math.min(...depths)

  const failRoles = new Set<string>()
  const passRoles = new Set<string>()
  paths.forEach((path, i) => {
    if (depths[i] !== depth) return
    for (let j = 0; j < path.length; j++) {
      const node = tree.nodes.get(path[j])
      if (node?.kind !== 'checkpoint') continue
      const label = tree.edgeLabels.get(`${node.id}>${path[j + 1]}`)?.toLowerCase()
      const failed = label === 'fail' || (label !== 'pass' && path[j + 1] === `${node.id.slice(0, -1)}F_`)
      for (const r of rolesInText(node.text, roleNames)) (failed ? failRoles : passRoles).add(r)
    }
  })

  // ⚠️ A role on BOTH sides predicts nothing. Pet Project's retry chain has
  // Picklock fail `_A1_C1_` and then pass `_A1_C3_` on the same path: dropping
  // Picklock makes the failure likelier AND destroys the later pass, so the net
  // direction is genuinely unknown. Recorded rather than resolved — scoring
  // skips these roles instead of predicting a direction and being graded on it.
  const ambiguousRoles = new Set([...failRoles].filter((r) => passRoles.has(r)))

  return { depth, failRoles, passRoles, ambiguousRoles }
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
  return new Set(observedLift(endingKey, probes, margin).keys())
}

/**
 * The same evidence, keeping HOW MUCH each role's drop raises the ending.
 *
 * ⚠️ The magnitude is the discriminator, and discarding it is what left eleven
 * scenarios unmapped. `observedSignature` answers "does this role lead here",
 * which two terminals sharing a checkpoint answer identically — so scoring by
 * the SIZE of the intersection ties them and the derivation gives up.
 *
 * The lift is not uniform, though: the role gating the checkpoint immediately
 * before an ending multiplies it by orders of magnitude, while a role three
 * checkpoints upstream barely moves it. Summing lift over a terminal's own
 * failure roles therefore separates terminals that a set-intersection cannot.
 *
 * Returned as a ratio to baseline. Endings with a zero baseline use an epsilon
 * floor — they are exactly the rare endings a drop is meant to reveal, and
 * dividing by zero would either drop them or rank them infinite.
 */
/**
 * The full signed response: how each role's CPR drop moves this ending.
 *
 * ⚠️ **Falls are evidence, and ignoring them is what left nine crimes
 * unmapped.** The derivation read only rises, so an ending like Pet Project's
 * `goodEnding2` — which no role raises — reported "no role evidence" while
 * sitting on an unambiguous fingerprint:
 *
 *     goodEnding2  base 0.0097
 *       drop Kidnapper → 0.00019   (falls)
 *       drop Muscle    → 0         (falls)
 *       drop Picklock  → 0.0097    (flat)
 *
 * A rise means that role's failure leads here. A FALL means the opposite and is
 * just as strong: this ending needed that role to pass, so wrecking the role
 * destroys the path. Flat means the role is not on the path at all — which is
 * itself the third distinguishable state, and the one that separates endings
 * sharing every other signal.
 */
export type RoleResponse = 'rise' | 'fall' | 'flat'

export function observedResponse(
  endingKey: string,
  probes: Probe[],
  margin = 1.5
): Map<string, RoleResponse> {
  const baseline = probes.find((p) => p.droppedRole === null && !p.droppedRoles)?.endings[endingKey]
  const out = new Map<string, RoleResponse>()
  if (baseline === undefined) return out

  for (const probe of probes) {
    if (probe.droppedRole === null || probe.droppedRoles) continue
    const v = probe.endings[endingKey]
    if (v === undefined) continue

    // ⚠️ An ending at 0.0001 is at the API's reporting floor: it cannot fall
    // any further and cannot be read as flat either. Treating "0 → 0" as flat
    // would invent agreement out of a measurement we never made.
    if (baseline <= 1e-4 && v <= 1e-4) continue

    const here: RoleResponse = v > baseline * margin ? 'rise'
      : v * margin < baseline ? 'fall'
      : 'flat'
    // ⚠️ A rise at ANY probed level settles it. Saturation hides rises but
    // never invents them, so one level seeing the ending appear outranks
    // another level seeing it collapse.
    const seen = out.get(probe.droppedRole)
    if (seen === 'rise') continue
    if (here === 'rise' || seen === undefined || (seen === 'flat' && here === 'fall')) {
      out.set(probe.droppedRole, here)
    }
  }
  return out
}

export function observedLift(endingKey: string, probes: Probe[], margin = 1.5): Map<string, number> {
  const baseline = probes.find((p) => p.droppedRole === null && !p.droppedRoles)?.endings[endingKey]
  const out = new Map<string, number>()
  if (baseline === undefined) return out

  // The API reports 4 decimal places, so an ending below 1e-4 reads as exactly
  // 0 at baseline. Half a reporting step is the smallest lift we could have
  // detected, and using it keeps the ratio finite and comparable.
  const floor = 5e-5
  const base = Math.max(baseline, floor)

  for (const probe of probes) {
    // Single-role drops only — a pair probe raises an ending for either of two
    // reasons and cannot be attributed to one role.
    if (probe.droppedRole === null || probe.droppedRoles) continue
    const v = probe.endings[endingKey]
    if (v === undefined) continue
    if (v <= Math.max(baseline * margin, baseline + 1e-9)) continue
    // ⚠️ Strongest level wins. A role is probed at several CPRs and only some
    // reveal a given ending, so taking the last (or the lowest CPR) throws away
    // the observation that actually found it.
    const ratio = v / base
    if (ratio > (out.get(probe.droppedRole) ?? 0)) out.set(probe.droppedRole, ratio)
  }
  return out
}

/**
 * The ending slots that are REAL, discarding the API's zero padding.
 *
 * ⚠️ Found by running all 31 scenarios on 2026-08-13. The service answers with
 * a fixed number of ending slots and pads the unused tail with exact zeros:
 * Plucking the Lotus Petal returns `goodEnding1..10` where 5–10 are all 0 and
 * the diagram has exactly 4 endings; Ace in the Hole returns 10 where 8–10 are
 * 0 against 7 in the diagram. Comparing the raw key count against the diagram
 * made seven scenarios look like the API and the diagram disagreed about the
 * crime's shape, and refused all of them.
 *
 * The trim is deliberately conservative in two ways:
 *
 *   - Only a TRAILING run of zeros is dropped. A zero in the middle is a real
 *     ending that happens to be unreachable at these CPRs, and renumbering
 *     around it would shift every ending after it onto the wrong node.
 *   - An ending counts as real if it is non-zero in ANY probe, not just the
 *     baseline. Dropping a role to CPR 1 is exactly what makes the rare endings
 *     appear, so the sweep sees endings the baseline alone would call empty.
 */
export function realEndingKeys(prefix: string, probes: Probe[]): string[] {
  const indexed = new Map<number, string>()
  for (const probe of probes) {
    for (const key of Object.keys(probe.endings)) {
      if (!key.startsWith(prefix)) continue
      const n = Number(key.slice(prefix.length))
      if (Number.isInteger(n)) indexed.set(n, key)
    }
  }
  const ordered = [...indexed.entries()].sort((a, b) => a[0] - b[0])

  let lastReal = -1
  ordered.forEach(([, key], i) => {
    const nonZero = probes.some((p) => {
      const v = p.endings[key]
      return typeof v === 'number' && v > 0
    })
    if (nonZero) lastReal = i
  })

  return ordered.slice(0, lastReal + 1).map(([, key]) => key)
}

/**
 * Two scores are "still tied" when they differ by less than a fifth of an order
 * of magnitude. A bare `===` would call 2.0000001 vs 2.0 a clean win and pick a
 * terminal on floating-point noise — the exact failure this guard exists to
 * prevent, dressed up as a decision.
 */
function closeEnough(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.2
}

/** The roles that separate two terminals — one each side, for a pair probe. */
function discriminatingPair(a: Set<string>, b: Set<string>): [string, string] | null {
  const onlyA = [...a].filter((r) => !b.has(r))
  const onlyB = [...b].filter((r) => !a.has(r))
  if (onlyA.length > 0 && onlyB.length > 0) return [onlyA[0], onlyB[0]]
  // One signature contains the other: dropping the extra role is what tells
  // them apart, paired with any role they share.
  const extra = onlyA[0] ?? onlyB[0]
  const shared = [...a].find((r) => b.has(r))
  return extra && shared ? [extra, shared] : null
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
  const neededPairs: Array<[string, string]> = []
  const baseline = probes.find((p) => p.droppedRole === null && !p.droppedRoles)
  if (!baseline) {
    return { map: {}, ok: false, problems: ['no baseline probe (all roles high) supplied'], neededPairs }
  }

  const prefix = kind === 'good' ? 'goodEnding' : 'badEnding'
  const endingKeys = realEndingKeys(prefix, probes)
  const terminals = tree.terminals.filter((t) => t.ending === kind)

  if (endingKeys.length !== terminals.length) {
    problems.push(
      `the API reports ${endingKeys.length} ${kind} endings but the diagram has ` +
      `${terminals.length} — the two disagree about the crime's shape, so no mapping is trustworthy`
    )
    return { map: {}, ok: false, problems, neededPairs }
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
      const observed = observedResponse(key, probes)
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

    // Several endings at this depth — the roles decide. Score each terminal by
    // how well the diagram's PREDICTION of every role's effect matches what the
    // probes actually measured.
    //
    // ⚠️ The prediction is three-valued, and that is the whole improvement.
    // Scoring only rises made an ending nobody raises look like an ending with
    // no evidence, and made two terminals behind one checkpoint indistinguish-
    // able. Predicting rise / fall / flat per role uses the entire sweep.
    // ⚠️ Falls EXCLUDE; they do not predict.
    //
    // The first attempt had the diagram predict a fall for every role the path
    // passes — and measured WORSE (14/31 against a baseline of 18). Every
    // terminal passes nearly every role somewhere on a long path, so the
    // prediction was "everything falls" for every candidate: no discrimination,
    // and it swallowed the fail-role signal that was already working.
    //
    // The sound half of the idea survives as a one-way constraint. If dropping
    // role R makes an ending RARER, that ending cannot be a terminal reached BY
    // R failing. That removes wrong candidates without inventing a prediction
    // the diagram cannot support.
    const contradicted = (t: { id: string }) => {
      const sig = termSigs.get(t.id)!
      for (const r of sig.failRoles) {
        if (sig.ambiguousRoles.has(r)) continue
        if (observed.get(r) === 'fall') return true
      }
      return false
    }
    const plausible = free.filter((t) => !contradicted(t))
    const pool = plausible.length > 0 ? plausible : free

    const scored = pool.map((t) => {
      const sig = termSigs.get(t.id)!.failRoles
      let score = 0
      let matched = 0
      for (const role of sig) {
        const lift = observedLift(key, probes).get(role)
        if (lift === undefined) continue
        matched++
        score += Math.log10(Math.max(lift, 1))
      }
      const missing = [...sig].filter((r) => observed.get(r) !== 'rise').length
      return { t, score, matched, missing }
    }).sort((a, b) => b.score - a.score || a.missing - b.missing)

    if (scored[0].matched === 0) {
      problems.push(`${key}: no role evidence links it to any ending at depth ${depth}`)
      continue
    }
    // Still level after weighting: the two terminals sit behind roles that gate
    // the SAME checkpoint, and no single-role drop can tell them apart. Ask for
    // the pair probe rather than guessing — and ask for it by name, so the
    // caller can fetch exactly the calls needed and re-derive.
    if (scored.length > 1 && closeEnough(scored[0].score, scored[1].score)) {
      const pair = discriminatingPair(termSigs.get(scored[0].t.id)!.failRoles, termSigs.get(scored[1].t.id)!.failRoles)
      if (pair) neededPairs.push(pair)
      problems.push(
        `${key}: ties between ${scored[0].t.id} and ${scored[1].t.id} on role evidence — ` +
        (pair ? `needs a paired-role probe (${pair.join(' + ')})` : 'needs a paired-role probe')
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

  return { map, ok: problems.length === 0, problems, neededPairs }
}
