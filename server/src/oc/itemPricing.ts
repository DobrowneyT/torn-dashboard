/**
 * Dollar value of a node's observed item drops, at CURRENT market prices
 * (#441 follow-up).
 *
 * The mirror reports how often each item appeared across its observations of
 * this node (`occurrences`) and the average quantity when it did (`qty.avg`)
 * — NOT a guarantee every run drops it. Expected value per item is therefore
 * `(occurrences / n) * qty.avg * price`, the same expected-value logic
 * `expectedValue()` already applies across endings, one level down to the
 * items inside one of them.
 *
 * ⚠️ GREATEST(market_price, sell_price) — matching #448's existing convention
 * (oc.ts) for the crime-level item average. Illiquid items carry
 * market_price = 0 because they rarely trade, while sell_price is always
 * defined. Pricing on market alone would value exactly the rare, expensive
 * drops at zero, which is the opposite of the error worth risking.
 *
 * ⚠️ CURRENT price, deliberately: this computes at read time against whatever
 * the `items` table holds right now, not a value frozen when the mirror last
 * ran. Re-fetching the scenarios page picks up market movement, same as #448.
 */

export interface ItemDropInput {
  name: string
  occurrences: number
  qty: { avg: number }
}

export interface ItemCatalogEntry {
  marketPrice: number | null
  sellPrice: number | null
}

export interface NodeItemValue {
  /** Expected item value per run of this node, at current prices. */
  value: number
  /** Item names observed dropping that the catalogue could not price. */
  unmatched: string[]
}

/** Case/whitespace-insensitive key so "Priceless Painting" and " priceless painting " agree. */
export function normaliseItemName(name: string): string {
  return name.trim().toLowerCase()
}

export function buildItemCatalog(
  rows: Array<{ name: string; market_price: number | string | null; sell_price: number | string | null }>
): Map<string, ItemCatalogEntry> {
  const catalog = new Map<string, ItemCatalogEntry>()
  for (const row of rows) {
    catalog.set(normaliseItemName(row.name), {
      marketPrice: row.market_price == null ? null : Number(row.market_price),
      sellPrice: row.sell_price == null ? null : Number(row.sell_price),
    })
  }
  return catalog
}

/**
 * `null` when the node has no item drops at all — distinct from a value of 0,
 * which means it has drops but none of them priced (all `unmatched`).
 */
export function priceNodeItems(
  items: ItemDropInput[] | null | undefined,
  n: number,
  catalog: Map<string, ItemCatalogEntry>
): NodeItemValue | null {
  if (!items || items.length === 0) return null
  if (!Number.isFinite(n) || n <= 0) return null

  let value = 0
  const unmatched: string[] = []
  for (const item of items) {
    if (!item?.name || !Number.isFinite(item.occurrences) || !Number.isFinite(item.qty?.avg)) continue
    const entry = catalog.get(normaliseItemName(item.name))
    const price = entry ? Math.max(entry.marketPrice ?? 0, entry.sellPrice ?? 0) : 0
    // An item present in the catalogue but genuinely worth 0 (neither price
    // set) is indistinguishable from an absent one here, and both mean the
    // same thing to a caller: we cannot put a number on this drop.
    if (price <= 0) { unmatched.push(item.name); continue }
    value += (item.occurrences / n) * item.qty.avg * price
  }
  return { value, unmatched }
}


/**
 * How old the item catalogue may be before its prices stop being used at all
 * (#609 slice 7).
 *
 * ⚠️ **Deliberately far longer than `ITEMS_STALE_AFTER_MS` (6h) in globalDb.ts,
 * because the two answer different questions.** Six hours is how fresh the
 * FLEET copy must be for a tenant to adopt it instead of spending a Torn call;
 * past that the tenant simply syncs from its own key pool and prices carry on
 * normally. This threshold is the last line: it only bites when BOTH sources
 * have been failing — the control plane's single key and the faction's whole
 * pool — which is the July #123/#124 scenario, and is exactly the state that
 * went unnoticed for months.
 *
 * A week is chosen so that no ordinary outage reaches it. Item prices move, but
 * a three-day-old price is a usable estimate and a seven-day-old one, produced
 * while everything that should refresh it is dead, is a number nobody should be
 * making payout decisions on.
 */
export const ITEM_PRICES_UNUSABLE_AFTER_MS = 7 * 24 * 60 * 60 * 1000

export interface CatalogFreshness {
  fresh: boolean
  /** When the catalogue was last refreshed, or null if it has never been. */
  asOf: string | null
  ageHours: number | null
  /** Present only when `fresh` is false — why prices are being withheld. */
  reason?: string
}

/**
 * ⚠️ **Refusing is the point, and the refusal has to be legible.**
 *
 * #609 requires that stale prices are "refused with a reason, never silently
 * used", and the house rule this follows is already established here:
 * `item_value_unmatched` (#441), unpriced endings as a lower bound (#473),
 * null-not-zero (#351). Absent beats confidently wrong.
 *
 * ⚠️ A null `asOf` is NOT treated as infinitely stale. A faction that has never
 * run items-sync has no prices to withhold, and reporting "prices are too old"
 * for a table that was never populated would send an operator looking for a
 * sync failure that never happened. It is reported as unusable with its own
 * reason instead.
 */
export function catalogFreshness(
  asOf: string | Date | null | undefined,
  now: number = Date.now()
): CatalogFreshness {
  if (!asOf) {
    return { fresh: false, asOf: null, ageHours: null, reason: 'The item catalogue has never been synced.' }
  }
  const at = asOf instanceof Date ? asOf.getTime() : Date.parse(String(asOf))
  if (!Number.isFinite(at)) {
    return { fresh: false, asOf: null, ageHours: null, reason: 'The item catalogue timestamp is unreadable.' }
  }
  const ageMs = now - at
  const ageHours = ageMs / 3_600_000
  const iso = new Date(at).toISOString()
  if (ageMs < ITEM_PRICES_UNUSABLE_AFTER_MS) return { fresh: true, asOf: iso, ageHours }
  return {
    fresh: false,
    asOf: iso,
    ageHours,
    reason:
      `Item prices are ${Math.round(ageHours / 24)} days old. Both the fleet catalogue and this ` +
      `faction's key pool have failed to refresh them, so they are being withheld rather than used.`,
  }
}

/** The catalogue to use when prices are being withheld: empty, so every item
 *  reports as unmatched through the path #441 already built. */
export const EMPTY_CATALOG: Map<string, ItemCatalogEntry> = new Map()
