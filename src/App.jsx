import { useState, useEffect } from 'react'
import { ThemeProvider } from './contexts/ThemeContext'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { ViewStateProvider } from './contexts/ViewStateContext'
import LoginModal from './components/LoginModal'
import ProtectedRoute from './components/ProtectedRoute'
import Header from './components/Header'
import StatsOverview from './components/StatsOverview'
import Navigation from './components/Navigation'
import MembersView from './views/MembersView'
import CrimesView from './views/CrimesView'
import TierRequirementsView from './views/TierRequirementsView'
import PayoutsView from './views/PayoutsView'
import PayoutManagement from './components/PayoutManagement'
import TierManagement from './components/TierManagement'
import InventoryManagement from './components/InventoryManagement'
import DataManagement from './views/DataManagement'
import { isAdmin } from './config'
import { config } from './config'

function AppContent() {
  const { isAuthenticated, isLeadership, user, loading: authLoading } = useAuth()
  const [activeTab, setActiveTab] = useState('members')
  const [cprData, setCprData] = useState(null)
  const [crimesData, setCrimesData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  
  // View As feature for admins - null means normal view
  const [viewAsRole, setViewAsRole] = useState(null)

  // Actual permissions (for functionality that must be restricted)
  const userIsAdmin = isAdmin(user?.id)
  
  // Effective permissions (for UI display, affected by viewAsRole)
  const effectiveIsAdmin = viewAsRole === null ? userIsAdmin : viewAsRole === 'admin'
  const effectiveIsLeadership = viewAsRole === null 
    ? isLeadership 
    : (viewAsRole === 'leadership' || viewAsRole === 'admin')

  // Navigation tabs - data-mgmt is NOT included here (accessed via hamburger menu only)
  const tabs = [
    { id: 'members', label: 'Member Tiers', roles: ['member', 'leadership'] },
    { id: 'crimes', label: 'OC 2.0 History', roles: ['member', 'leadership'] },
    { id: 'requirements', label: 'Tier Requirements', roles: ['member', 'leadership'] },
    { id: 'payouts', label: 'OC 2.0 Payouts', roles: ['member', 'leadership'] },
    { id: 'payout-mgmt', label: 'OC 2.0 Payout Management', roles: ['leadership'] },
    { id: 'tier-mgmt', label: 'Tier Management', roles: ['leadership'] },
    { id: 'inventory', label: 'Inventory', roles: ['leadership'] }
  ]

  const availableTabs = tabs.filter(tab => {
    if (tab.roles.includes('leadership') && !tab.roles.includes('member')) {
      return effectiveIsLeadership
    }
    return tab.roles.includes('member')
  })

  // Load data when authenticated
  useEffect(() => {
    if (isAuthenticated) {
      loadData()
    }
  }, [isAuthenticated])

  // Reset viewAsRole when user changes
  useEffect(() => {
    setViewAsRole(null)
  }, [user?.id])

  // Reset to members tab if current tab becomes unavailable due to viewAs change
  useEffect(() => {
    const tabIds = availableTabs.map(t => t.id)
    if (!tabIds.includes(activeTab) && activeTab !== 'data-mgmt') {
      setActiveTab('members')
    }
  }, [viewAsRole, availableTabs, activeTab])

  async function loadData() {
    try {
      setLoading(true)
      setError(null)

      const cprResponse = await fetch(config.dataSource.cprData)
      if (!cprResponse.ok) throw new Error('Failed to load CPR data')
      const cprJson = await cprResponse.json()
      setCprData(cprJson)

      try {
        const crimesResponse = await fetch(config.dataSource.crimesData)
        if (crimesResponse.ok) {
          const crimesJson = await crimesResponse.json()
          setCrimesData(crimesJson)
        } else {
          setCrimesData({ crimes: {} })
        }
      } catch {
        setCrimesData({ crimes: {} })
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  // Early returns AFTER all hooks
  if (!isAuthenticated && !authLoading) {
    return <LoginModal />
  }

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p className="text-gray-600 dark:text-gray-400">Checking authentication...</p>
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p className="text-gray-600 dark:text-gray-400">Loading data...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="card max-w-md">
          <h2 className="text-xl font-semibold text-red-600 mb-2">Error Loading Data</h2>
          <p className="text-gray-600 dark:text-gray-400 mb-4">{error}</p>
          <button onClick={loadData} className="btn-primary">Retry</button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen">
      <Header 
        onNavigate={setActiveTab} 
        viewAsRole={viewAsRole}
        setViewAsRole={setViewAsRole}
        canViewAs={userIsAdmin}
      />
      
      {/* View As indicator banner */}
      {viewAsRole && (
        <div className="bg-yellow-100 dark:bg-yellow-900/30 border-b border-yellow-300 dark:border-yellow-700 px-4 py-2">
          <div className="max-w-7xl mx-auto flex items-center justify-between">
            <span className="text-sm text-yellow-800 dark:text-yellow-200">
              Viewing as: <strong className="capitalize">{viewAsRole}</strong>
            </span>
            <button
              onClick={() => setViewAsRole(null)}
              className="text-sm text-yellow-800 dark:text-yellow-200 hover:underline"
            >
              Exit View As
            </button>
          </div>
        </div>
      )}
      
      <div className="max-w-7xl mx-auto px-4 py-6">
        <StatsOverview cprData={cprData} crimesData={crimesData} />
        <Navigation 
          activeTab={activeTab} 
          onTabChange={setActiveTab}
          tabs={availableTabs}
        />
        <div className="mt-6">
          {/* Member-accessible views */}
          <ProtectedRoute>
            {activeTab === 'members' && <MembersView cprData={cprData} crimesData={crimesData} />}
            {activeTab === 'crimes' && <CrimesView crimesData={crimesData} />}
            {activeTab === 'requirements' && <TierRequirementsView />}
            {activeTab === 'payouts' && <PayoutsView cprData={cprData} crimesData={crimesData} />}
          </ProtectedRoute>

          {/* Leadership-only views - use actual permissions, not effective */}
          <ProtectedRoute requireLeadership={true}>
            {activeTab === 'payout-mgmt' && <PayoutManagement cprData={cprData} crimesData={crimesData} />}
            {activeTab === 'tier-mgmt' && <TierManagement cprData={cprData} />}
            {activeTab === 'inventory' && <InventoryManagement />}
          </ProtectedRoute>

          {/* Admin-only Data Management - use actual permissions */}
          {userIsAdmin && activeTab === 'data-mgmt' && <DataManagement />}
        </div>
      </div>
    </div>
  )
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <ViewStateProvider>
          <AppContent />
        </ViewStateProvider>
      </AuthProvider>
    </ThemeProvider>
  )
}