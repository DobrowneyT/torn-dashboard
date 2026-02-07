import { supabase } from './supabase'

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
    
    // Fetch all data sources in parallel
    const [itemsResult, marketPrices, costPricesResult] = await Promise.all([
      // Item names from items table
      supabase.from('items').select('id, name').in('id', allIds),
      // Market prices from Torn API for reward items
      (rewardIds.length > 0 && apiKey)
        ? fetchItemMarketPrices(rewardIds, apiKey)
        : Promise.resolve({}),
      // Weighted averages from database view for cost items
      (costIds.length > 0)
        ? supabase.from('inventory_items_with_prices').select('item_id, weighted_avg_price').in('item_id', costIds)
        : Promise.resolve({ data: null })
    ])

    // Build item names map
    const itemNames = {}
    if (itemsResult.data) {
      itemsResult.data.forEach(item => {
        itemNames[item.id.toString()] = item.name
      })
    }

    // Build cost prices map
    const costPrices = {}
    if (costPricesResult.data) {
      costPricesResult.data.forEach(item => {
        costPrices[item.item_id] = parseFloat(item.weighted_avg_price) || 0
      })
    }
    
    // Update reward items with market prices and names
    const enrichedRewards = {}
    Object.entries(itemBreakdown.rewards || {}).forEach(([itemId, data]) => {
      const marketPrice = marketPrices[itemId] || 0
      const itemName = itemNames[itemId] || data.name || `Item ${itemId}`
      
      enrichedRewards[itemId] = {
        ...data,
        name: itemName,
        unitValue: marketPrice,
        totalValue: marketPrice * data.quantity,
        priceSource: marketPrice > 0 ? 'torn_api' : 'none'
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