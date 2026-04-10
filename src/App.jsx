import { useState, useEffect } from 'react'
import { HashRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom'
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
import DashboardView from './views/DashboardView'
import WarHistoryView from './views/WarHistoryView'
import WarPayoutManagement from './components/WarPayoutManagement'
import { isAdmin } from './config'


// Public layout for unauthenticated pages
function PublicLayout({ children }) {
  return (
    <ThemeProvider>
      <div className="min-h-screen bg-gray-50 dark:bg-slate-900">
        {children}
      </div>
    </ThemeProvider>
  )
}



// Protected dashboard content
function DashboardContent() {
  const { isAuthenticated, isLeadership, user, loading: authLoading } = useAuth()
  const navigate = useNavigate()
  const [activeTab, setActiveTab] = useState('dashboard')
  
  // View As feature for admins - null means normal view
  const [viewAsRole, setViewAsRole] = useState(null)

  // Actual permissions (for functionality that must be restricted)
  const userIsAdmin = isAdmin(user?.id)
  
  // Effective permissions (for UI display, affected by viewAsRole)
  const effectiveIsAdmin = viewAsRole === null ? userIsAdmin : viewAsRole === 'admin'
  const effectiveIsLeadership = viewAsRole === null 
    ? isLeadership 
    : (viewAsRole === 'leadership' || viewAsRole === 'admin')

  // Navigation tabs
  const tabs = [
    { id: 'dashboard', label: 'Dashboard', roles: ['member', 'leadership'] },
    { id: 'members', label: 'Members', roles: ['member', 'leadership'] },
    { id: 'crimes', label: 'OC History', roles: ['member', 'leadership'] },
    { id: 'requirements', label: 'Tier Requirements', roles: ['member', 'leadership'] },
    { id: 'payouts', label: 'OC Payouts', roles: ['member', 'leadership'] },
    { id: 'payout-mgmt', label: 'OC Payout Management', roles: ['leadership'] },
    { id: 'war-history', label: 'War History', roles: ['member', 'leadership'] },
    { id: 'war-payout-mgmt', label: 'War Payout Management', roles: ['leadership'] },
    { id: 'tier-mgmt', label: 'Tier Management', roles: ['leadership'] },
    { id: 'inventory', label: 'Inventory', roles: ['leadership'] }
  ]

  const availableTabs = tabs.filter(tab => {
    if (tab.roles.includes('leadership') && !tab.roles.includes('member')) {
      return effectiveIsLeadership
    }
    return tab.roles.includes('member')
  })

  // Reset viewAsRole when user changes
  useEffect(() => {
    setViewAsRole(null)
  }, [user?.id])

  // Reset to members tab if current tab becomes unavailable due to viewAs change
  useEffect(() => {
    const tabIds = availableTabs.map(t => t.id)
    if (!tabIds.includes(activeTab) && activeTab !== 'data-mgmt') {
      setActiveTab('dashboard')
    }
  }, [viewAsRole, availableTabs, activeTab])

  // Show login if not authenticated
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

  const handleNavigate = (tab) => {
    setActiveTab(tab)
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-slate-900 transition-colors duration-200">
      <Header
        onNavigate={handleNavigate} 
        viewAsRole={viewAsRole}
        setViewAsRole={setViewAsRole}
        canViewAs={userIsAdmin}
      />
      
      {/* View As indicator banner */}
      {viewAsRole && (
        <div className="bg-yellow-100 dark:bg-yellow-900/30 border-b border-yellow-300 dark:border-yellow-700 px-4 py-2">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-between">
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
      
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-6">
        {/* <StatsOverview /> */}
        <Navigation 
          activeTab={activeTab} 
          onTabChange={setActiveTab}
          tabs={availableTabs}
        />
        <div className="mt-6">
          {/* Member-accessible views */}
          <ProtectedRoute>
            {activeTab === 'dashboard' && <DashboardView />}
            {activeTab === 'members' && <MembersView isLeadership={effectiveIsLeadership} />}
            {activeTab === 'crimes' && <CrimesView isLeadership={effectiveIsLeadership} />}
            {activeTab === 'requirements' && <TierRequirementsView />}
            {activeTab === 'payouts' && <PayoutsView isLeadership={effectiveIsLeadership} />}
            {activeTab === 'war-history' && <WarHistoryView isLeadership={effectiveIsLeadership} isAdmin={userIsAdmin} />}
          </ProtectedRoute>

          {/* Leadership-only views — only mount the guard when a leadership tab is active */}
          {['payout-mgmt', 'war-payout-mgmt', 'tier-mgmt', 'inventory'].includes(activeTab) && (
            <ProtectedRoute requireLeadership={true}>
              {activeTab === 'payout-mgmt' && <PayoutManagement />}
              {activeTab === 'war-payout-mgmt' && <WarPayoutManagement />}
              {activeTab === 'tier-mgmt' && <TierManagement />}
              {activeTab === 'inventory' && <InventoryManagement />}
            </ProtectedRoute>
          )}

          {/* Admin-only Data Management */}
          {userIsAdmin && activeTab === 'data-mgmt' && <DataManagement />}
        </div>
      </div>
    </div>
  )
}


// Protected dashboard wrapper
function ProtectedDashboard() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <ViewStateProvider>
          <DashboardContent />
        </ViewStateProvider>
      </AuthProvider>
    </ThemeProvider>
  )
}


// Main App with routing
export default function App() {
  return (
    <HashRouter>
      <Routes>
        {/* Protected routes - require authentication */}
        <Route path="/*" element={<ProtectedDashboard />} />
      </Routes>
    </HashRouter>
  )
}