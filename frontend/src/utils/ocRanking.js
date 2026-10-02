import { sortRows } from './tableSort.js'
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
import { buildChainIndex, chainFrom, chainConfident, chainedValue, chainedScope } from './ocChains'
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

/**
 * Build the whole table. `successByName` comes from the ranking endpoint.
 *
 * ## Chains (#585)
 *
 * Pass `chains` — the observed `previous_crime_id` edges — and three things
 * change, all of them corrections to numbers that are actively wrong today:
 *
 *   1. **A chain parent stops reporting $0.** Its `totalPerRun` becomes the
 *      whole chain's expected value, so Manifest Cruelty is finally worth
 *      something rather than ranking below crimes that pay a hundredth as much.
 *
 *   2. **A chain child leaves the table.** Not because it is worthless — Crane
 *      Reaction is the most valuable crime in the game — but because it cannot
 *      be spawned, so offering it as a ranked choice is offering a decision
 *      nobody can make, and counting it separately double-counts the pipeline.
 *
 *   3. ⚠️ **Scope is re-derived over the whole chain**, and this is the part
 *      that bites. Cost is paid once at the root and the reward only lands if
 *      EVERY link succeeds, so the break-even climbs from 83.3% to 91.3% per
 *      link over two and 94.1% over three. At TNL's own rates all three
 *      Elaborate chains are scope-negative — Manifest Cruelty runs at -3.20 a
 *      spawn — while remaining excellent money. `netScope` and `moneyPerScope`
 *      point opposite ways for these crimes, and that is the real finding, not
 *      a rounding artefact.
 *
 * Without `chains` every crime is a one-link chain and the results are
 * identical to the pre-#585 behaviour, so callers that have not been updated
 * keep working unchanged.
 */
export function rankCrimes(scenarios, successByName, opts = {}) {
  const rows = (scenarios ?? []).map((s) => rankCrime(s, successByName?.[s.name], opts))
  if (!opts.chains) return rows

  const index = buildChainIndex(opts.chains)
  const valueByName = {}
  const categoryByName = {}
  for (const r of rows) {
    valueByName[r.name] = r.totalPerRun
    categoryByName[r.name] = r.categoryKey
  }

  // ⚠️ The per-run figures on each row are already weighted by that crime's own
  // success chance, but the chain maths needs the UNWEIGHTED value per link —
  // it applies the reach probability itself. Dividing it back out here keeps
  // the correction in one place instead of changing what rankCrime() means.
  const rawValueByName = {}
  for (const r of rows) {
    const p = r.successChance
    rawValueByName[r.name] = r.totalPerRun === null || !Number.isFinite(p) || p <= 0
      ? r.totalPerRun
      : r.totalPerRun / p
  }

  return rows.map((row) => {
    const links = chainFrom(row.name, index)
    const isChild = index.isChild(row.name)
    const chained = links.length > 1
      ? chainedValue(links, successByName, rawValueByName)
      : null
    const scope = links.length > 1
      ? chainedScope(links, successByName, categoryByName)
      : null

    const total = chained?.expected ?? row.totalPerRun

    return {
      ...row,
      // ⚠️ A chain child stays in the returned rows with `spawnable: false`
      // rather than being filtered out. The Simulator still needs it — a child
      // is a real crime with its own crew and its own success chance, and
      // MonChoon's point stands that putting weaker members on the parent and
      // stronger ones on the payoff link is a real strategy. It is only the
      // RANKING that must not offer it, and the table can drop it on this flag.
      spawnable: !isChild,
      chainLinks: links.length > 1 ? links.map((l) => l.name) : null,
      chainConfident: links.length > 1 ? chainConfident(links) : null,
      chainSource: links.length > 1 ? (links[0].source ?? null) : null,
      chainedSuccess: scope?.chainedSuccess ?? null,
      chainPricingComplete: chained?.complete ?? null,
      totalPerRun: total,
      moneyPerScope: total !== null && scope
        ? (scope.cost > 0 ? total / scope.cost : null)
        : row.moneyPerScope,
      netScope: scope ? scope.net : row.netScope,
      breakEven: scope ? scope.breakEvenPerLink : row.breakEven,
      // Compared against the per-link break-even, not the raw chained
      // probability — see chainedScope. Getting this wrong makes every chain
      // look doomed.
      equivalentSuccess: scope?.equivalentSuccess ?? null,
      sustainable: scope ? scope.sustainable : row.sustainable,
      incomePerWeek: total !== null && row.spawnsPerWeek != null
        ? total * row.spawnsPerWeek
        : row.incomePerWeek,
    }
  })
}

/**
 * Sort, sinking unknowns to the bottom in BOTH directions.
 *
 * The #351 rule. A crime with no data must never top the table by being treated
 * as zero, nor top a descending sort by being treated as infinite.
 */
/**
 * Sort a ranking by one column.
 *
 * ⚠️ **Delegates to the shared comparator (#837).** Kept as a named export
 * with its own tests unchanged, because those tests are the proof that
 * `sortRows` reproduces this table's behaviour — nulls last in both directions
 * and crime name breaking every tie.
 *
 * ⚠️ Kinds are DECLARED rather than sniffed. The old body asked
 * `typeof av === 'string'` per comparison, which switches comparison the moment
 * one row's value is a different type — so a numeric column with one stray
 * string would start comparing everything as text.
 */
/** The ranking table's columns — two text, the rest numeric. */
export const RANKING_COLUMNS = [
  { key: 'name',           kind: 'text' },
  { key: 'categoryLabel',  kind: 'text' },
  { key: 'successChance',  kind: 'number' },
  { key: 'scopeCost',      kind: 'number' },
  { key: 'totalPerRun',    kind: 'number' },
  { key: 'moneyPerScope',  kind: 'number' },
  { key: 'spawnsPerWeek',  kind: 'number' },
  { key: 'incomePerWeek',  kind: 'number' },
]

export function sortRanking(rows, key, direction = 'desc') {
  // ⚠️ This function is key-AGNOSTIC and must stay so. `sortRows` returns rows
  // unchanged for a column it does not know, so narrowing this to the declared
  // set would mean any caller passing another field silently gets no sort. A
  // test caught exactly that, sorting by a key the table does not render.
  const columns = RANKING_COLUMNS.some((c) => c.key === key)
    ? RANKING_COLUMNS
    : [...RANKING_COLUMNS, { key, compare: looseCompare }]
  return sortRows(rows, columns, key, direction, { tieBreak: 'name' })
}

/**
 * The old sniffing comparator, kept ONLY for keys outside the declared set.
 *
 * ⚠️ Deliberately not the default. Sniffing switches comparison the moment one
 * row's value is a different type, which is the inconsistency the shared
 * comparator exists to remove — but a declared kind cannot be invented for a
 * column nobody declared.
 */
function looseCompare(av, bv) {
  if (typeof av === 'string' || typeof bv === 'string') {
    return String(av).localeCompare(String(bv))
  }
  return av - bv
}
