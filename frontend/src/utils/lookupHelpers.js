import { apiGet } from './apiClient'

/**
 * Enrich item breakdown with actual prices from database and Torn API
 * - Reward items: Use Torn API market prices
 * - Cost items: Use weighted average from inventory_items_with_prices view
 * - Item names: Lookup from items table
 *
 * All three data sources are fetched in parallel for performance.
 */
export async function enrichItemBreakdown(itemBreakdown, apiKey) {
  if (!itemBreakdown) return itemBreakdown
  
  try {
    // Get all unique item IDs
    const rewardIds = Object.keys(itemBreakdown.rewards || {})
    const costIds = Object.keys(itemBreakdown.costs || {})
    const allIds = [...new Set([...rewardIds, ...costIds])]
    
    if (allIds.length === 0) return itemBreakdown
    
    // Fetch names/prices from the API; Torn market prices only when the
    // browser still holds a key (legacy mode — API mode skips them).
    const [lookup, marketPrices] = await Promise.all([
      apiGet(`/api/items/lookup?ids=${allIds.join(',')}`),
      (rewardIds.length > 0 && apiKey)
        ? fetchItemMarketPrices(rewardIds, apiKey)
        : Promise.resolve({}),
    ])

    // Build item names + sell-price maps
    const itemNames = {}
    const itemSellPrices = {}
    for (const item of (lookup.items || [])) {
      itemNames[item.id.toString()] = item.name
      itemSellPrices[item.id.toString()] = parseInt(item.sell_price) || 0
    }
    // Build cost prices map
    const costPrices = {}
    for (const item of (lookup.inventory_prices || [])) {
      costPrices[item.item_id] = parseFloat(item.weighted_avg_price) || 0
    }

    // Update reward items: use the larger of market price and sell price.
    // Some illiquid items return market_price=0; sell_price is always defined.
    const enrichedRewards = {}
    Object.entries(itemBreakdown.rewards || {}).forEach(([itemId, data]) => {
      const sellPrice = itemSellPrices[itemId] || 0
      const marketPrice = marketPrices[itemId] || 0
      const unitValue = Math.max(sellPrice, marketPrice)
      const itemName = itemNames[itemId] || data.name || `Item ${itemId}`
      const priceSource = unitValue === 0
        ? 'none'
        : (marketPrice >= sellPrice ? 'torn_api' : 'sell_price')

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

async function fetchItemMarketPrices(itemIds, apiKey) {
  if (!itemIds || itemIds.length === 0) return {}
  
  const uniqueIds = [...new Set(itemIds)]
  const idsString = uniqueIds.join(',')
  
  try {
    const response = await fetch(
      `https://api.torn.com/v2/torn/${idsString}/items?sort=ASC&key=${apiKey}`
    )
    
    if (!response.ok) {
      throw new Error('Failed to fetch item prices from Torn API')
    }
    
    const data = await response.json()
    
    if (data.error) {
      throw new Error(data.error.error || 'Unknown API error')
    }
    
    const priceMap = {}
    if (data.items) {
      data.items.forEach(item => {
        priceMap[item.id.toString()] = item.value?.market_price || 0
      })
    }
    
    console.log('Fetched market prices for', Object.keys(priceMap).length, 'items')
    return priceMap
  } catch (error) {
    console.error('Error fetching item market prices:', error)
    return {}
  }
}