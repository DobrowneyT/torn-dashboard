import { useState, useMemo, useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { config } from '../config'
import { formatCurrency } from '../utils/payoutCalculations'

export default function InventoryManagement() {
  const { user } = useAuth()
  
  // Create Set from config crime item IDs for fast lookup
  const CRIME_ITEM_IDS = useMemo(() => new Set(config.crimeItemIds), [])
  
  // Inventory data from Torn API
  const [factionItems, setFactionItems] = useState(null)
  const [factionMembers, setFactionMembers] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastSync, setLastSync] = useState(null)
  
  // Batch pricing data with quantity tracking
  const [itemPricing, setItemPricing] = useState(() => {
    const saved = localStorage.getItem('factionInventoryPricing')
    return saved ? JSON.parse(saved) : {}
  })
  
  // Loaned items dialog
  const [loanedDialog, setLoanedDialog] = useState(null)
  
  // UI state
  const [selectedCategory, setSelectedCategory] = useState('all')
  const [searchTerm, setSearchTerm] = useState('')
  const [sortConfig, setSortConfig] = useState({ key: 'name', direction: 'asc' })
  const [editingItem, setEditingItem] = useState(null)
  const [newBatchPrice, setNewBatchPrice] = useState('')
  const [newBatchQuantity, setNewBatchQuantity] = useState(0)
  
  // Fetch faction armoury data and members
  useEffect(() => {
    fetchFactionInventory()
  }, [])
  
  async function fetchFactionInventory() {
    try {
      setLoading(true)
      setError(null)
      
      const factionId = config.faction.id
      const apiKey = user.apiKey
      
      if (!apiKey) {
        throw new Error('API key not available')
      }
      
      // Fetch items and members in parallel
      const [itemsResponse, membersResponse] = await Promise.all([
        fetch(`https://api.torn.com/faction/${factionId}?selections=temporary,medical,utilities,drugs,armor,weapons,caches,cesium&key=${apiKey}&comment=Dashboard-Inventory-Management`),
        fetch(`https://api.torn.com/faction/${factionId}?selections=basic&key=${apiKey}`)
      ])
      
      if (!itemsResponse.ok || !membersResponse.ok) {
        throw new Error('Failed to fetch faction data')
      }
      
      const itemsData = await itemsResponse.json()
      const membersData = await membersResponse.json()
      
      if (itemsData.error || membersData.error) {
        throw new Error(itemsData.error?.error || membersData.error?.error || 'API error')
      }
      
      // Store members for name lookup
      const members = {}
      Object.entries(membersData.members || {}).forEach(([id, memberData]) => {
        members[id] = memberData.name
      })
      setFactionMembers(members)
      
      // Process all categories from API response
      const items = {}
      const categories = ['temporary', 'medical', 'utilities', 'drugs', 'armor', 'weapons', 'caches', 'cesium']
      
      categories.forEach(category => {
        if (itemsData[category] && Array.isArray(itemsData[category])) {
          itemsData[category].forEach(item => {
            const itemId = item.ID.toString()
            items[itemId] = {
              id: itemId,
              name: item.name || `Item ${item.ID}`,
              quantity: item.quantity || 0,
              available: item.available || 0,
              loaned: item.loaned || 0,
              loanedTo: item.loaned_to,
              apiType: item.type || category,
              category: category
            }
            
            // Detect quantity increase (new batch)
            const oldPricing = itemPricing[itemId]
            if (oldPricing && oldPricing.totalQuantity < item.quantity) {
              // Quantity increased - there's a new batch
              const newBatchQty = item.quantity - oldPricing.totalQuantity
              console.log(`New batch detected for ${item.name}: ${newBatchQty} items`)
            }
          })
        }
      })
      
      setFactionItems(items)
      setLastSync(new Date())
      
    } catch (err) {
      console.error('Error fetching faction inventory:', err)
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }
  
  // Save pricing data to localStorage
  function savePricing(updatedPricing) {
    localStorage.setItem('factionInventoryPricing', JSON.stringify(updatedPricing))
    setItemPricing(updatedPricing)
  }
  
  // Calculate weighted average price from batches
  function calculateWeightedAverage(batches) {
    if (!batches || batches.length === 0) return 0
    
    let totalValue = 0
    let totalQuantity = 0
    
    batches.forEach(batch => {
      totalValue += batch.price * batch.quantity
      totalQuantity += batch.quantity
    })
    
    return totalQuantity > 0 ? totalValue / totalQuantity : 0
  }
  
  // Update item pricing with new batch
  function handleUpdateItem(itemId) {
    const item = factionItems[itemId]
    const price = parseFloat(newBatchPrice)
    const quantity = parseInt(newBatchQuantity) || item.quantity
    
    if (isNaN(price) || price < 0) {
      alert('Please enter a valid price')
      return
    }
    
    const oldPricing = itemPricing[itemId]
    const batches = oldPricing?.batches || []
    
    // Add new batch
    const newBatch = {
      price: price,
      quantity: quantity,
      addedAt: new Date().toISOString(),
      addedBy: user.name
    }
    
    const updatedBatches = [...batches, newBatch]
    const averagePrice = calculateWeightedAverage(updatedBatches)
    
    const updatedPricing = {
      ...itemPricing,
      [itemId]: {
        currentPrice: averagePrice,
        totalQuantity: item.quantity,
        batches: updatedBatches,
        lastUpdated: new Date().toISOString(),
        lastUpdatedBy: user.name
      }
    }
    
    savePricing(updatedPricing)
    setEditingItem(null)
    setNewBatchPrice('')
    setNewBatchQuantity(0)
  }
  
  // Start editing an item
  function handleEditItem(itemId) {
    const item = factionItems[itemId]
    const pricing = itemPricing[itemId]
    
    setEditingItem(itemId)
    setNewBatchPrice('')
    
    // Calculate new batch quantity if this is a quantity increase
    if (pricing && pricing.totalQuantity < item.quantity) {
      setNewBatchQuantity(item.quantity - pricing.totalQuantity)
    } else {
      setNewBatchQuantity(item.quantity)
    }
  }
  
  // Cancel editing
  function handleCancelEdit() {
    setEditingItem(null)
    setNewBatchPrice('')
    setNewBatchQuantity(0)
  }
  
  // Parse loaned_to string and show dialog
  function handleShowLoanedItems(item) {
    if (!item.loanedTo || item.loaned === 0) return
    
    // Parse comma-separated user IDs
    const userIds = item.loanedTo.split(',').filter(id => id.trim())
    
    // Count items per user
    const loanCounts = {}
    userIds.forEach(id => {
      const userId = id.trim()
      loanCounts[userId] = (loanCounts[userId] || 0) + 1
    })
    
    // Build loan data with member names
    const loanData = Object.entries(loanCounts).map(([userId, count]) => ({
      userId,
      name: factionMembers[userId] || 'Unknown',
      count
    }))
    
    setLoanedDialog({
      itemName: item.name,
      totalLoaned: item.loaned,
      loans: loanData
    })
  }
  
  // Get item with pricing info
  function getEnrichedItems() {
    if (!factionItems) return []
    
    return Object.values(factionItems).map(item => {
      const pricing = itemPricing[item.id] || {}
      const hasNewBatch = pricing.totalQuantity && pricing.totalQuantity < item.quantity
      const newBatchQty = hasNewBatch ? item.quantity - pricing.totalQuantity : 0
      
      return {
        ...item,
        currentPrice: pricing.currentPrice || 0,
        totalValue: (pricing.currentPrice || 0) * item.quantity,
        batches: pricing.batches || [],
        hasNewBatch,
        newBatchQty,
        needsPricing: !pricing.currentPrice || hasNewBatch,
        isCrimeItem: CRIME_ITEM_IDS.has(parseInt(item.id))
      }
    })
  }
  
  // Filter and sort items
  const filteredItems = useMemo(() => {
    let items = getEnrichedItems()
    
    // Filter by category
    if (selectedCategory === 'crimes') {
      items = items.filter(item => item.isCrimeItem)
    } else if (selectedCategory !== 'all') {
      items = items.filter(item => item.category === selectedCategory)
    }
    
    // Filter by search term
    if (searchTerm) {
      items = items.filter(item =>
        item.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        item.id.toString().includes(searchTerm)
      )
    }
    
    // Sort
    items.sort((a, b) => {
      let aVal = a[sortConfig.key]
      let bVal = b[sortConfig.key]
      
      if (sortConfig.key === 'name') {
        aVal = aVal.toLowerCase()
        bVal = bVal.toLowerCase()
      } else if (sortConfig.key === 'id') {
        aVal = parseInt(aVal) || 0
        bVal = parseInt(bVal) || 0
      }
      
      if (aVal < bVal) {
        return sortConfig.direction === 'asc' ? -1 : 1
      }
      if (aVal > bVal) {
        return sortConfig.direction === 'asc' ? 1 : -1
      }
      return 0
    })
    
    return items
  }, [factionItems, itemPricing, selectedCategory, searchTerm, sortConfig])
  
  // Calculate totals
  const totals = useMemo(() => {
    const items = getEnrichedItems()
    const byCategory = {}
    
    Object.keys(config.inventoryCategories).forEach(cat => {
      byCategory[cat] = {
        count: 0,
        quantity: 0,
        value: 0
      }
    })
    
    items.forEach(item => {
      const cat = item.category
      if (byCategory[cat]) {
        byCategory[cat].count++
        byCategory[cat].quantity += item.quantity
        byCategory[cat].value += item.totalValue
      }
      
      if (item.isCrimeItem && byCategory['crimes']) {
        byCategory['crimes'].count++
        byCategory['crimes'].quantity += item.quantity
        byCategory['crimes'].value += item.totalValue
      }
    })
    
    return {
      totalItems: items.length,
      totalQuantity: items.reduce((sum, i) => sum + i.quantity, 0),
      totalValue: items.reduce((sum, i) => sum + i.totalValue, 0),
      itemsWithPricing: items.filter(i => i.currentPrice > 0 && !i.hasNewBatch).length,
      itemsNeedingPricing: items.filter(i => i.needsPricing).length,
      byCategory
    }
  }, [factionItems, itemPricing])
  
  const handleSort = (key) => {
    let direction = 'asc'
    if (sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc'
    }
    setSortConfig({ key, direction })
  }
  
  const SortIcon = ({ columnKey }) => {
    if (sortConfig.key !== columnKey) {
      return <span className="ml-1 text-gray-400">⇅</span>
    }
    return (
      <span className="ml-1">
        {sortConfig.direction === 'asc' ? '↑' : '↓'}
      </span>
    )
  }
  
  if (loading && !factionItems) {
    return (
      <div className="card">
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mr-3"></div>
          <p className="text-gray-600 dark:text-gray-400">Loading faction inventory...</p>
        </div>
      </div>
    )
  }
  
  if (error && !factionItems) {
    return (
      <div className="card">
        <div className="text-center py-8">
          <h3 className="text-lg font-semibold text-red-600 mb-2">Error Loading Inventory</h3>
          <p className="text-gray-600 dark:text-gray-400 mb-4">{error}</p>
          <button
            onClick={fetchFactionInventory}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }
  
  return (
    <div className="space-y-6">
      {/* Loaned Items Dialog */}
      {loanedDialog && (
        <LoanedItemsDialog 
          data={loanedDialog} 
          onClose={() => setLoanedDialog(null)}
        />
      )}
      
      {/* Header with Sync Button */}
      <div className="card">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold">Faction Inventory Management</h2>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
              Manage faction armoury items with batch pricing
            </p>
            {lastSync && (
              <p className="text-xs text-gray-500 dark:text-gray-500 mt-1">
                Last synced: {lastSync.toLocaleString()}
              </p>
            )}
          </div>
          <button
            onClick={fetchFactionInventory}
            disabled={loading}
            className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {loading ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                Syncing...
              </>
            ) : (
              <>
                Sync with Torn API
              </>
            )}
          </button>
        </div>
      </div>
      
      {/* Summary Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="card border-l-4 border-blue-500">
          <div className="text-sm text-gray-600 dark:text-gray-400">Total Items</div>
          <div className="text-2xl font-bold">{totals.totalItems}</div>
        </div>
        <div className="card border-l-4 border-green-500">
          <div className="text-sm text-gray-600 dark:text-gray-400">Total Quantity</div>
          <div className="text-2xl font-bold">{totals.totalQuantity.toLocaleString()}</div>
        </div>
        <div className="card border-l-4 border-purple-500">
          <div className="text-sm text-gray-600 dark:text-gray-400">Total Value</div>
          <div className="text-2xl font-bold">{formatCurrency(totals.totalValue)}</div>
        </div>
        <div className="card border-l-4 border-orange-500">
          <div className="text-sm text-gray-600 dark:text-gray-400">Needs Pricing</div>
          <div className="text-2xl font-bold text-orange-600">{totals.itemsNeedingPricing}</div>
        </div>
      </div>
      
      {/* Category Stats */}
      <div className="card">
        <h3 className="font-semibold mb-4">Inventory by Category</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {Object.entries(config.inventoryCategories).map(([key, cat]) => {
            const stats = totals.byCategory[key]
            return (
              <div
                key={key}
                className="border border-gray-200 dark:border-slate-700 rounded-lg p-3 hover:shadow-md transition-shadow cursor-pointer"
                onClick={() => setSelectedCategory(key)}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="font-semibold">{cat.label}</span>
                  <span className={`text-xs px-2 py-1 rounded bg-${cat.color}-100 text-${cat.color}-800 dark:bg-${cat.color}-900/30 dark:text-${cat.color}-400`}>
                    {stats.count} items
                  </span>
                </div>
                <div className="text-xs text-gray-600 dark:text-gray-400">
                  {stats.quantity.toLocaleString()} units • {formatCurrency(stats.value)}
                </div>
              </div>
            )
          })}
        </div>
      </div>
      
      {/* Filters */}
      <div className="card">
        <div className="flex flex-col md:flex-row gap-4">
          <div className="flex-1">
            <input
              type="text"
              placeholder="Search items by name or ID..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="input w-full"
            />
          </div>
          <div>
            <select
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value)}
              className="input"
            >
              <option value="all">All Categories</option>
              {Object.entries(config.inventoryCategories).map(([key, cat]) => (
                <option key={key} value={key}>
                  {cat.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
      
      {/* Items Table */}
      <div className="card">
        <h3 className="font-semibold mb-4">
          Items List 
          <span className="text-sm font-normal text-gray-600 dark:text-gray-400 ml-2">
            (Showing {filteredItems.length} of {totals.totalItems})
          </span>
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b-2 border-gray-200 dark:border-slate-700">
              <tr className="text-left">
                <th 
                  className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700"
                  onClick={() => handleSort('id')}
                >
                  ID <SortIcon columnKey="id" />
                </th>
                <th 
                  className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700"
                  onClick={() => handleSort('name')}
                >
                  Name <SortIcon columnKey="name" />
                </th>
                <th className="py-2 px-2 font-semibold text-xs">
                  Category
                </th>
                <th 
                  className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700"
                  onClick={() => handleSort('quantity')}
                >
                  Total <SortIcon columnKey="quantity" />
                </th>
                <th 
                  className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700"
                  onClick={() => handleSort('available')}
                >
                  Available <SortIcon columnKey="available" />
                </th>
                <th className="py-2 px-2 font-semibold text-xs">
                  Loaned
                </th>
                <th 
                  className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700"
                  onClick={() => handleSort('currentPrice')}
                >
                  Avg Price <SortIcon columnKey="currentPrice" />
                </th>
                <th 
                  className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700"
                  onClick={() => handleSort('totalValue')}
                >
                  Total Value <SortIcon columnKey="totalValue" />
                </th>
                <th className="py-2 px-2 font-semibold text-xs">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredItems.length === 0 ? (
                <tr>
                  <td colSpan="9" className="py-8 text-center text-gray-500">
                    No items found matching the current filters.
                  </td>
                </tr>
              ) : (
                filteredItems.map((item) => {
                  const isEditing = editingItem === item.id
                  const categoryInfo = config.inventoryCategories[item.category]
                  
                  return (
                    <tr 
                      key={item.id} 
                      className="border-b border-gray-200 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-700/50"
                    >
                      <td className="py-2 px-2 font-medium text-xs">{item.id}</td>
                      <td className="py-2 px-2 text-xs">
                        {item.name}
                        {item.isCrimeItem && (
                          <span className="ml-1 text-red-500" title="Crime Item">🎯</span>
                        )}
                      </td>
                      <td className="py-2 px-2 text-xs">
                        <span className="capitalize">{categoryInfo?.label || item.category}</span>
                      </td>
                      <td className="py-2 px-2 text-xs">
                        <span className={item.quantity > 0 ? 'text-green-600 font-semibold' : 'text-red-600'}>
                          {item.quantity.toLocaleString()}
                        </span>
                      </td>
                      <td className="py-2 px-2 text-xs">
                        {item.available.toLocaleString()}
                      </td>
                      <td className="py-2 px-2 text-xs">
                        {item.loaned > 0 ? (
                          <button
                            onClick={() => handleShowLoanedItems(item)}
                            className="text-orange-600 hover:text-orange-700 underline font-semibold"
                          >
                            {item.loaned}
                          </button>
                        ) : (
                          <span>0</span>
                        )}
                      </td>
                      <td className="py-2 px-2 text-xs">
                        {isEditing ? (
                          <div className="space-y-1">
                            <input
                              type="number"
                              value={newBatchPrice}
                              onChange={(e) => setNewBatchPrice(e.target.value)}
                              className="input py-1 px-2 text-xs w-24"
                              placeholder="Price"
                              min="0"
                            />
                            {item.hasNewBatch && (
                              <div className="text-xs text-blue-600">
                                New: {newBatchQuantity} items
                              </div>
                            )}
                          </div>
                        ) : (
                          <div>
                            <span className={item.currentPrice > 0 ? '' : 'text-red-600'}>
                              {item.currentPrice > 0 ? formatCurrency(item.currentPrice) : 'Not set'}
                            </span>
                            {item.hasNewBatch && (
                              <div className="text-xs text-orange-600 font-semibold">
                                +{item.newBatchQty} new
                              </div>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="py-2 px-2 text-xs font-semibold text-blue-600">
                        {formatCurrency(item.totalValue)}
                      </td>
                      <td className="py-2 px-2 text-xs">
                        {isEditing ? (
                          <div className="flex gap-1">
                            <button
                              onClick={() => handleUpdateItem(item.id)}
                              className="px-2 py-1 bg-green-600 text-white rounded text-xs hover:bg-green-700"
                            >
                              Save
                            </button>
                            <button
                              onClick={handleCancelEdit}
                              className="px-2 py-1 bg-gray-600 text-white rounded text-xs hover:bg-gray-700"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => handleEditItem(item.id)}
                            className={`px-2 py-1 text-white rounded text-xs ${
                              item.hasNewBatch 
                                ? 'bg-orange-600 hover:bg-orange-700' 
                                : 'bg-blue-600 hover:bg-blue-700'
                            }`}
                          >
                            {item.hasNewBatch ? 'Price New' : 'Edit'}
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
      
      {/* Info Box */}
      <div className="card bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
        <h3 className="font-semibold text-blue-900 dark:text-blue-100 mb-2">
          How Batch Pricing Works
        </h3>
        <ul className="text-sm text-blue-800 dark:text-blue-200 space-y-1 list-disc list-inside">
          <li><strong>Initial Pricing:</strong> Set price for all current items</li>
          <li><strong>New Batches:</strong> When quantity increases, set price for only the new items</li>
          <li><strong>Weighted Average:</strong> Overall price is calculated as weighted average of all batches</li>
          <li><strong>Example:</strong> 100 items at $13M + 100 items at $15M = Average $14M</li>
          <li><strong>Loaned Items:</strong> Click loaned count to see which members have items</li>
          <li><strong>Crime Items:</strong> Items marked with 🎯 are used in organized crimes</li>
        </ul>
      </div>
    </div>
  )
}

// Loaned Items Dialog Component
function LoanedItemsDialog({ data, onClose }) {
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl max-w-md w-full">
        <div className="p-4 border-b border-gray-200 dark:border-slate-700">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold">Loaned Items</h3>
            <button
              onClick={onClose}
              className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div className="text-sm text-gray-600 dark:text-gray-400 mt-1">
            {data.itemName}
          </div>
        </div>
        
        <div className="p-4">
          <div className="mb-3">
            <div className="text-sm text-gray-600 dark:text-gray-400">
              Total Loaned: <span className="font-semibold text-orange-600">{data.totalLoaned}</span>
            </div>
          </div>
          
          <div className="space-y-2">
            {data.loans.map((loan, idx) => (
              <div 
                key={idx}
                className="flex items-center justify-between p-2 bg-gray-50 dark:bg-slate-700 rounded"
              >
                <div className="text-sm">
                  <div className="font-medium">{loan.name}</div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">ID: {loan.userId}</div>
                </div>
                <div className="text-sm font-semibold text-orange-600">
                  {loan.count} {loan.count === 1 ? 'item' : 'items'}
                </div>
              </div>
            ))}
          </div>
        </div>
        
        <div className="p-4 border-t border-gray-200 dark:border-slate-700">
          <button
            onClick={onClose}
            className="w-full px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}