import { useState, lazy, Suspense } from 'react'
import RWPayoutsView from './RWPayoutsView'
import WarHistoryView from './WarHistoryView'
import WarPayoutManagement from '../components/WarPayoutManagement'
import WarRoomView from './WarRoomView'
import ErrorBoundary from '../components/ErrorBoundary'

// Lazy-loaded because it pulls in Plotly (~1.7 MB gzipped on its own). Splitting
// keeps the rest of the app fast — Plotly only downloads when leadership
// actually opens the War Overview tab.
const WarOverviewView = lazy(() => import('./WarOverviewView'))

const TABS = [
  { id: 'payouts', label: 'Payouts', roles: ['member'] },
  { id: 'rw-history', label: 'RW History', roles: ['member'] },
  { id: 'war-room', label: 'War Room', roles: ['member'] },
  { id: 'payout-mgmt', label: 'Payout Management', roles: ['leadership'] },
  { id: 'war-overview', label: 'War Overview', roles: ['leadership'] },
]

export default function RWPage({ isLeadership, isAdmin }) {
  const [activeTab, setActiveTab] = useState('payouts')

  const visibleTabs = TABS.filter(tab => {
    if (tab.roles.includes('leadership') && !isLeadership) return false
    return true
  })

  return (
    <div className="space-y-6">
      {/* Sub-tab navigation */}
      <div className="flex gap-1 overflow-x-auto border-b border-gray-200 dark:border-slate-700">
        {visibleTabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
              activeTab === tab.id
                ? 'border-blue-600 text-blue-600 dark:text-blue-400 dark:border-blue-400'
                : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300 dark:hover:border-slate-600'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'payouts' && <RWPayoutsView />}
      {activeTab === 'rw-history' && <WarHistoryView isLeadership={isLeadership} isAdmin={isAdmin} />}
      {activeTab === 'war-room' && (
        <ErrorBoundary name="War Room">
          <WarRoomView isLeadership={isLeadership} isAdmin={isAdmin} />
        </ErrorBoundary>
      )}
      {activeTab === 'payout-mgmt' && isLeadership && <WarPayoutManagement />}
      {activeTab === 'war-overview' && isLeadership && (
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
      )}
    </div>
  )
}
