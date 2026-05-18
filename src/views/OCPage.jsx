import { useState } from 'react'
import PayoutsView from './PayoutsView'
import CrimesView from './CrimesView'
import TierRequirementsView from './TierRequirementsView'
import PayoutManagement from '../components/PayoutManagement'
import TierManagement from '../components/TierManagement'

const TABS = [
  { id: 'payouts', label: 'Payouts', roles: ['member'] },
  { id: 'oc-history', label: 'OC History', roles: ['member'] },
  { id: 'tier-requirements', label: 'Tier Requirements', roles: ['member'] },
  { id: 'payout-mgmt', label: 'Payout Management', roles: ['leadership'] },
  { id: 'tier-mgmt', label: 'Tier Management', roles: ['leadership'] },
]

export default function OCPage({ isLeadership }) {
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
      {activeTab === 'payouts' && <PayoutsView isLeadership={isLeadership} />}
      {activeTab === 'oc-history' && <CrimesView isLeadership={isLeadership} />}
      {activeTab === 'tier-requirements' && <TierRequirementsView />}
      {activeTab === 'payout-mgmt' && isLeadership && <PayoutManagement />}
      {activeTab === 'tier-mgmt' && isLeadership && <TierManagement />}
    </div>
  )
}
