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
