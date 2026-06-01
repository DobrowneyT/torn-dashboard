import { Routes, Route, Navigate, NavLink } from 'react-router-dom'
import PayoutsView from './PayoutsView'
import CrimesView from './CrimesView'
import TierRequirementsView from './TierRequirementsView'
import PayoutManagement from '../components/PayoutManagement'
import TierManagement from '../components/TierManagement'

const TABS = [
  { to: '/oc/payouts',           label: 'Payouts',           leadership: false },
  { to: '/oc/oc-history',        label: 'OC History',        leadership: false },
  { to: '/oc/tier-requirements', label: 'Tier Requirements', leadership: false },
  { to: '/oc/payout-management', label: 'Payout Management', leadership: true  },
  { to: '/oc/tier-management',   label: 'Tier Management',   leadership: true  },
]

const tabClass = ({ isActive }) =>
  `px-4 py-2 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
    isActive
      ? 'border-blue-600 text-blue-600 dark:text-blue-400 dark:border-blue-400'
      : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300 dark:hover:border-slate-600'
  }`

export default function OCPage({ isLeadership }) {
  const visibleTabs = TABS.filter(t => !t.leadership || isLeadership)

  return (
    <div className="space-y-6">
      <div className="flex gap-1 overflow-x-auto border-b border-gray-200 dark:border-slate-700">
        {visibleTabs.map(tab => (
          <NavLink key={tab.to} to={tab.to} className={tabClass}>{tab.label}</NavLink>
        ))}
      </div>

      <Routes>
        <Route index element={<Navigate to="/oc/payouts" replace />} />
        <Route path="payouts"           element={<PayoutsView isLeadership={isLeadership} />} />
        <Route path="oc-history"        element={<CrimesView isLeadership={isLeadership} />} />
        <Route path="tier-requirements" element={<TierRequirementsView />} />
        {isLeadership && <Route path="payout-management" element={<PayoutManagement />} />}
        {isLeadership && <Route path="tier-management"   element={<TierManagement />} />}
        <Route path="*" element={<Navigate to="/oc/payouts" replace />} />
      </Routes>
    </div>
  )
}
