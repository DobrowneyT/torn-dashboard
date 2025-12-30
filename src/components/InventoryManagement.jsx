import { useState, useMemo, useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { config } from '../config'
import { formatCurrency } from '../utils/payoutCalculations'

/**
 * Enhanced Inventory Management Component
 * 
 * Features:
 * - Fetches current faction armoury from Torn API
 * - Categorizes items (Crimes, Medical, Drugs, Equipment, Other)
 * - Tracks item prices and quantities
 * - Audit view of all faction items
 * - Easy price updates for leadership
 * - Syncs with faction armoury automatically
 */
export default function InventoryManagement() {
  const { user } = useAuth()
  
  // Inventory data from Torn API
  const [factionItems, setFactionItems] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastSync, setLastSync] = useState(null)
  
  // Local pricing data (stored in localStorage)
  const [itemPricing, setItemPricing] = useState(() => {
    const saved = localStorage.getItem('factionInventoryPricing')
    return saved ? JSON.parse(saved) : {}
  })
  
  // UI state
  const [selectedCategory, setSelectedCategory] = useState('all')
  const [searchTerm, setSearchTerm] = useState('')
  const [sortConfig, setSortConfig] = useState({ key: 'name', direction: 'asc' })
  const [editingItem, setEditingItem] = useState(null)
  const [newPrice, setNewPrice] = useState('')
  const [newCategory, setNewCategory] = useState('other')
  
  // Fetch faction armoury data
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
      
      const response = await fetch(
        `https://api.torn.com/faction/${factionId}?selections=armor,armorynews,donations,temporary&key=${apiKey}`
      )
      
      if (!response.ok) {
        throw new Error('Failed to fetch faction data')
      }
      
      const data = await response.json()
      
      if (data.error) {
        throw new Error(data.error.error || 'API error')
      }
      
      // Process armoury data
      const items = {}
      
      // Process armor/items from armoury
      if (data.armor) {
        Object.entries(data.armor).forEach(([itemId, itemData]) => {
          items[itemId] = {
            id: itemId,
            name: itemData.name || `Item ${itemId}`,
            quantity: itemData.quantity || 0,
            type: itemData.type || 'unknown',
            available: itemData.available || 0,
            loaned: (itemData.quantity || 0) - (itemData.available || 0)
          }
        })
      }
      
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
  
  // Update item pricing and category
  function handleUpdateItem(itemId) {
    const price = parseFloat(newPrice)
    
    if (isNaN(price) || price < 0) {
      alert('Please enter a valid price')
      return
    }
    
    const updatedPricing = {
      ...itemPricing,
      [itemId]: {
        price: price,
        category: newCategory,
        updatedAt: new Date().toISOString(),
        updatedBy: user.name
      }
    }
    
    savePricing(updatedPricing)
    setEditingItem(null)
    setNewPrice('')
    setNewCategory('other')
  }
  
  // Start editing an item
  function handleEditItem(itemId) {
    const pricing = itemPricing[itemId]
    setEditingItem(itemId)
    setNewPrice(pricing?.price?.toString() || '')
    setNewCategory(pricing?.category || 'other')
  }
  
  // Cancel editing
  function handleCancelEdit() {
    setEditingItem(null)
    setNewPrice('')
    setNewCategory('other')
  }
  
  // Get item with pricing info
  function getEnrichedItems() {
    if (!factionItems) return []
    
    return Object.entries(factionItems).map(([itemId, item]) => {
      const pricing = itemPricing[itemId] || {}
      return {
        ...item,
        price: pricing.price || 0,
        category: pricing.category || 'other',
        totalValue: (pricing.price || 0) * item.quantity,
        updatedAt: pricing.updatedAt,
        updatedBy: pricing.updatedBy
      }
    })
  }
  
  // Filter and sort items
  const filteredItems = useMemo(() => {
    let items = getEnrichedItems()
    
    // Filter by category
    if (selectedCategory !== 'all') {
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
    })
    
    return {
      totalItems: items.length,
      totalQuantity: items.reduce((sum, i) => sum + i.quantity, 0),
      totalValue: items.reduce((sum, i) => sum + i.totalValue, 0),
      itemsWithPricing: items.filter(i => i.price > 0).length,
      itemsNeedingPricing: items.filter(i => i.price === 0).length,
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
      {/* Header with Sync Button */}
      <div className="card">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold">Faction Inventory Management</h2>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
              Manage faction armoury items, pricing, and categories
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
                🔄 Sync with Torn API
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
                  <span className="text-lg">{cat.icon}</span>
                  <span className={`text-xs px-2 py-1 rounded bg-${cat.color}-100 text-${cat.color}-800 dark:bg-${cat.color}-900/30 dark:text-${cat.color}-400`}>
                    {stats.count} items
                  </span>
                </div>
                <div className="font-semibold text-sm">{cat.label}</div>
                <div className="text-xs text-gray-600 dark:text-gray-400 mt-1">
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
                  {cat.icon} {cat.label}
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
                  Quantity <SortIcon columnKey="quantity" />
                </th>
                <th 
                  className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700"
                  onClick={() => handleSort('price')}
                >
                  Price <SortIcon columnKey="price" />
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
                  <td colSpan="7" className="py-8 text-center text-gray-500">
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
                      <td className="py-2 px-2 text-xs">{item.name}</td>
                      <td className="py-2 px-2 text-xs">
                        {isEditing ? (
                          <select
                            value={newCategory}
                            onChange={(e) => setNewCategory(e.target.value)}
                            className="input py-1 px-2 text-xs"
                          >
                            {Object.entries(config.inventoryCategories).map(([key, cat]) => (
                              <option key={key} value={key}>
                                {cat.icon} {cat.label}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="text-xs">
                            {categoryInfo?.icon} {categoryInfo?.label}
                          </span>
                        )}
                      </td>
                      <td className="py-2 px-2 text-xs">
                        <span className={item.quantity > 0 ? 'text-green-600 font-semibold' : 'text-red-600'}>
                          {item.quantity.toLocaleString()}
                        </span>
                      </td>
                      <td className="py-2 px-2 text-xs">
                        {isEditing ? (
                          <input
                            type="number"
                            value={newPrice}
                            onChange={(e) => setNewPrice(e.target.value)}
                            className="input py-1 px-2 text-xs w-24"
                            placeholder="0"
                            min="0"
                          />
                        ) : (
                          <span className={item.price > 0 ? '' : 'text-red-600'}>
                            {item.price > 0 ? formatCurrency(item.price) : 'Not set'}
                          </span>
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
                            className="px-2 py-1 bg-blue-600 text-white rounded text-xs hover:bg-blue-700"
                          >
                            Edit
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
          📦 How Inventory Management Works
        </h3>
        <ul className="text-sm text-blue-800 dark:text-blue-200 space-y-1 list-disc list-inside">
          <li><strong>Sync with Torn API:</strong> Automatically fetches current armoury items and quantities</li>
          <li><strong>Set Prices:</strong> Click "Edit" to set price and category for each item</li>
          <li><strong>Categories:</strong> Organize items by usage (Crime items, Medical, Drugs, etc.)</li>
          <li><strong>Auto-Save:</strong> Pricing data is saved to browser localStorage</li>
          <li><strong>Payout Integration:</strong> Item costs can be used in payout calculations (future feature)</li>
          <li><strong>Multi-Leader Access:</strong> All designated leaders can update pricing</li>
        </ul>
      </div>
    </div>
  )
}