import { useEffect, useState, useMemo, useCallback, Fragment } from 'react'
import { createClient } from '@supabase/supabase-js'
import { config } from '../config'

const supabaseUrl = config.supabase.url
const supabaseAnonKey = config.supabase.anonKey

const supabase = supabaseUrl && supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null

// Item type options - must match exactly what's in the database
const ITEM_TYPES = [
  { value: '', label: 'All Types' },
  { value: 'Primary', label: 'Primary Weapons' },
  { value: 'Secondary', label: 'Secondary Weapons' },
  { value: 'Melee', label: 'Melee Weapons' },
  { value: 'Armor', label: 'Armor' },
]

// Rarity options
const RARITIES = [
  { value: '', label: 'All Rarities' },
  { value: 'yellow', label: 'Yellow', color: 'text-yellow-500' },
  { value: 'orange', label: 'Orange', color: 'text-orange-500' },
  { value: 'red', label: 'Red', color: 'text-red-500' },
]

// Format price with commas
function formatPrice(price) {
  if (!price && price !== 0) return '-'
  return '$' + price.toLocaleString()
}

// Format timestamp to readable date
function formatDate(ts) {
  if (!ts) return '-'
  const date = new Date(ts * 1000)
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

// Debounce hook for search input
function useDebounce(value, delay) {
  const [debouncedValue, setDebouncedValue] = useState(value)
  
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value)
    }, delay)
    
    return () => clearTimeout(handler)
  }, [value, delay])
  
  return debouncedValue
}

// Parse JSON safely
function parseJson(value) {
  if (!value) return null
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

// Get rarity styling
function getRarityClass(rarity) {
  switch (rarity) {
    case 'yellow': return 'text-yellow-500 dark:text-yellow-400'
    case 'orange': return 'text-orange-500 dark:text-orange-400'
    case 'red': return 'text-red-500 dark:text-red-400'
    default: return 'text-gray-900 dark:text-gray-100'
  }
}

// Stats display component
function StatsDisplay({ stats }) {
  if (!stats) return <span className="text-gray-400">-</span>
  
  const parsed = parseJson(stats)
  if (!parsed) return <span className="text-gray-400">-</span>
  
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
      {parsed.damage !== undefined && (
        <div><span className="text-gray-500">Damage:</span> <span className="font-medium">{parsed.damage}</span></div>
      )}
      {parsed.accuracy !== undefined && (
        <div><span className="text-gray-500">Accuracy:</span> <span className="font-medium">{parsed.accuracy}</span></div>
      )}
      {parsed.armor !== undefined && (
        <div><span className="text-gray-500">Armor:</span> <span className="font-medium">{parsed.armor}</span></div>
      )}
      {parsed.quality !== undefined && (
        <div><span className="text-gray-500">Quality:</span> <span className="font-medium">{Number(parsed.quality).toFixed(2)}</span></div>
      )}
    </div>
  )
}

// Bonuses display component
function BonusesDisplay({ bonuses }) {
  if (!bonuses) return <span className="text-gray-400">None</span>
  
  const parsed = parseJson(bonuses)
  if (!parsed || !Array.isArray(parsed) || parsed.length === 0) {
    return <span className="text-gray-400">None</span>
  }
  
  return (
    <div className="space-y-1">
      {parsed.map((bonus, idx) => (
        <div key={idx} className="text-sm">
          <span className="font-medium text-blue-600 dark:text-blue-400">{bonus.bonus || bonus.name || 'Bonus'}</span>
          {bonus.value && <span className="text-gray-600 dark:text-gray-400">: {bonus.value}</span>}
          {bonus.description && <p className="text-xs text-gray-500">{bonus.description}</p>}
        </div>
      ))}
    </div>
  )
}

// Expanded row component
function ExpandedRow({ row }) {
  return (
    <tr className="bg-gray-50 dark:bg-slate-700/30">
      <td colSpan={9} className="px-4 py-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Item Info */}
          <div>
            <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Item Details</h4>
            <div className="space-y-1 text-sm">
              <div><span className="text-gray-500">Item ID:</span> <span className="font-mono">{row.item_id}</span></div>
              <div><span className="text-gray-500">UID:</span> <span className="font-mono">{row.item_uid}</span></div>
              <div><span className="text-gray-500">Sub-type:</span> {row.item_sub_type || '-'}</div>
              <div><span className="text-gray-500">Rarity:</span> <span className={getRarityClass(row.item_rarity)}>{row.item_rarity || 'None'}</span></div>
            </div>
          </div>
          
          {/* Stats */}
          <div>
            <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Stats</h4>
            <StatsDisplay stats={row.item_stats} />
          </div>
          
          {/* Bonuses */}
          <div>
            <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Bonuses</h4>
            <BonusesDisplay bonuses={row.item_bonuses} />
          </div>
        </div>
      </td>
    </tr>
  )
}

// Get quality from item stats
function getQuality(row) {
  const stats = parseJson(row.item_stats)
  return stats?.quality ? Number(stats.quality).toFixed(2) : null
}


export default function AhView() {
  // Filter state
  const [filters, setFilters] = useState({
    itemType: '',
    itemSearch: '',
    minPrice: '',
    maxPrice: '',
    rarity: '',
    dateFrom: '',
    dateTo: '',
  })
  
  // Data state
  const [data, setData] = useState([])
  const [loading, setLoading] = useState(false)
  const [initialLoad, setInitialLoad] = useState(true)
  const [error, setError] = useState(null)
  const [totalCount, setTotalCount] = useState(0)
  
  // Stats state
  const [stats, setStats] = useState({ total: 0, avg: null, min: null, max: null, median: null })
  const [statsLoading, setStatsLoading] = useState(false)
  
  // Table state
  const [sortColumn, setSortColumn] = useState('timestamp')
  const [sortDirection, setSortDirection] = useState('desc')
  const [currentPage, setCurrentPage] = useState(1)
  const [perPage, setPerPage] = useState(100)
  
  // Expanded rows
  const [expandedRows, setExpandedRows] = useState(new Set())
  
  // Debounce search input
  const debouncedSearch = useDebounce(filters.itemSearch, 300)

  // Reset to first page when filters change
  useEffect(() => {
    setCurrentPage(1)
    setExpandedRows(new Set())
  }, [filters.itemType, debouncedSearch, filters.minPrice, filters.maxPrice, filters.rarity, filters.dateFrom, filters.dateTo])

  // Build base query with filters
  const applyFilters = useCallback((query) => {
    if (filters.itemType) {
      query = query.eq('item_type', filters.itemType)
    }

    if (debouncedSearch.trim()) {
      const search = debouncedSearch.trim()
      if (!isNaN(search) && search !== '') {
        query = query.eq('item_id', parseInt(search, 10))
      } else {
        query = query.ilike('item_name', `%${search}%`)
      }
    }

    if (filters.minPrice) {
      query = query.gte('price', parseInt(filters.minPrice, 10))
    }

    if (filters.maxPrice) {
      query = query.lte('price', parseInt(filters.maxPrice, 10))
    }

    if (filters.rarity) {
      query = query.eq('item_rarity', filters.rarity)
    }

    if (filters.dateFrom) {
      const ts = Math.floor(new Date(filters.dateFrom).getTime() / 1000)
      query = query.gte('timestamp', ts)
    }

    if (filters.dateTo) {
      const endDate = new Date(filters.dateTo)
      endDate.setDate(endDate.getDate() + 1)
      const ts = Math.floor(endDate.getTime() / 1000)
      query = query.lt('timestamp', ts)
    }

    return query
  }, [filters.itemType, debouncedSearch, filters.minPrice, filters.maxPrice, filters.rarity, filters.dateFrom, filters.dateTo])

  // Fetch paginated data
  const fetchData = useCallback(async () => {
    if (!supabase) {
      setError('Database connection not configured. Please check your settings.')
      setInitialLoad(false)
      return
    }

    setLoading(true)
    setError(null)

    try {
      const from = (currentPage - 1) * perPage
      const to = from + perPage - 1

      let query = supabase
        .from('auction_listings')
        .select('*', { count: 'exact' })

      query = applyFilters(query)
      query = query
        .order(sortColumn, { ascending: sortDirection === 'asc' })
        .range(from, to)

      const { data: rows, error: queryError, count } = await query

      if (queryError) throw queryError

      setData(rows || [])
      setTotalCount(count || 0)
    } catch (err) {
      console.error('Error fetching auction data:', err)
      setError(err.message || 'Failed to load auction data. Please try again.')
    } finally {
      setLoading(false)
      setInitialLoad(false)
    }
  }, [applyFilters, currentPage, perPage, sortColumn, sortDirection])

  // Fetch stats (separate query to get aggregates)
  const fetchStats = useCallback(async () => {
    if (!supabase) return

    setStatsLoading(true)

    try {
      // First get count
      let countQuery = supabase
        .from('auction_listings')
        .select('*', { count: 'exact', head: true })
      
      countQuery = applyFilters(countQuery)
      const { count, error: countError } = await countQuery
      
      if (countError) throw countError

      if (!count || count === 0) {
        setStats({ total: 0, avg: null, min: null, max: null, median: null })
        setStatsLoading(false)
        return
      }

      // For stats, we need to fetch prices - limit to reasonable amount for calculation
      let priceQuery = supabase
        .from('auction_listings')
        .select('price')
      
      priceQuery = applyFilters(priceQuery)
      
      // Fetch up to 50000 prices for stats calculation
      const { data: priceData, error: priceError } = await priceQuery.limit(50000)
      
      if (priceError) throw priceError

      const prices = (priceData || []).map(r => r.price).filter(p => p > 0)
      
      if (!prices.length) {
        setStats({ total: count, avg: null, min: null, max: null, median: null })
        setStatsLoading(false)
        return
      }

      const sum = prices.reduce((a, b) => a + b, 0)
      const sorted = [...prices].sort((a, b) => a - b)
      const median = sorted.length % 2 === 0
        ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
        : sorted[Math.floor(sorted.length / 2)]

      setStats({
        total: count,
        avg: Math.round(sum / prices.length),
        min: Math.min(...prices),
        max: Math.max(...prices),
        median: Math.round(median),
      })
    } catch (err) {
      console.error('Error fetching stats:', err)
    } finally {
      setStatsLoading(false)
    }
  }, [applyFilters])

  // Load data on mount and when dependencies change
  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Load stats when filters change
  useEffect(() => {
    fetchStats()
  }, [fetchStats])

  // Handle column sort
  function handleSort(col) {
    if (sortColumn === col) {
      setSortDirection(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortColumn(col)
      setSortDirection('desc')
    }
    setCurrentPage(1)
  }

  // Handle filter change
  function handleFilterChange(key, value) {
    setFilters(prev => ({ ...prev, [key]: value }))
  }

  // Clear all filters
  function clearFilters() {
    setFilters({
      itemType: '',
      itemSearch: '',
      minPrice: '',
      maxPrice: '',
      rarity: '',
      dateFrom: '',
      dateTo: '',
    })
  }

  // Toggle expanded row
  function toggleExpanded(auctionId) {
    setExpandedRows(prev => {
      const next = new Set(prev)
      if (next.has(auctionId)) {
        next.delete(auctionId)
      } else {
        next.add(auctionId)
      }
      return next
    })
  }

  // Check if any filters are active
  const hasActiveFilters = Object.values(filters).some(v => v !== '')

  const totalPages = Math.max(1, Math.ceil(totalCount / perPage))

  return (
    <div className="space-y-6">
      {/* Filters Card */}
      <div className="bg-white dark:bg-slate-800 rounded-lg shadow-sm border border-gray-200 dark:border-slate-700 p-4 sm:p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            Search Auctions
          </h2>
          {hasActiveFilters && (
            <button
              onClick={clearFilters}
              className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
            >
              Clear all filters
            </button>
          )}
        </div>
        
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Item Search */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Item Name or ID
            </label>
            <input
              type="text"
              className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              value={filters.itemSearch}
              onChange={e => handleFilterChange('itemSearch', e.target.value)}
              placeholder="Search by name or ID..."
            />
          </div>
          
          {/* Item Type */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Item Type
            </label>
            <select
              className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              value={filters.itemType}
              onChange={e => handleFilterChange('itemType', e.target.value)}
            >
              {ITEM_TYPES.map(type => (
                <option key={type.value} value={type.value}>{type.label}</option>
              ))}
            </select>
          </div>
          
          {/* Rarity */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Rarity
            </label>
            <select
              className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              value={filters.rarity}
              onChange={e => handleFilterChange('rarity', e.target.value)}
            >
              {RARITIES.map(r => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </div>
          
          {/* Price Range */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Price Range
            </label>
            <div className="flex gap-2">
              <input
                type="number"
                className="w-1/2 px-3 py-2 rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                value={filters.minPrice}
                onChange={e => handleFilterChange('minPrice', e.target.value)}
                placeholder="Min"
              />
              <input
                type="number"
                className="w-1/2 px-3 py-2 rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                value={filters.maxPrice}
                onChange={e => handleFilterChange('maxPrice', e.target.value)}
                placeholder="Max"
              />
            </div>
          </div>
          
          {/* Date From */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Date From
            </label>
            <input
              type="date"
              className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              value={filters.dateFrom}
              onChange={e => handleFilterChange('dateFrom', e.target.value)}
            />
          </div>
          
          {/* Date To */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Date To
            </label>
            <input
              type="date"
              className="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              value={filters.dateTo}
              onChange={e => handleFilterChange('dateTo', e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
        <div className="bg-white dark:bg-slate-800 rounded-lg shadow-sm border border-gray-200 dark:border-slate-700 p-4 text-center">
          <div className="text-2xl font-bold text-gray-900 dark:text-white">
            {statsLoading ? '...' : stats.total.toLocaleString()}
          </div>
          <div className="text-sm text-gray-500 dark:text-gray-400">Total Listings</div>
        </div>
        <div className="bg-white dark:bg-slate-800 rounded-lg shadow-sm border border-gray-200 dark:border-slate-700 p-4 text-center">
          <div className="text-2xl font-bold text-green-600 dark:text-green-400">
            {statsLoading ? '...' : (stats.avg ? formatPrice(stats.avg) : '-')}
          </div>
          <div className="text-sm text-gray-500 dark:text-gray-400">Average Price</div>
        </div>
        <div className="bg-white dark:bg-slate-800 rounded-lg shadow-sm border border-gray-200 dark:border-slate-700 p-4 text-center">
          <div className="text-2xl font-bold text-blue-600 dark:text-blue-400">
            {statsLoading ? '...' : (stats.median ? formatPrice(stats.median) : '-')}
          </div>
          <div className="text-sm text-gray-500 dark:text-gray-400">Median Price</div>
        </div>
        <div className="bg-white dark:bg-slate-800 rounded-lg shadow-sm border border-gray-200 dark:border-slate-700 p-4 text-center">
          <div className="text-2xl font-bold text-gray-900 dark:text-white">
            {statsLoading ? '...' : (stats.min ? formatPrice(stats.min) : '-')}
          </div>
          <div className="text-sm text-gray-500 dark:text-gray-400">Min Price</div>
        </div>
        <div className="bg-white dark:bg-slate-800 rounded-lg shadow-sm border border-gray-200 dark:border-slate-700 p-4 text-center">
          <div className="text-2xl font-bold text-gray-900 dark:text-white">
            {statsLoading ? '...' : (stats.max ? formatPrice(stats.max) : '-')}
          </div>
          <div className="text-sm text-gray-500 dark:text-gray-400">Max Price</div>
        </div>
      </div>

      {/* Results Table */}
      <div className="bg-white dark:bg-slate-800 rounded-lg shadow-sm border border-gray-200 dark:border-slate-700 overflow-hidden">
        {/* Table Header */}
        <div className="px-4 py-3 border-b border-gray-200 dark:border-slate-700 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div className="text-sm text-gray-600 dark:text-gray-400">
            {loading ? (
              'Loading...'
            ) : totalCount === 0 ? (
              'No results'
            ) : (
              <>
                Showing {((currentPage - 1) * perPage) + 1}-{Math.min(currentPage * perPage, totalCount)} of {totalCount.toLocaleString()} results
              </>
            )}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-500 dark:text-gray-400">Click a row to expand details</span>
            <label className="text-sm text-gray-600 dark:text-gray-400">Per page:</label>
            <select
              className="px-2 py-1 rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-900 dark:text-white text-sm"
              value={perPage}
              onChange={e => {
                setPerPage(parseInt(e.target.value, 10))
                setCurrentPage(1)
              }}
            >
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value={250}>250</option>
              <option value={500}>500</option>
            </select>
          </div>
        </div>

        {/* Error Message */}
        {error && (
          <div className="px-4 py-3 bg-red-50 dark:bg-red-900/20 border-b border-red-200 dark:border-red-800">
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          </div>
        )}

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-slate-700">
            <thead className="bg-gray-50 dark:bg-slate-700/50">
              <tr>
                {[
                  { key: 'timestamp', label: 'Date' },
                  { key: 'item_name', label: 'Item' },
                  { key: 'item_uid', label: 'UID' },
                  { key: 'item_type', label: 'Type' },
                  { key: 'price', label: 'Price' },
                  { key: 'bids', label: 'Bids' },
                  { key: 'seller_name', label: 'Seller' },
                  { key: 'buyer_name', label: 'Buyer' },
                ].map(col => (
                  <th
                    key={col.key}
                    className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700 select-none"
                    onClick={() => handleSort(col.key)}
                  >
                    <div className="flex items-center gap-1">
                      {col.label}
                      {sortColumn === col.key && (
                        <span className="text-blue-600 dark:text-blue-400">
                          {sortDirection === 'asc' ? ' \u2191' : ' \u2193'}
                        </span>
                      )}
                    </div>
                  </th>
                ))}
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Quality
                </th>
              </tr>
            </thead>
            <tbody className="bg-white dark:bg-slate-800 divide-y divide-gray-200 dark:divide-slate-700">
              {initialLoad || loading ? (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center">
                    <div className="flex flex-col items-center gap-2">
                      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
                      <span className="text-sm text-gray-500 dark:text-gray-400">Loading auction data...</span>
                    </div>
                  </td>
                </tr>
              ) : data.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center">
                    <div className="flex flex-col items-center gap-2">
                      <svg className="h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <span className="text-gray-500 dark:text-gray-400">No auctions found matching your filters</span>
                      {hasActiveFilters && (
                        <button
                          onClick={clearFilters}
                          className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
                        >
                          Clear all filters
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ) : (
                data.map(row => {
                  const quality = getQuality(row)
                  const isExpanded = expandedRows.has(row.auction_id)
                  const hasDetails = row.item_stats || row.item_bonuses
                  
                  return (
                    <Fragment key={row.auction_id}>
                      <tr 
                        className={`hover:bg-gray-50 dark:hover:bg-slate-700/50 transition-colors ${hasDetails ? 'cursor-pointer' : ''} ${isExpanded ? 'bg-blue-50 dark:bg-blue-900/20' : ''}`}
                        onClick={() => hasDetails && toggleExpanded(row.auction_id)}
                      >
                        <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400 whitespace-nowrap">
                          {formatDate(row.timestamp)}
                        </td>
                        <td className={`px-4 py-3 text-sm font-medium whitespace-nowrap ${getRarityClass(row.item_rarity)}`}>
                          <div className="flex items-center gap-2">
                            {row.item_name || 'Unknown'}
                            {hasDetails && (
                              <span className={`text-xs text-gray-400 transition-transform ${isExpanded ? 'rotate-90' : ''}`}>
                                {'\u25B6'}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 font-mono whitespace-nowrap">
                          {row.item_uid || '-'}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400 whitespace-nowrap">
                          {row.item_type || '-'}
                        </td>
                        <td className="px-4 py-3 text-sm font-semibold text-green-600 dark:text-green-400 whitespace-nowrap">
                          {formatPrice(row.price)}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400 whitespace-nowrap">
                          {row.bids ?? 0}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400 whitespace-nowrap">
                          {row.seller_name || 'Unknown'}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400 whitespace-nowrap">
                          {row.buyer_name || 'Unknown'}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400 whitespace-nowrap">
                          {quality || '-'}
                        </td>
                      </tr>
                      {isExpanded && <ExpandedRow row={row} />}
                    </Fragment>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="px-4 py-3 border-t border-gray-200 dark:border-slate-700 flex flex-col sm:flex-row items-center justify-between gap-3">
            <div className="text-sm text-gray-600 dark:text-gray-400">
              Page {currentPage} of {totalPages.toLocaleString()}
            </div>
            <div className="flex items-center gap-2">
              <button
                className="px-3 py-1.5 text-sm font-medium rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-slate-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                disabled={currentPage === 1}
                onClick={() => setCurrentPage(1)}
              >
                First
              </button>
              <button
                className="px-3 py-1.5 text-sm font-medium rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-slate-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                disabled={currentPage === 1}
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              >
                Previous
              </button>
              <button
                className="px-3 py-1.5 text-sm font-medium rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-slate-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                disabled={currentPage === totalPages}
                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
              >
                Next
              </button>
              <button
                className="px-3 py-1.5 text-sm font-medium rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-slate-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                disabled={currentPage === totalPages}
                onClick={() => setCurrentPage(totalPages)}
              >
                Last
              </button>
            </div>
          </div>
        )}
      </div>

      {/* API Info Card */}
      <div className="bg-white dark:bg-slate-800 rounded-lg shadow-sm border border-gray-200 dark:border-slate-700 p-4 sm:p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">
          API Access
        </h3>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          You can access this data programmatically using the Supabase REST API. Include the header <code className="bg-gray-100 dark:bg-slate-900 px-1 rounded text-xs">apikey: YOUR_ANON_KEY</code> in your requests.
        </p>
        <div className="space-y-3">
          <div>
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Get listings with pagination:</p>
            <code className="block text-xs bg-gray-100 dark:bg-slate-900 p-2 rounded overflow-x-auto text-gray-800 dark:text-gray-200">
              GET https://uyqkwxopbsoeukfbvsap.supabase.co/rest/v1/auction_listings?limit=100&offset=0
            </code>
          </div>
          <div>
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Filter by item type:</p>
            <code className="block text-xs bg-gray-100 dark:bg-slate-900 p-2 rounded overflow-x-auto text-gray-800 dark:text-gray-200">
              GET https://uyqkwxopbsoeukfbvsap.supabase.co/rest/v1/auction_listings?item_type=eq.Primary
            </code>
          </div>
          <div>
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Search by item name:</p>
            <code className="block text-xs bg-gray-100 dark:bg-slate-900 p-2 rounded overflow-x-auto text-gray-800 dark:text-gray-200">
              GET https://uyqkwxopbsoeukfbvsap.supabase.co/rest/v1/auction_listings?item_name=ilike.*M4A1*
            </code>
          </div>
        </div>
      </div>
    </div>
  )
}