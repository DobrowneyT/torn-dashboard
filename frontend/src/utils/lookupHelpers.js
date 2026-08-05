import { apiGet } from './apiClient'

/**
 * Enrich item breakdown with actual prices from the database.
 * - Reward items: larger of the catalogue market price and sell price
 *   (both from the `items` table, kept fresh by the items-sync scraper)
 * - Cost items: weighted average from inventory_items_with_prices view
 * - Item names: lookup from items table
 *
 * All sourced from /api/items/lookup — no raw Torn key needed (#135 part 2).
 */
export async function enrichItemBreakdown(itemBreakdown) {
  if (!itemBreakdown) return itemBreakdown

  try {
    // Get all unique item IDs
    const rewardIds = Object.keys(itemBreakdown.rewards || {})
    const costIds = Object.keys(itemBreakdown.costs || {})
    const allIds = [...new Set([...rewardIds, ...costIds])]

    if (allIds.length === 0) return itemBreakdown

    const lookup = await apiGet(`/api/items/lookup?ids=${allIds.join(',')}`)

    // Build item names + sell-price + market-price maps
    const itemNames = {}
    const itemSellPrices = {}
    const itemMarketPrices = {}
    for (const item of (lookup.items || [])) {
      itemNames[item.id.toString()] = item.name
      itemSellPrices[item.id.toString()] = parseInt(item.sell_price) || 0
      itemMarketPrices[item.id.toString()] = parseInt(item.market_price) || 0
    }
    // Build cost prices map
    const costPrices = {}
    for (const item of (lookup.inventory_prices || [])) {
      costPrices[item.item_id] = parseFloat(item.weighted_avg_price) || 0
    }

    // Update reward items: use the larger of market price and sell price.
    // Some illiquid items have market_price=0; sell_price is always defined.
    const enrichedRewards = {}
    Object.entries(itemBreakdown.rewards || {}).forEach(([itemId, data]) => {
      const sellPrice = itemSellPrices[itemId] || 0
      const marketPrice = itemMarketPrices[itemId] || 0
      const unitValue = Math.max(sellPrice, marketPrice)
      const itemName = itemNames[itemId] || data.name || `Item ${itemId}`
      const priceSource = unitValue === 0
        ? 'none'
        : (marketPrice >= sellPrice ? 'market' : 'sell_price')

      enrichedRewards[itemId] = {
        ...data,
        name: itemName,
        unitValue,
        originalUnitValue: unitValue,
        totalValue: unitValue * data.quantity,
        priceSource
      }
    })
    
    // Update cost items with weighted averages and names
    const enrichedCosts = {}
    Object.entries(itemBreakdown.costs || {}).forEach(([itemId, data]) => {
      const avgPrice = costPrices[itemId] || 0
      const itemName = itemNames[itemId] || data.name || `Item ${itemId}`
      
      enrichedCosts[itemId] = {
        ...data,
        name: itemName,
        unitValue: avgPrice,
        totalValue: avgPrice * data.quantity,
        priceSource: avgPrice > 0 ? 'inventory' : 'none'
      }
    })
    
    console.log('Item breakdown enrichment:')
    console.log('- Rewards:', Object.keys(enrichedRewards).length, 'items')
    console.log('- Costs:', Object.keys(enrichedCosts).length, 'items')
    
    return {
      rewards: enrichedRewards,
      costs: enrichedCosts
    }
    
  } catch (error) {
    console.error('Error enriching item breakdown:', error)
    return itemBreakdown
  }
}