/**
 * Payouts per ending, from the mirrored probability feed (#440).
 *
 * Replaces the hand-entered `ocEndingPayouts.json` for any scenario the mirror
 * has priced. The feed carries observed money and respect per diagram NODE, and
 * `oc_scenario_endings` carries the ending→node mapping derived in #390, so the
 * join is what turns 167 cells of manual data entry into a nightly job.
 *
 * ⚠️ Every function here keeps unpriced and zero distinguishable. `null` means
 * "we have no observation"; `0` means "observed to pay nothing", which is a
 * real and different statement — bad endings genuinely pay zero.
 */

/** Number, or null. Never 0 for an absent value (the Number(null) trap). */
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

/**
 * Below this many observations, an average is a rumour rather than a figure.
 *
 * The real feed ranges from n=1 to n=6,419 on the same crime. A single observed
 * run produces an "average" that renders identically to one from six thousand,
 * so the UI has to be able to tell them apart. The number is not used to
 * DISCARD anything — a thin figure is still the best we have — only to mark it.
 */
export const THIN_SAMPLE_THRESHOLD = 30

/**
 * The response's ending probabilities, minus the service's zero padding (#606).
 *
 * ⚠️ tornprobability answers with a FIXED number of ending slots and pads the
 * unused tail with exact zeros. Window of Opportunity has six good endings and
 * no bad ones; the service returns `goodEnding1..10` AND `badEnding1..10`, so
 * fourteen of those twenty keys describe endings the crime does not have. The
 * Simulator listed all twenty, which put four rows reading "unpriced" and ten
 * reading "$0" under a crime whose pricing is in fact complete — and pushed the
 * four into `expectedValue`'s `missing`, so the panel reported a lower bound
 * where it had the real answer.
 *
 * The server already trims this when BUILDING the model (`realEndingKeys` in
 * `oc/endingMap.ts`, which drops a trailing run of zeros). It cannot trim the
 * live `/calculate` response, because that is passed through verbatim on
 * purpose — so the trim has to happen again here, against a different fact.
 *
 * ⚠️ The test is "unknown to the model AND exactly zero", never either alone:
 *
 *   - Zero alone would hide a real ending that is simply unreachable at these
 *     CPRs. Those exist, they are in the model, and a crew that makes one
 *     reachable must see it appear rather than blink into existence.
 *   - Unknown alone would hide a genuine disagreement between the service and
 *     the model. If the service puts real probability on a key we have never
 *     heard of, that is exactly the thing a reader needs to be told about, and
 *     it stays on screen as an unpriced ending.
 *
 * Keys that are not ending keys at all (`successChance`, and whatever the
 * service adds next) are dropped here too, so callers stop repeating the
 * prefix test.
 */
export function withoutEndingPadding(probabilities, endings) {
  const known = new Set((endings ?? []).map((e) => e?.ending_key))
  const out = {}
  for (const [key, p] of Object.entries(probabilities ?? {})) {
    if (!key.startsWith('goodEnding') && !key.startsWith('badEnding')) continue
    if (!known.has(key) && !(Number(p) > 0)) continue
    out[key] = p
  }
  return out
}

/**
 * What one ending is worth, broken into the parts a reader can act on (#606).
 *
 * ⚠️ Cash and items are never both present. Measured across all 31 scenarios:
 * 21 crimes pay purely in cash, 8 purely in items, and NOT ONE pays both. So
 * "cash + item value" is never actually a sum — it is one or the other, and
 * the UI's job is to say which and how confident the figure is, not to add.
 *
 * The two carry different kinds of uncertainty, which is why they are reported
 * separately rather than flattened into one ± :
 *
 *   cash   — an observed min/avg/max over `observations` runs of this node.
 *   items  — an EXPECTED value: Σ dropRate × qty × price. Its floor counts only
 *            drops seen on every run; its ceiling is every drop landing at
 *            once. Neither bound is a game guarantee, and `observations` is
 *            what says how much either is worth.
 *
 * Returns null for an ending with nothing to break down, so callers keep
 * rendering the plain total.
 */
export function endingValueBreakdown(e) {
  if (!e) return null
  const money = num(e.money_avg)
  const items = num(e.item_value_avg)
  const kind = items !== null && items > 0 ? 'items' : money !== null && money > 0 ? 'cash' : null
  if (kind === null) return null

  if (kind === 'cash') {
    const lo = num(e.money_min)
    const hi = num(e.money_max)
    return {
      kind, total: money,
      // ⚠️ Only a range when the two ends actually differ. A node observed once
      // reports min = avg = max, and printing "$5M – $5M" would dress a single
      // observation up as a measured spread.
      range: lo !== null && hi !== null && hi > lo ? { lo, hi } : null,
      drops: [], unmatched: e.item_value_unmatched ?? [],
      observations: num(e.observations),
    }
  }

  const lo = num(e.item_value_min)
  const hi = num(e.item_value_max)
  return {
    kind, total: items,
    range: lo !== null && hi !== null && hi > lo ? { lo, hi } : null,
    drops: Array.isArray(e.item_drops) ? e.item_drops : [],
    unmatched: e.item_value_unmatched ?? [],
    observations: num(e.observations),
  }
}

/**
 * Fold each alias row into the ending it shares a terminal with (#606).
 *
 * ⚠️ The probability MOVES, it is not discarded. These are one outcome the
 * service reports under several labels, so the row that survives has to carry
 * their combined chance — Blast from the Past's goodEnding3 happens 17.778% of
 * the time, not the 10.526% its own label reports, and Crimes Hub's simulator
 * agrees to the third decimal. Simply hiding the alias rows would leave that
 * ending understated by 7 points and the column no longer summing to 100%.
 *
 * Presentation only. E(x), the payout spread and expected respect are all
 * unchanged: an alias prices from the same node as its target, so summing the
 * probabilities of rows that share a payout gives the identical total.
 *
 * Returns the collapsed probabilities plus `mergedLabels`, target key → every
 * label the service used for it, so the surviving row can say so on hover
 * without putting the noise back on screen.
 */
export function collapseAliasedEndings(probabilities, endings) {
  const aliasOf = new Map()
  for (const e of endings ?? []) {
    if (e?.alias_of && e.ending_key) aliasOf.set(e.ending_key, e.alias_of)
  }
  if (aliasOf.size === 0) return { probabilities: { ...(probabilities ?? {}) }, mergedLabels: new Map() }

  const out = {}
  const mergedLabels = new Map()
  for (const [key, p] of Object.entries(probabilities ?? {})) {
    // ⚠️ Resolve through a chain rather than one hop. The build refuses to
    // record an alias whose target is itself an alias, but a bounded walk here
    // costs nothing and means a bad model file cannot lose probability mass
    // into a row that was itself folded away.
    let target = key
    for (let i = 0; i < 8 && aliasOf.has(target); i++) target = aliasOf.get(target)
    const value = Number(p)
    out[target] = (out[target] ?? 0) + (Number.isFinite(value) ? value : 0)
    if (target !== key) {
      if (!mergedLabels.has(target)) mergedLabels.set(target, [target])
      mergedLabels.get(target).push(key)
    }
  }
  return { probabilities: out, mergedLabels }
}

/**
 * Whether an ending has anything to price at all — resolved to a real
 * diagram node, OR confirmed starved (#473: the API reports it, the diagram
 * draws no terminal for it, so it can never get real stats — soft-priced at
 * $0 rather than left an open question forever).
 */
export function isPriceable(e) {
  return !!(e?.resolved || e?.starved)
}

/**
 * The value of one ending: observed money plus the item drops the mirror
 * reported for its node, priced at current market rates by the server
 * (#441 follow-up — `item_value_avg`, computed in `oc.ts` from the same
 * `GREATEST(market_price, sell_price)` rule #448 uses for the crime-level
 * average).
 *
 * A starved ending (#473) is 0 by definition — there is no node for it to
 * ever carry money or items — not merely "no data yet" like a genuinely
 * unresolved ending.
 *
 * Otherwise `null` only when BOTH money and items are absent — an ending
 * with real money but no priceable items still has a value, and one with
 * items but no money (Window of Opportunity's good endings) must not read
 * as unpriced just because the money half is legitimately zero.
 */
export function endingValue(e) {
  if (e?.starved) return 0
  const money = num(e?.money_avg)
  const items = num(e?.item_value_avg)
  if (money === null && items === null) return null
  return (money ?? 0) + (items ?? 0)
}

/**
 * Ending key → payout, in the shape `expectedValue()` already expects.
 *
 * Bad endings are forced to 0 rather than read from the feed. They pay nothing
 * by the game's rules (confirmed by MonChoon, and by the feed itself reporting
 * money 0 for every F node), and treating them as unpriced would make every
 * crime report a lower bound forever.
 */
export function payoutsFromEndings(endings) {
  const out = {}
  for (const e of endings ?? []) {
    if (e?.kind === 'bad') { out[e.ending_key] = 0; continue }
    // An unresolved, non-starved ending has no node, so it can have no
    // payout — and must stay absent rather than becoming 0, so E(x) reports
    // it as missing. A starved ending (#473) is priceable by definition —
    // isPriceable() lets it through, endingValue() prices it at 0.
    if (!isPriceable(e)) continue
    const value = endingValue(e)
    if (value === null) continue
    out[e.ending_key] = value
  }
  return out
}

/** The same, for respect — the second half of "gain and loss" per ending. */
export function respectFromEndings(endings) {
  const out = {}
  for (const e of endings ?? []) {
    if (e?.kind === 'bad') { out[e.ending_key] = 0; continue }
    if (!e?.resolved) continue
    const avg = num(e.respect_avg)
    if (avg === null) continue
    out[e.ending_key] = avg
  }
  return out
}

/**
 * How trustworthy this scenario's pricing is, in terms a reader can act on.
 *
 * Reports the three separate ways a crime can be under-priced, because they
 * have different fixes:
 *
 *   unmapped   — #390 could not resolve the ending to a node. Needs a better
 *                probe, not more observations.
 *   unpriced   — mapped, but the feed has neither money nor priceable items
 *                for that node.
 *   thin       — priced from very few observations.
 */
export function pricingQuality(endings) {
  const good = (endings ?? []).filter((e) => e?.kind === 'good')
  if (good.length === 0) return null

  // A starved ending (#473) is neither "unmapped" (that means it needs a
  // better probe, and this one never will resolve — there is no node) nor
  // "unpriced" (its $0 is confirmed, not missing) — it's priced.
  const unmapped = good.filter((e) => !e.resolved && !e.starved)
  const priced = good.filter((e) => isPriceable(e) && endingValue(e) !== null)
  const unpriced = good.filter((e) => isPriceable(e) && endingValue(e) === null)
  // A starved ending (#473) isn't "priced from few observations" — it has no
  // observation concept at all, its $0 is priced by definition. Excluded here
  // so it doesn't pick up a redundant thin-sample flag alongside its own tag.
  const thin = priced.filter((e) => !e.starved && (num(e.observations) ?? 0) < THIN_SAMPLE_THRESHOLD)

  const observations = priced.reduce((s, e) => s + (num(e.observations) ?? 0), 0)
  return {
    total: good.length,
    priced: priced.length,
    unmapped: unmapped.map((e) => e.ending_key),
    unpriced: unpriced.map((e) => e.ending_key),
    thin: thin.map((e) => e.ending_key),
    observations,
    complete: unmapped.length === 0 && unpriced.length === 0,
  }
}

/**
 * The payout spread across a crime's good endings.
 *
 * The gap between the best and worst outcome is what makes a "router" role —
 * one that barely changes success but decides which ending you land in — worth
 * caring about. On Break the Bank that gap is ~$159M, which is the entire
 * argument for #441.
 */
export function payoutSpread(endings) {
  // Starved endings (#473) are excluded here specifically: this is the gap
  // a ROUTER ROLE decides between, i.e. real diagram terminals — a starved
  // ending is a data-completeness placeholder, not a designed outcome, and
  // including its synthetic $0 would inflate the spread on a crime that
  // simply happens to have one.
  const values = (endings ?? [])
    .filter((e) => e?.kind === 'good' && e.resolved)
    .map((e) => endingValue(e))
    .filter((v) => v !== null)
  if (values.length === 0) return null
  const best = Math.max(...values)
  const worst = Math.min(...values)
  return { best, worst, gap: best - worst }
}

/**
 * Whether a crime's endings are priced at zero across the board despite
 * plainly rewarding something.
 *
 * ⚠️ Found in the live mirror: several crimes — Best of the Lot, Crane
 * Reaction, Gaslight the Way, Stage Fright among them — report money 0 for
 * EVERY good ending while still carrying respect. Most such crimes turned out
 * to reward items instead (#441 follow-up folded the mirror's item drops into
 * `endingValue()`, so those are priced now) — this flags what's LEFT: a crime
 * that still has no priceable value at all despite non-zero respect, either
 * because its items aren't in our catalogue or the feed never reported them.
 *
 * This matters because "$0" and "pays nothing" are not the same statement, and
 * a ranking by income (#444) would put these last on a number that is only
 * measuring the half of the reward we can see. Distinguishing them is the
 * difference between an honest gap in the data and a wrong answer.
 */
export function paysInItems(endings) {
  const good = (endings ?? []).filter((e) => e?.kind === 'good' && isPriceable(e))
  if (good.length === 0) return false
  const values = good.map((e) => endingValue(e)).filter((v) => v !== null)
  const respect = good.map((e) => num(e.respect_avg)).filter((v) => v !== null)
  if (values.length === 0) return false
  // Every priced ending is worth nothing, yet the crime plainly rewards
  // something — respect is non-zero somewhere.
  return values.every((v) => v === 0) && respect.some((v) => v > 0)
}
