/**
 * Crime chains — the crimes whose real payout is one or two crimes downstream
 * (#585).
 *
 * MonChoon: *"a lvl 8 crime will spawn a lvl 9 crime as a reward, and then the
 * lvl 9 crime will produce a payout. So, the total 'Value' of the lvl 8 crime
 * would show as 0 and the lvl 9 crime would show as the true value, except that
 * those crimes are inherently linked."*
 *
 * Torn's own API has told us this all along — `crimes.previous_crime_id`, in
 * our table since the first scraper and read by nothing until now.
 *
 * ## The three rules that shape everything here
 *
 * 1. **The spawn is deterministic on success.** Verified across the fleet: every
 *    successful parent spawned exactly one child (124/124 Stacking the Deck,
 *    34/34 Lock Stock, 8/8 Manifest Cruelty, 7/7 Gone Fission) and no failed,
 *    expired or planning parent ever spawned one. So a chain is not a
 *    probabilistic bonus to model — it is what the parent *is*.
 *
 * 2. **A chain child cannot be spawned on its own.** Also verified: Ace in the
 *    Hole has 0 standalone runs against 124 spawned, Crane Reaction 0 against 7.
 *    The whole chain's value therefore belongs to the parent, and the child is
 *    removed from the ranking — not because it is worthless, but because it is
 *    not a choice anyone can make.
 *
 * 3. ⚠️ **Scope is paid once at the root and repaid only at the terminal link,
 *    only if every link succeeded.** Confirmed by MonChoon (2026-09-05):
 *    *"The scope cost is only for the initial crime and only the final part of
 *    the chain rewards any scope."*
 *
 * Rule 3 is the one that surprises. The reward stays flat at the category's
 * `scopeReward` while the probability of collecting it COMPOUNDS, so a longer
 * chain is strictly worse on scope than a shorter one paying the same:
 *
 *     E[scope] = -cost + reward x p^links
 *
 * For Elaborate (cost 5, reward 6) that moves the break-even from 83.3% for a
 * standalone crime to **91.3% per link** over two and **94.1% per link** over
 * three. Measured against TNL's real rates the three-link chain completes 30.0%
 * of the time and runs at -3.20 scope a spawn.
 *
 * ⚠️ That is emphatically NOT a verdict that chains are bad — Crane Reaction is
 * still worth ~$1.35B a run, which is a fine return on 5 scope even at 30%.
 * It is the reason `chainedScope` exists at all: the money and the scope have
 * to be read together, because they point opposite ways and no single number
 * can carry both.
 */
import { scopeFor } from './ocScope'

/**
 * Chains we know exist in Torn, as a floor under the observed data.
 *
 * ⚠️ Needed because chain history is per-tenant and no single tenant sees all
 * of it: at the time of writing ascension had observed no chains at all, TNL
 * had four of the five edges, Forge and Mayhem only No Reserve, and capacityx
 * alone had all five. A faction that has never run Manifest Cruelty would
 * otherwise price it at $0 — the exact bug this issue is about — purely because
 * it had not yet made the mistake of running it.
 *
 * This is fixed Torn game mechanics, not faction policy, which is why hardcoding
 * is defensible here and would not be for anything a faction chooses. Observed
 * history still WINS over this table (see `buildChainIndex`) — the game is what
 * it is, and if Torn changes a chain our own data should be what notices.
 */
export const KNOWN_CHAINS = Object.freeze({
  'No Reserve': 'Bidding War',
  'Lock Stock': 'Hostile Takeover',
  'Stacking the Deck': 'Ace in the Hole',
  'Manifest Cruelty': 'Gone Fission',
  'Gone Fission': 'Crane Reaction',
})

/**
 * Below this many observed spawns, an edge is reported as unconfident.
 *
 * Deliberately low, and much lower than `THIN_SAMPLE_THRESHOLD` (30) in
 * ocScenarioPayouts, because these measure different kinds of thing. That one
 * averages a noisy money figure, where 30 samples is barely enough. This one
 * confirms a deterministic game rule, where three consistent observations with
 * zero counter-examples is already strong. A chain seen 3 times and never
 * contradicted is real; a payout averaged over 3 runs is not.
 */
export const MIN_OBSERVATIONS_FOR_CHAIN = 3

/** Guards against a cycle in derived data — see `chainFrom`. */
export const MAX_CHAIN_LENGTH = 8

/**
 * Fold observed edges together with the known table into one lookup.
 *
 * `edges` is `[{ parent, child, observations }]` as derived from our own
 * `previous_crime_id` history. Observation beats the table: if we have watched
 * a crime chain somewhere else, that is the game telling us the table is stale.
 *
 * ⚠️ Only ONE child per parent is kept — the most-observed. Every parent in the
 * real data maps to exactly one child, so a second child name means either a
 * Torn change or corrupt data, and quietly modelling a branching chain would
 * invent a mechanic that does not exist. The runner-up is recorded on the edge
 * as `contested` so it can be surfaced rather than lost.
 */
export function buildChainIndex(edges = []) {
  const byParent = new Map()

  for (const e of edges) {
    const parent = e?.parent
    const child = e?.child
    if (!parent || !child) continue
    const observations = Number(e.observations) || 0
    const prev = byParent.get(parent)
    if (!prev) {
      byParent.set(parent, { parent, child, observations, source: 'observed' })
      continue
    }
    if (child === prev.child) {
      prev.observations += observations
      continue
    }
    // Two different children for one parent. Keep the better-evidenced one and
    // say so, rather than picking silently.
    const loser = observations > prev.observations ? prev : { child, observations }
    const winner = observations > prev.observations
      ? { parent, child, observations, source: 'observed' }
      : prev
    byParent.set(parent, { ...winner, contested: loser.child })
  }

  for (const [parent, child] of Object.entries(KNOWN_CHAINS)) {
    if (byParent.has(parent)) continue
    byParent.set(parent, { parent, child, observations: 0, source: 'known' })
  }

  const childNames = new Set()
  for (const e of byParent.values()) childNames.add(e.child)

  return {
    edge: (name) => byParent.get(name) ?? null,
    /** True for a crime that only ever appears as somebody's reward. */
    isChild: (name) => childNames.has(name),
    edges: [...byParent.values()],
  }
}

/**
 * The full chain starting at `name`, root first, as edge-annotated links.
 *
 * A crime with no child returns a single link, so callers never need to branch
 * on "is this a chain" before doing the arithmetic — a one-link chain IS the
 * standalone case, and every formula below reduces to the standalone one.
 *
 * ⚠️ Cycle-guarded. The edges are derived from scraped data, and a cycle would
 * hang the render rather than show a wrong number, which is the worse failure.
 */
export function chainFrom(name, index) {
  const links = []
  const seen = new Set()
  let current = name

  while (current && !seen.has(current) && links.length < MAX_CHAIN_LENGTH) {
    seen.add(current)
    const edge = index?.edge ? index.edge(current) : null
    links.push({
      name: current,
      child: edge?.child ?? null,
      observations: edge?.observations ?? 0,
      source: edge?.source ?? null,
      contested: edge?.contested ?? null,
    })
    current = edge?.child ?? null
  }

  return links
}

/** Is this chain's every edge backed by enough of our own history to trust? */
export function chainConfident(links) {
  const edges = (links ?? []).filter((l) => l.child)
  if (edges.length === 0) return true
  return edges.every((l) => l.source === 'observed' && l.observations >= MIN_OBSERVATIONS_FOR_CHAIN)
}

/**
 * P(the whole chain completes) — the product of every link's success chance.
 *
 * ⚠️ Null if ANY link's chance is unknown, never a partial product. A product
 * over the links we happen to know is not a lower bound and not an estimate; it
 * is a different quantity that would read as this one. The #351 rule: absent
 * beats confidently wrong.
 */
export function chainedSuccess(links, successByName) {
  if (!links?.length) return null
  let product = 1
  for (const l of links) {
    const p = Number(successByName?.[l.name])
    if (!Number.isFinite(p)) return null
    product *= p
  }
  return product
}

/**
 * Expected value of spawning the ROOT, counting everything the chain pays.
 *
 * Each link contributes its own value weighted by the probability of reaching
 * AND completing it:
 *
 *     E = SUM over links i of  (product of p[0..i]) x value[i]
 *
 * Written in the general form rather than "the terminal link's value times the
 * chained probability" even though every chain we have today pays only at the
 * end. The general form costs nothing, and it is already needed for a chain
 * whose middle link drops an item — a shape Torn could ship tomorrow and which
 * the specific form would silently price at zero.
 *
 * ⚠️ Returns null when a link we would have to walk THROUGH has no success
 * chance, since everything downstream is then unreachable arithmetic.
 *
 * ⚠️ An UNPRICED link and a link that pays NOTHING are different, and the
 * difference is load-bearing. `Number(null)` is 0 and `Number.isFinite(0)` is
 * true, so the obvious coercion silently reports "we have no prices for this
 * crime" as "this crime pays nothing" — the same trap `expectedValue()` guards
 * with `== null` rather than a falsy check. A chain parent paying zero is the
 * normal, known case; a terminal link we simply have not priced makes the whole
 * chain a LOWER BOUND, and `complete: false` is how a caller is told not to
 * present the figure as the real one.
 */
export function chainedValue(links, successByName, valueByName) {
  if (!links?.length) return null
  let reach = 1
  let total = 0
  let complete = true

  for (const l of links) {
    const p = Number(successByName?.[l.name])
    if (!Number.isFinite(p)) return null
    reach *= p
    const raw = valueByName?.[l.name]
    if (raw == null) { complete = false; continue }
    const v = Number(raw)
    if (Number.isFinite(v)) total += reach * v
    else complete = false
  }

  return { expected: total, complete }
}

/**
 * The success chance, per link, at which a chain exactly repays its scope.
 *
 *     cost = reward x p^links   =>   p = (cost/reward)^(1/links)
 *
 * The single number that answers "is this chain worth spawning for us". For
 * Elaborate: 83.3% standalone, 91.3% over two links, 94.1% over three.
 */
export function chainBreakEven(cost, reward, links) {
  if (!Number.isFinite(cost) || !Number.isFinite(reward) || reward <= 0) return null
  if (!Number.isFinite(links) || links < 1) return null
  return Math.pow(cost / reward, 1 / links)
}

/**
 * The scope economics of spawning a whole chain.
 *
 * ⚠️ Cost comes from the ROOT's category and reward from the TERMINAL's, which
 * is not the same category in general — and taking both from one end would be
 * wrong in opposite directions depending on which end you picked.
 *
 * `equivalentSuccess` is the geometric mean per link, the figure to compare
 * against `breakEvenPerLink`. Comparing the raw chained probability against a
 * per-link break-even is the natural mistake and it makes every chain look
 * doomed.
 */
export function chainedScope(links, successByName, categoryByName) {
  if (!links?.length) return null
  const root = scopeFor(categoryByName?.[links[0].name])
  const terminal = scopeFor(categoryByName?.[links[links.length - 1].name])
  if (!root || !terminal) return null

  const p = chainedSuccess(links, successByName)
  const breakEvenPerLink = chainBreakEven(root.cost, terminal.reward, links.length)

  return {
    links: links.length,
    cost: root.cost,
    reward: terminal.reward,
    chainedSuccess: p,
    breakEvenPerLink,
    equivalentSuccess: p === null ? null : Math.pow(p, 1 / links.length),
    net: p === null ? null : p * terminal.reward - root.cost,
    sustainable: p === null ? null : p * terminal.reward - root.cost > 0,
  }
}
