/**
 * Ranking crimes by what they are actually worth per week (#444, #448).
 *
 * MonChoon: *"combine the average $ return, the scope gain and loss, with the
 * spawning averages, to ensure we were using the most optimal CPRs for our
 * minimums."*
 *
 * Three corrections to the naive "rank by E(x)" that this module encodes:
 *
 *   1. **Scope is the scarce input.** A crime paying twice as much that costs
 *      two and a half times the scope is the worse buy. Rank on money per
 *      scope, not money per run.
 *
 *   2. **Below its break-even success a crime is unspawnable long-term**,
 *      whatever it pays, because scope only comes back on success.
 *
 *   3. **Cash is not the whole reward.** Several crimes pay entirely in items
 *      (#448). Ranking them on cash alone puts them last on a number measuring
 *      half of what they earn.
 */
import { pricingQuality, paysInItems } from './ocScenarioPayouts'
import { scopeFor, breakEvenSuccess, netScope, moneyPerScope } from './ocScope'
import { makeCategoryResolver } from './ocPlanner'
import { config } from '../config'

const WEEK_SECONDS = 7 * 86400

/** Below this many observed runs, a spawn rate is not a rate. */
export const MIN_RUNS_FOR_RATE = 5

/**
 * Observed spawns per week for a crime, from our own history.
 *
 * ⚠️ `confident` is false when the history is too thin. A crime we have run
 * twice has no meaningful weekly rate, and treating one as fact would let it
 * outrank a crime we actually run — on noise.
 *
 * ⚠️ It also measures past DECISIONS as much as capacity. A crime avoided
 * because someone judged it not worth it measures as rare, and ranking on that
 * keeps it rare. That is a limit of the data, not of the arithmetic, and the
 * UI has to say so rather than the number pretending otherwise.
 */
export function spawnsPerWeek(history, now = Math.floor(Date.now() / 1000)) {
  const runs = history?.runs ?? 0
  const first = history?.first_at ?? null
  if (runs === 0 || first === null) return null

  const span = Math.max(WEEK_SECONDS, now - first)
  return {
    rate: (runs / span) * WEEK_SECONDS,
    runs,
    confident: runs >= MIN_RUNS_FOR_RATE,
    spanWeeks: span / WEEK_SECONDS,
  }
}

/** The crime's difficulty category, via the Planner's name-authoritative rule. */
export function categoryOf(scenario, resolver) {
  const resolve = resolver ?? makeCategoryResolver({
    scenarios: config.ocScenarios || {},
    categories: config.ocCategories || {},
  })
  return resolve(scenario?.name, scenario?.difficulty ?? null)
}

/**
 * Everything the ranking table needs for one crime, at a stated success chance.
 *
 * Every uncertain figure is null rather than zero, so the table can sink them
 * to the bottom in both sort directions (the #351 rule) instead of ranking a
 * crime we know nothing about as worthless.
 */
export function rankCrime(scenario, successChance, { resolver, now } = {}) {
  const categoryKey = categoryOf(scenario, resolver)
  const scope = scopeFor(categoryKey)

  const endings = scenario?.endings ?? []
  const quality = pricingQuality(endings)
  const hasSuccess = Number.isFinite(successChance)

  // ⚠️ The cash figure here is an APPROXIMATION, and the UI says so. Exact E(x)
  // needs the full per-ending probability vector, which the ranking does not
  // have — it has one success chance per crime. So this weights the mean priced
  // ending by success. The per-crime simulator card, which does have the full
  // vector, remains the precise answer; this is for putting crimes in order.
  const pricedValues = endings
    .filter((e) => e.kind === 'good' && e.resolved && Number.isFinite(Number(e.money_avg)))
    .map((e) => Number(e.money_avg))
  const meanEnding = pricedValues.length > 0
    ? pricedValues.reduce((a, b) => a + b, 0) / pricedValues.length
    : null
  const cashPerRun = hasSuccess && meanEnding !== null ? successChance * meanEnding : null

  // Item side (#448) — a per-crime figure from our own runs, never per-ending.
  const itemAvg = scenario?.item_reward ? Number(scenario.item_reward.avg_value) : null
  const itemPerRun = itemAvg !== null && Number.isFinite(itemAvg)
    ? itemAvg * (hasSuccess ? successChance : 1)
    : null

  const totalPerRun = cashPerRun === null && itemPerRun === null
    ? null
    : (cashPerRun ?? 0) + (itemPerRun ?? 0)

  const spawn = spawnsPerWeek(scenario?.spawn_history, now)
  const breakEven = breakEvenSuccess(categoryKey)

  return {
    name: scenario?.name,
    categoryKey,
    categoryLabel: scope?.label ?? null,
    scopeCost: scope?.cost ?? null,
    successChance: hasSuccess ? successChance : null,
    breakEven,
    // ⚠️ The verdict that outranks money: below this line the crime cannot be
    // sustained, however much it pays.
    sustainable: hasSuccess && breakEven !== null ? successChance > breakEven : null,
    netScope: hasSuccess ? netScope(categoryKey, successChance) : null,
    cashPerRun,
    itemPerRun,
    totalPerRun,
    moneyPerScope: totalPerRun !== null ? moneyPerScope(categoryKey, totalPerRun) : null,
    spawnsPerWeek: spawn?.rate ?? null,
    spawnConfident: spawn?.confident ?? false,
    spawnRuns: spawn?.runs ?? 0,
    incomePerWeek: totalPerRun !== null && spawn?.rate != null ? totalPerRun * spawn.rate : null,
    paysInItems: paysInItems(endings),
    pricingComplete: quality?.complete ?? false,
    unpricedEndings: quality ? quality.unmapped.length + quality.unpriced.length : null,
    itemRuns: scenario?.item_reward?.runs ?? 0,
    // ⚠️ Item drops with neither a market nor a sell price contribute zero, so
    // a crime with these is UNDER-valued. Distinct from unpriced endings, which
    // are a mapping problem rather than a catalogue one.
    unpricedItemRows: scenario?.item_reward?.unpriced_rows ?? 0,
  }
}

/** Build the whole table. `successByName` comes from the ranking endpoint. */
export function rankCrimes(scenarios, successByName, opts = {}) {
  return (scenarios ?? []).map((s) => rankCrime(s, successByName?.[s.name], opts))
}

/**
 * Sort, sinking unknowns to the bottom in BOTH directions.
 *
 * The #351 rule. A crime with no data must never top the table by being treated
 * as zero, nor top a descending sort by being treated as infinite.
 */
export function sortRanking(rows, key, direction = 'desc') {
  const dir = direction === 'asc' ? 1 : -1
  return [...(rows ?? [])].sort((a, b) => {
    const av = a?.[key]
    const bv = b?.[key]
    const aNull = av === null || av === undefined
    const bNull = bv === null || bv === undefined
    if (aNull && bNull) return String(a?.name ?? '').localeCompare(String(b?.name ?? ''))
    if (aNull) return 1
    if (bNull) return -1
    if (typeof av === 'string' || typeof bv === 'string') {
      return dir * String(av).localeCompare(String(bv))
    }
    return dir * (av - bv)
  })
}
