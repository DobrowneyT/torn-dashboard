// #441 follow-up — pricing an OC ending's observed item drops at current
// market rates, the same GREATEST(market_price, sell_price) rule #448 uses
// for the crime-level average (server/src/oc.ts).
import { describe, expect, it } from 'vitest'
import { buildItemCatalog, normaliseItemName, priceNodeItems } from '../src/oc/itemPricing.js'

describe('normaliseItemName', () => {
  it('trims and lowercases, so sources spelled differently still agree', () => {
    expect(normaliseItemName('  Priceless Painting  ')).toBe('priceless painting')
  })
})

describe('buildItemCatalog', () => {
  it('indexes by normalised name', () => {
    const catalog = buildItemCatalog([{ name: 'Fancy Car', market_price: 100, sell_price: 50 }])
    expect(catalog.get('fancy car')).toEqual({ marketPrice: 100, sellPrice: 50 })
  })

  it('keeps null apart from 0 for a price the catalogue never set', () => {
    const catalog = buildItemCatalog([{ name: 'Mystery Thing', market_price: null, sell_price: null }])
    expect(catalog.get('mystery thing')).toEqual({ marketPrice: null, sellPrice: null })
  })
})

describe('priceNodeItems', () => {
  const catalog = buildItemCatalog([
    { name: 'Priceless Painting', market_price: 0, sell_price: 70_000_000 },
    { name: 'Shabti Sculpture', market_price: 500_000, sell_price: 400_000 },
    { name: 'Mystery Thing', market_price: 0, sell_price: 0 },
  ])

  it('returns null — not zero — when the node has no items at all', () => {
    // Distinct from "has items, all unpriced": a node with no drops has
    // nothing to add, one with unpriceable drops has a value we cannot see.
    expect(priceNodeItems([], 100, catalog)).toBeNull()
    expect(priceNodeItems(null, 100, catalog)).toBeNull()
    expect(priceNodeItems(undefined, 100, catalog)).toBeNull()
  })

  it('weights by observed occurrence rate, not a flat guarantee', () => {
    // Real fragment from Window of Opportunity's _A8S_ node: Priceless
    // Painting drops on every one of 3718 runs (qty 1), Shabti Sculpture on
    // 1547 of them (qty 2) — not every run, and not the same rate.
    const result = priceNodeItems(
      [
        { name: 'Priceless Painting', occurrences: 3718, qty: { avg: 1 } },
        { name: 'Shabti Sculpture', occurrences: 1547, qty: { avg: 2 } },
      ],
      3718,
      catalog
    )
    // Painting: 3718/3718 * 1 * 70,000,000 = 70,000,000
    // Shabti:   1547/3718 * 2 * 500,000    ≈ 416,072.08...
    expect(result?.value).toBeCloseTo(70_000_000 + (1547 / 3718) * 2 * 500_000, 2)
    expect(result?.unmatched).toEqual([])
  })

  it('⚠️ prices an illiquid item on sell_price when market_price is 0', () => {
    // Same convention as #448 (oc.ts): a Priceless Painting rarely trades, so
    // market_price is 0 while sell_price holds its real worth.
    const result = priceNodeItems(
      [{ name: 'Priceless Painting', occurrences: 10, qty: { avg: 1 } }],
      10,
      catalog
    )
    expect(result?.value).toBe(70_000_000)
  })

  it('reports an item it cannot price as unmatched, contributing 0 — not a stale value', () => {
    const result = priceNodeItems(
      [{ name: 'Unknown Relic', occurrences: 10, qty: { avg: 1 } }],
      10,
      catalog
    )
    expect(result?.value).toBe(0)
    expect(result?.unmatched).toEqual(['Unknown Relic'])
  })

  it('treats a catalogue entry with both prices at 0 the same as absent', () => {
    const result = priceNodeItems(
      [{ name: 'Mystery Thing', occurrences: 10, qty: { avg: 1 } }],
      10,
      catalog
    )
    expect(result?.value).toBe(0)
    expect(result?.unmatched).toEqual(['Mystery Thing'])
  })

  it('mixes priced and unmatched items in one node without losing either', () => {
    const result = priceNodeItems(
      [
        { name: 'Priceless Painting', occurrences: 10, qty: { avg: 1 } },
        { name: 'Unknown Relic', occurrences: 5, qty: { avg: 1 } },
      ],
      10,
      catalog
    )
    expect(result?.value).toBe(70_000_000)
    expect(result?.unmatched).toEqual(['Unknown Relic'])
  })

  it('matches names case- and whitespace-insensitively', () => {
    const result = priceNodeItems(
      [{ name: '  priceless painting  ', occurrences: 10, qty: { avg: 1 } }],
      10,
      catalog
    )
    expect(result?.value).toBe(70_000_000)
  })

  it('is null when n is not a usable observation count', () => {
    expect(priceNodeItems([{ name: 'Priceless Painting', occurrences: 1, qty: { avg: 1 } }], 0, catalog))
      .toBeNull()
    expect(priceNodeItems([{ name: 'Priceless Painting', occurrences: 1, qty: { avg: 1 } }], NaN, catalog))
      .toBeNull()
  })
})
