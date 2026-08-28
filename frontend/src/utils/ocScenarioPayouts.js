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
 * The value of one ending: observed money plus the item drops the mirror
 * reported for its node, priced at current market rates by the server
 * (#441 follow-up — `item_value_avg`, computed in `oc.ts` from the same
 * `GREATEST(market_price, sell_price)` rule #448 uses for the crime-level
 * average).
 *
 * `null` only when BOTH are absent — an ending with real money but no
 * priceable items still has a value, and one with items but no money
 * (Window of Opportunity's good endings) must not read as unpriced just
 * because the money half is legitimately zero.
 */
export function endingValue(e) {
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
    // An unresolved ending has no node, so it can have no payout — and must
    // stay absent rather than becoming 0, so E(x) reports it as missing.
    if (!e?.resolved) continue
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

  const unmapped = good.filter((e) => !e.resolved)
  const priced = good.filter((e) => e.resolved && endingValue(e) !== null)
  const unpriced = good.filter((e) => e.resolved && endingValue(e) === null)
  const thin = priced.filter((e) => (num(e.observations) ?? 0) < THIN_SAMPLE_THRESHOLD)

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
  const good = (endings ?? []).filter((e) => e?.kind === 'good' && e.resolved)
  if (good.length === 0) return false
  const values = good.map((e) => endingValue(e)).filter((v) => v !== null)
  const respect = good.map((e) => num(e.respect_avg)).filter((v) => v !== null)
  if (values.length === 0) return false
  // Every priced ending is worth nothing, yet the crime plainly rewards
  // something — respect is non-zero somewhere.
  return values.every((v) => v === 0) && respect.some((v) => v > 0)
}
