import { useEffect, useState } from 'react'
import { HashRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom'
import { ThemeProvider } from './contexts/ThemeContext'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { ViewStateProvider } from './contexts/ViewStateContext'
import LoginModal from './components/LoginModal'
import ProtectedRoute from './components/ProtectedRoute'
import ViewErrorBoundary from './components/ViewErrorBoundary'
import Header from './components/Header'
import Navigation from './components/Navigation'
import MembersView from './views/MembersView'
import DashboardView from './views/DashboardView'
import OCPage from './views/OCPage'
import RWPage from './views/RWPage'
import LeadershipPage from './views/LeadershipPage'
import { isAdmin, isOCManager } from './config'
import Footer from './components/Footer'
import RollCallReminderBanner from './components/warroom/RollCallReminderBanner'


function DashboardLayout() {
  const { isAuthenticated, isLeadership, isWarLead, isVisitor, user, loading: authLoading } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  const [viewAsRole, setViewAsRole] = useState(null)

  // API mode: role flags come from the session claims (role_assignments,
  // managed per faction in Settings). config.js lists are the legacy
  // Supabase-mode fallback only.
  const userIsAdmin = user?.isAdmin ?? isAdmin(user?.id)
  const userIsOCManager = user?.isOCManager ?? isOCManager(user?.id)

  const effectiveIsAdmin = viewAsRole === null ? userIsAdmin : viewAsRole === 'admin'
  // Visitors (read-only demo) see the full leadership layout — every write
  // path is disabled separately (adminApi latch + per-control gating), and
  // the admin-only Data Management page stays gated on real admin.
  // Admin implies the leadership surface (#99): the server already treats
  // admin ⊇ leadership on every guard; the operator's admin-only session
  // (e.g. on another tenant) must reach Settings/Global Admin here too.
  const effectiveIsLeadership = viewAsRole === null
    ? (isLeadership || isVisitor || userIsAdmin)
    : (viewAsRole === 'leadership' || viewAsRole === 'admin')
  // War Overview is broader than leadership — warleads + admins also get it,
  // and any "view as" role of leadership/admin re-grants it.
  const effectiveCanAccessWarOverview = viewAsRole === null
    ? (isLeadership || userIsAdmin || isWarLead || isVisitor)
    : (viewAsRole === 'leadership' || viewAsRole === 'admin' || viewAsRole === 'warlead')
  // OC Planner is for OC Managers, plus leadership/admins as a superset.
  const effectiveCanAccessOCPlanner = viewAsRole === null
    ? (isLeadership || userIsAdmin || userIsOCManager || isVisitor)
    : (viewAsRole === 'leadership' || viewAsRole === 'admin' || viewAsRole === 'ocmanager')

  // Reset viewAsRole when user changes
  useEffect(() => { setViewAsRole(null) }, [user?.id])

  // If viewAs drops leadership and we're on a leadership-only route, go home.
  // War Overview is special-cased because it's available to warleads too —
  // only redirect there when the user doesn't meet the broader access set.
  useEffect(() => {
    const leadershipPaths = ['/leadership', '/rw/payout-management',
      '/oc/payout-management', '/oc/tier-management']
    if (!effectiveIsLeadership && leadershipPaths.some(p => location.pathname.startsWith(p))) {
      navigate('/', { replace: true })
    }
    if (!effectiveCanAccessWarOverview && location.pathname.startsWith('/rw/war-overview')) {
      navigate('/', { replace: true })
    }
    if (!effectiveCanAccessOCPlanner && location.pathname.startsWith('/oc/oc-planner')) {
      navigate('/', { replace: true })
    }
  }, [effectiveIsLeadership, effectiveCanAccessWarOverview, effectiveCanAccessOCPlanner, location.pathname, navigate])

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4" />
          <p className="text-gray-600 dark:text-gray-400">Checking authentication...</p>
        </div>
      </div>
    )
  }

  if (!isAuthenticated) return <LoginModal />

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-slate-900 transition-colors duration-200 flex flex-col overflow-x-hidden">
      <Header viewAsRole={viewAsRole} setViewAsRole={setViewAsRole} canViewAs={userIsAdmin} />

      <RollCallReminderBanner />

      {isVisitor && (
        <div className="bg-indigo-100 dark:bg-indigo-900/30 border-b border-indigo-300 dark:border-indigo-700 px-4 py-2">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <span className="text-sm text-indigo-800 dark:text-indigo-200">
              <strong>Visitor mode</strong> — you have full view access, but saving to the database is disabled.
            </span>
          </div>
        </div>
      )}

      {viewAsRole && (
        <div className="bg-yellow-100 dark:bg-yellow-900/30 border-b border-yellow-300 dark:border-yellow-700 px-4 py-2">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-between">
            <span className="text-sm text-yellow-800 dark:text-yellow-200">
              Viewing as: <strong className="capitalize">{viewAsRole}</strong>
            </span>
            <button onClick={() => setViewAsRole(null)} className="text-sm text-yellow-800 dark:text-yellow-200 hover:underline">
              Exit View As
            </button>
          </div>
        </div>
      )}

      <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-6">
        <Navigation isLeadership={effectiveIsLeadership} />
        <div className="mt-6">
          <ProtectedRoute>
            <ViewErrorBoundary pathname={location.pathname}>
              <Routes>
                <Route index element={<DashboardView />} />
                <Route path="members" element={<MembersView isLeadership={effectiveIsLeadership} />} />
                <Route path="oc/*" element={<OCPage isLeadership={effectiveIsLeadership} canAccessOCPlanner={effectiveCanAccessOCPlanner} />} />
                <Route path="rw/*" element={<RWPage isLeadership={effectiveIsLeadership} isAdmin={userIsAdmin} canAccessWarOverview={effectiveCanAccessWarOverview} />} />
                <Route path="leadership/*" element={
                  <ProtectedRoute requireLeadership>
                    <LeadershipPage isLeadership={effectiveIsLeadership} isAdmin={userIsAdmin} />
                  </ProtectedRoute>
                } />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </ViewErrorBoundary>
          </ProtectedRoute>
        </div>
      </div>
      <Footer />
    </div>
  )
}


export default function App() {
  return (
    <HashRouter>
      <ThemeProvider>
        <AuthProvider>
          <ViewStateProvider>
            <Routes>
              <Route path="/*" element={<DashboardLayout />} />
            </Routes>
          </ViewStateProvider>
        </AuthProvider>
      </ThemeProvider>
    </HashRouter>
  )
}
