import { lazy, Suspense } from 'react'
import { Routes, Route, Navigate, NavLink } from 'react-router-dom'
import RWPayoutsView from './RWPayoutsView'
import WarHistoryView from './WarHistoryView'
import WarPayoutManagement from '../components/WarPayoutManagement'
import WarRoomViewV2 from './WarRoomViewV2'
import ErrorBoundary from '../components/ErrorBoundary'

const WarOverviewView = lazy(() => import('./WarOverviewView'))

const TABS = [
  // v2 is now the canonical War Room. /rw/war-room-v2 redirects to /rw/war-room
  // so any bookmarks from the validation window still resolve.
  // `gate` is checked per-render against the auth flags passed into RWPage.
  // 'leadership' = leadership-only; 'warOverview' = leadership/admin/warlead.
  { to: '/rw/war-room',          label: 'War Room',           gate: null            },
  { to: '/rw/payouts',           label: 'Payouts',            gate: null            },
  { to: '/rw/rw-history',        label: 'RW History',         gate: null            },
  { to: '/rw/payout-management', label: 'Payout Management',  gate: 'leadership'    },
  { to: '/rw/war-overview',      label: 'War Overview',       gate: 'warOverview'   },
]

const tabClass = ({ isActive }) =>
  `px-4 py-2 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
    isActive
      ? 'border-blue-600 text-blue-600 dark:text-blue-400 dark:border-blue-400'
      : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300 dark:hover:border-slate-600'
  }`

export default function RWPage({ isLeadership, isAdmin, canAccessWarOverview }) {
  const tabPasses = (gate) => {
    if (gate === null) return true
    if (gate === 'leadership') return isLeadership
    if (gate === 'warOverview') return !!canAccessWarOverview
    return false
  }
  const visibleTabs = TABS.filter(t => tabPasses(t.gate))

  return (
    <div className="space-y-6">
      <div className="flex gap-1 overflow-x-auto border-b border-gray-200 dark:border-slate-700">
        {visibleTabs.map(tab => (
          <NavLink key={tab.to} to={tab.to} className={tabClass}>{tab.label}</NavLink>
        ))}
      </div>

      <Routes>
        <Route index element={<Navigate to="/rw/war-room" replace />} />
        <Route path="war-room" element={
          <ErrorBoundary name="War Room">
            <WarRoomViewV2 isLeadership={isLeadership} isAdmin={isAdmin} />
          </ErrorBoundary>
        } />
        {/* Legacy validation route — redirect bookmarks to the canonical path. */}
        <Route path="war-room-v2" element={<Navigate to="/rw/war-room" replace />} />
        <Route path="payouts"   element={<RWPayoutsView />} />
        <Route path="rw-history" element={<WarHistoryView isLeadership={isLeadership} isAdmin={isAdmin} />} />
        {isLeadership && <Route path="payout-management" element={<WarPayoutManagement />} />}
        {canAccessWarOverview && <Route path="war-overview" element={
          <ErrorBoundary name="War Overview">
            <Suspense fallback={
              <div className="card flex items-center gap-3 text-sm text-gray-500 dark:text-gray-400">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600" />
                Loading charting library…
              </div>
            }>
              <WarOverviewView />
            </Suspense>
          </ErrorBoundary>
        } />}
        <Route path="*" element={<Navigate to="/rw/war-room" replace />} />
      </Routes>
    </div>
  )
}
