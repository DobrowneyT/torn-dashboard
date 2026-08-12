/**
 * Expected value for an OC scenario (#390).
 *
 * tornprobability.com gives us P(ending) — every good and bad ending, keyed
 * `goodEnding1..N` / `badEnding1..N`, summing to exactly 1. It does NOT give
 * the money each ending pays, and neither does Torn: our `crimes` table records
 * `rewards_money` with nothing identifying which ending produced it.
 *
 * So the payouts are hand-entered (`data/ocEndingPayouts.json`) and will be
 * incomplete for a long time — 167 good endings across 31 scenarios. Everything
 * here is built around that: partial data has to be USEFUL and has to be
 * HONEST about being partial.
 */
import payoutTable from '../data/ocEndingPayouts.json'

/**
 * Bad endings pay nothing.
 *
 * Confirmed by MonChoon (2026-08-12): "failed crimes never payout anything,
 * that's for sure." So this is a game rule, not a guess — which is why the 202
 * bad endings need no hand-entry and only the 167 good ones do.
 *
 * Still a named constant rather than arithmetic buried in the loop: it is the
 * one place a rule change would land, and keeping it visible means the next
 * reader can see that "bad endings contribute zero" is a decision with a source
 * rather than an oversight.
 */
export const BAD_ENDINGS_PAY_ZERO = true

/** The hand-entered payouts for a scenario, or null if we have no entry. */
export function payoutsFor(scenario) {
  return payoutTable[scenario]?.payouts ?? null
}

/**
 * Expected value over the endings we can price.
 *
 * Returns `{ expected, pricedProbability, missing, complete }`.
 *
 *   expected           Σ P(ending) × payout(ending), over PRICED endings only
 *   pricedProbability  how much of the probability mass that covers (0..1)
 *   missing            ending keys with a probability but no payout
 *   complete           nothing missing — `expected` is the real E(x)
 *
 * When `complete` is false, `expected` is a LOWER BOUND, not an estimate: the
 * unpriced endings contribute an unknown non-negative amount. Callers must
 * present it as such. Reporting a partial sum as "the" expected value would
 * understate every crime whose best ending happens to be unpriced, and an OC
 * manager would schedule around it — the same failure as #376, where a
 * confidently wrong number was worse than an honestly absent one.
 */
export function expectedValue(scenario, endingProbabilities, payouts = payoutsFor(scenario)) {
  const probs = endingProbabilities ?? {}
  const table = payouts ?? {}

  let expected = 0
  let pricedProbability = 0
  const missing = []

  for (const [key, p] of Object.entries(probs)) {
    if (typeof p !== 'number' || !Number.isFinite(p)) continue
    if (key.startsWith('badEnding') && BAD_ENDINGS_PAY_ZERO && table[key] == null) {
      // Pays nothing by the game's rules, so it counts as fully covered mass
      // while contributing zero — no hand-entry needed for any of them.
      pricedProbability += p
      continue
    }
    const payout = table[key]
    // `== null` and not falsy: a genuine 0 is a price, and treating it as
    // missing would report an ending we HAVE measured as unknown. This is the
    // Number(null) === 0 trap from the other direction.
    if (payout == null) { missing.push(key); continue }
    expected += p * payout
    pricedProbability += p
  }

  return {
    expected,
    pricedProbability,
    missing,
    complete: missing.length === 0,
  }
}

/**
 * How much of the hand-entry job is done, for the fill-in-as-you-go workflow.
 *
 * Ordering by what the faction actually runs is the useful prioritisation, but
 * that lives in our crimes table, not here — callers with roster data can sort
 * on it.
 */
export function coverage(table = payoutTable) {
  const scenarios = Object.entries(table).map(([name, entry]) => {
    const values = Object.values(entry.payouts ?? {})
    const priced = values.filter(v => v != null).length
    return { scenario: name, priced, total: values.length, complete: values.length > 0 && priced === values.length }
  })
  return {
    scenarios: scenarios.sort((a, b) => a.scenario.localeCompare(b.scenario)),
    priced: scenarios.reduce((a, s) => a + s.priced, 0),
    total: scenarios.reduce((a, s) => a + s.total, 0),
  }
}
