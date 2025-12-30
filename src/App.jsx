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
import { config } from './config'

function AppContent() {
  const { isAuthenticated, isLeadership, loading: authLoading } = useAuth()
  const [activeTab, setActiveTab] = useState('members')
  const [cprData, setCprData] = useState(null)
  const [crimesData, setCrimesData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    // Only load data if authenticated
    if (isAuthenticated) {
      loadData()
    }
  }, [isAuthenticated])

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

  // Show login modal if not authenticated
  if (!isAuthenticated && !authLoading) {
    return <LoginModal />
  }

  // Show loading state while checking authentication
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

  // Define navigation tabs based on user role
  const tabs = [
    { id: 'members', label: 'Member Tiers', roles: ['member', 'leadership'] },
    { id: 'crimes', label: 'Crime History', roles: ['member', 'leadership'] },
    { id: 'requirements', label: 'Tier Requirements', roles: ['member', 'leadership'] },
    { id: 'payouts', label: 'Payout History', roles: ['member', 'leadership'] },
    { id: 'payout-mgmt', label: 'Payout Management', roles: ['leadership'] },
    { id: 'tier-mgmt', label: 'Tier Management', roles: ['leadership'] },
    { id: 'inventory', label: 'Inventory', roles: ['leadership'] }
  ]

  const availableTabs = tabs.filter(tab => 
    tab.roles.includes('member') || (isLeadership && tab.roles.includes('leadership'))
  )

  return (
    <div className="min-h-screen">
      <Header />
      <div className="max-w-7xl mx-auto px-4 py-6">
        <StatsOverview cprData={cprData} crimesData={crimesData} />
        <Navigation 
          activeTab={activeTab} 
          onTabChange={setActiveTab}
          tabs={availableTabs}
        />
        <div className="mt-6">
          <ProtectedRoute>
            {activeTab === 'members' && <MembersView cprData={cprData} crimesData={crimesData} />}
            {activeTab === 'crimes' && <CrimesView crimesData={crimesData} />}
            {activeTab === 'requirements' && <TierRequirementsView />}
            {activeTab === 'payouts' && <PayoutsView cprData={cprData} crimesData={crimesData} />}
          </ProtectedRoute>

          <ProtectedRoute requireLeadership={true}>
            {activeTab === 'payout-mgmt' && <PayoutManagement cprData={cprData} crimesData={crimesData} />}
            {activeTab === 'tier-mgmt' && <TierManagement cprData={cprData} />}
            {activeTab === 'inventory' && <InventoryManagement />}
          </ProtectedRoute>
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