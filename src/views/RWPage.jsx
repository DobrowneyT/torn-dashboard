import { useState } from 'react'
import RWPayoutsView from './RWPayoutsView'
import WarHistoryView from './WarHistoryView'
import WarPayoutManagement from '../components/WarPayoutManagement'
import WarRoomView from './WarRoomView'
import ErrorBoundary from '../components/ErrorBoundary'

const TABS = [
  { id: 'payouts', label: 'Payouts', roles: ['member'] },
  { id: 'rw-history', label: 'RW History', roles: ['member'] },
  { id: 'war-room', label: 'War Room', roles: ['member'] },
  { id: 'payout-mgmt', label: 'Payout Management', roles: ['leadership'] },
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
          <WarRoomView isLeadership={isLeadership} />
        </ErrorBoundary>
      )}
      {activeTab === 'payout-mgmt' && isLeadership && <WarPayoutManagement />}
    </div>
  )
}
