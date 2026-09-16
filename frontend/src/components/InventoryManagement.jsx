import { useState, useMemo, useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { config } from '../config'
import { formatCurrency } from '../utils/payoutCalculations'
import { X } from 'lucide-react'
import { apiGet, apiPost, apiPut } from '../utils/apiClient'
import { parseDbTime } from '../utils/time'
import InfoTooltip from './InfoTooltip'

export default function InventoryManagement() {
  const { user } = useAuth()
  
  const CRIME_ITEM_IDS = useMemo(() => new Set(config.crimeItemIds), [])
  
  const [inventoryItems, setInventoryItems] = useState([])
  const [pricingBatches, setPricingBatches] = useState([])
  const [factionMembers, setFactionMembers] = useState({})
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState(null)
  const [lastSync, setLastSync] = useState(null)
  
  const [loanedDialog, setLoanedDialog] = useState(null)
  const [selectedCategory, setSelectedCategory] = useState('all')
  const [searchTerm, setSearchTerm] = useState('')
  const [sortConfig, setSortConfig] = useState({ key: 'name', direction: 'asc' })
  const [editingItem, setEditingItem] = useState(null)
  const [newBatchPrice, setNewBatchPrice] = useState('')
  const [newBatchQuantity, setNewBatchQuantity] = useState(0)
  
  useEffect(() => {
    loadInventory()
  }, [])

  async function loadInventory() {
    try {
      setLoading(true)
      setError(null)

      // Load priced inventory + sync marker, and member names in parallel
      const [inventory, rosterData] = await Promise.all([
        apiGet('/api/inventory'),
        apiGet('/api/members/roster'),
      ])

      setInventoryItems(inventory.items || [])
      if (inventory.last_sync) {
        setLastSync(parseDbTime(inventory.last_sync))
      }

      // Populate factionMembers map from DB so loaned items show names, not "Unknown"
      const members = {}
      for (const m of (rosterData.roster || [])) {
        members[m.member_id] = m.member_name
      }
      setFactionMembers(members)

    } catch (err) {
      console.error('Error loading inventory:', err)
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }
  
  async function syncWithTornAPI() {
    try {
      setSyncing(true)
      setError(null)

      // The server pulls the faction inventory from Torn with its own key
      // and replaces the stored quantities; throws with the server message.
      await apiPost('/api/inventory/sync', {})
      await loadInventory()

    } catch (err) {
      console.error('Error syncing inventory:', err)
      setError(err.message)
    } finally {
      setSyncing(false)
    }
  }
  
  async function handleUpdateItem(itemId) {
    const item = inventoryItems.find(i => i.item_id === itemId)
    const price = parseFloat(newBatchPrice)
    const quantity = parseInt(newBatchQuantity) || item.quantity
    
    if (isNaN(price) || price < 0) {
      alert('Please enter a valid price')
      return
    }
    
    if (quantity <= 0 || quantity > item.quantity) {
      alert(`Please enter a quantity between 1 and ${item.quantity}`)
      return
    }
    
    try {
      await apiPost('/api/inventory/pricing-batches', {
        item_id: itemId,
        price: Math.floor(price),
        quantity: quantity,
      })

      await loadInventory()
      
      setEditingItem(null)
      setNewBatchPrice('')
      setNewBatchQuantity(0)
      
    } catch (err) {
      console.error('Error saving pricing:', err)
      alert(err.message)
    }
  }
  
  function handleEditItem(itemId) {
    const item = inventoryItems.find(i => i.item_id === itemId)
    
    setEditingItem(itemId)
    setNewBatchPrice('')
    
    const unbatchedQty = item.quantity - (item.total_batched_quantity || 0)
    if (unbatchedQty > 0) {
      setNewBatchQuantity(unbatchedQty)
    } else {
      setNewBatchQuantity(item.quantity)
    }
  }
  
  async function handleSetPrice(itemId) {
    const item = inventoryItems.find(i => i.item_id === itemId)
    if (!item) return

    const priceStr = window.prompt(
      `Set price for all ${item.quantity} × ${item.item_name}.\n\nEnter new price per unit:`
    )
    if (priceStr === null) return

    const price = parseFloat(priceStr)
    if (isNaN(price) || price < 0) {
      alert('Please enter a valid price')
      return
    }

    try {
      // Server-side: replaces every batch with one at the new price for the
      // item's full quantity, in a single transaction.
      await apiPut(`/api/inventory/items/${itemId}/price`, { price: Math.floor(price) })

      await loadInventory()
    } catch (err) {
      console.error('Error setting price:', err)
      alert(err.message)
    }
  }

  function handleCancelEdit() {
    setEditingItem(null)
    setNewBatchPrice('')
    setNewBatchQuantity(0)
  }
  
  function handleShowLoanedItems(item) {
    if (!item.loaned_to || item.loaned === 0) return

    // loaned_to is {member_id, member_name, amount}[] straight from Torn
    // (server/src/scraper/inventoryMap.ts) — the name and amount are already
    // correct per borrower, no id lookup or string parsing needed.
    const loans = [...item.loaned_to]
      .map(l => ({
        userId: String(l.member_id),
        name: l.member_name || factionMembers[l.member_id] || `#${l.member_id}`,
        count: Number(l.amount) || 0,
      }))
      .sort((a, b) => b.count - a.count)

    const totalCounted = loans.reduce((sum, loan) => sum + loan.count, 0)

    setLoanedDialog({
      itemName: item.item_name,
      totalLoaned: item.loaned,
      totalCounted: totalCounted,
      loans,
      hasMismatch: totalCounted !== item.loaned
    })
  }
  
  const enrichedItems = useMemo(() => {
    return inventoryItems.map(item => {
      const avgPrice = parseFloat(item.weighted_avg_price) || 0
      const totalValue = parseFloat(item.total_value) || 0
      const batchedQty = parseInt(item.total_batched_quantity) || 0
      const hasNewBatch = batchedQty < item.quantity
      const newBatchQty = hasNewBatch ? item.quantity - batchedQty : 0
      
      return {
        id: item.item_id,
        item_id: item.item_id,
        name: item.item_name,
        quantity: item.quantity,
        available: item.available,
        loaned: item.loaned,
        loaned_to: item.loaned_to,
        category: item.category,
        currentPrice: avgPrice,
        totalValue: totalValue,
        batchedQuantity: batchedQty,
        hasNewBatch,
        newBatchQty,
        needsPricing: avgPrice === 0 || hasNewBatch,
        isCrimeItem: CRIME_ITEM_IDS.has(parseInt(item.item_id)),
        last_price_update: item.last_price_update
      }
    })
  }, [inventoryItems, CRIME_ITEM_IDS])
  
  const filteredItems = useMemo(() => {
    let items = [...enrichedItems]
    
    if (selectedCategory === 'crimes') {
      items = items.filter(item => item.isCrimeItem)
    } else if (selectedCategory !== 'all') {
      items = items.filter(item => item.category === selectedCategory)
    }
    
    if (searchTerm) {
      items = items.filter(item =>
        item.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        item.id.toString().includes(searchTerm)
      )
    }
    
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
  }, [enrichedItems, selectedCategory, searchTerm, sortConfig])
  
  const totals = useMemo(() => {
    const categoryStats = {}
    Object.keys(config.inventoryCategories).forEach(cat => {
      categoryStats[cat] = { count: 0, quantity: 0, value: 0 }
    })
    
    enrichedItems.forEach(item => {
      if (categoryStats[item.category]) {
        categoryStats[item.category].count++
        categoryStats[item.category].quantity += item.quantity
        categoryStats[item.category].value += item.totalValue
      }
      
      if (item.isCrimeItem && categoryStats['crimes']) {
        categoryStats['crimes'].count++
        categoryStats['crimes'].quantity += item.quantity
        categoryStats['crimes'].value += item.totalValue
      }
    })
    
    return {
      totalItems: enrichedItems.length,
      totalQuantity: enrichedItems.reduce((sum, i) => sum + i.quantity, 0),
      totalValue: enrichedItems.reduce((sum, i) => sum + i.totalValue, 0),
      itemsWithPricing: enrichedItems.filter(i => i.currentPrice > 0 && !i.hasNewBatch).length,
      itemsNeedingPricing: enrichedItems.filter(i => i.needsPricing).length,
      byCategory: categoryStats
    }
  }, [enrichedItems])
  
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
  
  if (loading && inventoryItems.length === 0) {
    return (
      <div className="card">
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mr-3"></div>
          <p className="text-gray-600 dark:text-gray-400">Loading inventory from database...</p>
        </div>
      </div>
    )
  }
  
  if (error && inventoryItems.length === 0) {
    return (
      <div className="card">
        <div className="text-center py-8">
          <h3 className="text-lg font-semibold text-red-600 mb-2">Error Loading Inventory</h3>
          <p className="text-gray-600 dark:text-gray-400 mb-4">{error}</p>
          <button
            onClick={loadInventory}
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
      {loanedDialog && (
        <LoanedItemsDialog 
          data={loanedDialog} 
          onClose={() => setLoanedDialog(null)}
        />
      )}
      
      <div className="card">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold">Faction Inventory Management</h2>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
              Manage faction armoury with batch pricing system
            </p>
            {lastSync && (
              <p className="text-xs text-gray-500 dark:text-gray-500 mt-1">
                Last synced: {lastSync.toLocaleString()}
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={syncWithTornAPI}
              disabled={syncing}
              className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {syncing ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                  Fetching…
                </>
              ) : (
                <>
                  Fetch Inventory
                </>
              )}
            </button>
          </div>
        </div>
        
        {error && (
          <div className="mt-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3">
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          </div>
        )}
      </div>
      
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
      
      <div className="card">
        <h3 className="font-semibold mb-4">Inventory by Category</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {Object.entries(config.inventoryCategories).map(([key, cat]) => {
            const stats = totals.byCategory[key] || { count: 0, quantity: 0, value: 0 }
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
                    {inventoryItems.length === 0 ? 'No inventory data. Click "Sync with Torn API" to load items.' : 'No items found.'}
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
                          <InfoTooltip label="🎯" decoration="no-underline" className="ml-1 text-red-500">
                            Crime item
                          </InfoTooltip>
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
                            <input
                              type="number"
                              value={newBatchQuantity}
                              onChange={(e) => setNewBatchQuantity(parseInt(e.target.value) || 0)}
                              className="input py-1 px-2 text-xs w-24"
                              placeholder="Qty"
                              min="1"
                              max={item.quantity}
                            />
                            <div className="text-xs text-gray-500">
                              of {item.quantity} total
                            </div>
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
                          <div className="flex gap-1">
                            <button
                              onClick={() => handleEditItem(item.id)}
                              className={`px-2 py-1 text-white rounded text-xs ${
                                item.hasNewBatch
                                  ? 'bg-orange-600 hover:bg-orange-700'
                                  : 'bg-blue-600 hover:bg-blue-700'
                              }`}
                            >
                              {item.hasNewBatch ? 'Price New' : 'Add Batch'}
                            </button>
                            <button
                              onClick={() => handleSetPrice(item.item_id)}
                              className="px-2 py-1 bg-purple-600 text-white rounded text-xs hover:bg-purple-700"
                              aria-label="Set price for all items of this type"
                            >
                              Set Price
                            </button>
                          </div>
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
      
      <div className="card bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
        <h3 className="font-semibold text-blue-900 dark:text-blue-100 mb-2">
          Batch Pricing System
        </h3>
        <ul className="text-sm text-blue-800 dark:text-blue-200 space-y-1 list-disc list-inside">
          <li>All data stored in the faction's PostgreSQL database with automatic calculations</li>
          <li>Click "Sync with Torn API" to update inventory from game</li>
          <li>Set prices in batches (e.g., 20 items at $50k, 30 at $60k)</li>
          <li>Weighted averages calculated automatically by database views</li>
          <li>Example: 20@$50k + 30@$60k = $56k average</li>
          <li>Loaned items: click count to see who has items</li>
          <li>Crime items marked with 🎯</li>
        </ul>
      </div>
    </div>
  )
}

function LoanedItemsDialog({ data, onClose }) {
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl max-w-md w-full max-h-[90vh] flex flex-col">
        <div className="p-4 border-b border-gray-200 dark:border-slate-700 flex-shrink-0">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold">Loaned Items</h3>
            <button
              onClick={onClose}
              className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            >
              <X className="w-6 h-6" />
            </button>
          </div>
          <div className="text-sm text-gray-600 dark:text-gray-400 mt-1">
            {data.itemName}
          </div>
        </div>
        
        <div className="p-4 flex-1 overflow-y-auto">
          <div className="mb-3">
            <div className="text-sm text-gray-600 dark:text-gray-400">
              Total Loaned: <span className="font-semibold text-orange-600">{data.totalLoaned}</span>
            </div>
            {data.hasMismatch && (
              <div className="mt-2 text-xs bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded p-2">
                <span className="text-yellow-800 dark:text-yellow-400">
                  Warning: Counted {data.totalCounted} items but Torn shows {data.totalLoaned}. 
                  This may indicate incomplete loan data from the API.
                </span>
              </div>
            )}
          </div>
          
          <div className="text-xs text-gray-500 dark:text-gray-400 mb-2">
            {data.loans.length} {data.loans.length === 1 ? 'person has' : 'people have'} items
          </div>
          
          <div className="space-y-2 max-h-[400px] overflow-y-auto pr-2">
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
        
        <div className="p-4 border-t border-gray-200 dark:border-slate-700 flex-shrink-0">
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