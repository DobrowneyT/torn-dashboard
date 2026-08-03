import { Routes, Route, Navigate, NavLink } from 'react-router-dom'
import InventoryManagement from '../components/InventoryManagement'
import DataManagement from './DataManagement'
import MemberOverview from './MemberOverview'
import FactionSettingsView from './FactionSettingsView'
import GlobalAdminView from './GlobalAdminView'
import ErrorBoundary from '../components/ErrorBoundary'
import { API_MODE } from '../utils/apiClient'

// Settings + Global Admin ride the new API stack only (slice #74); the
// Supabase deployment keeps config.js-driven behavior until cutover.
const TABS = [
  { to: '/leadership/member-overview',   label: 'Member Overview', admin: false },
  { to: '/leadership/inventory',         label: 'Inventory',       admin: false },
  { to: '/leadership/settings',          label: 'Settings',        admin: false, apiOnly: true },
  { to: '/leadership/data-management',   label: 'Data Management', admin: true  },
  { to: '/leadership/global-admin',      label: 'Global Admin',    admin: true,  apiOnly: true },
]

const tabClass = ({ isActive }) =>
  `px-4 py-2 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
    isActive
      ? 'border-blue-600 text-blue-600 dark:text-blue-400 dark:border-blue-400'
      : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300 dark:hover:border-slate-600'
  }`

export default function LeadershipPage({ isLeadership, isAdmin }) {
  const visibleTabs = TABS.filter(t => (!t.admin || isAdmin) && (!t.apiOnly || API_MODE))

  return (
    <div className="space-y-6">
      <div className="flex gap-1 overflow-x-auto border-b border-gray-200 dark:border-slate-700">
        {visibleTabs.map(tab => (
          <NavLink key={tab.to} to={tab.to} className={tabClass}>{tab.label}</NavLink>
        ))}
      </div>

      <Routes>
        <Route index element={<Navigate to="/leadership/member-overview" replace />} />
        <Route path="member-overview" element={
          <ErrorBoundary name="Member Overview">
            <MemberOverview isLeadership={isLeadership} isAdmin={isAdmin} />
          </ErrorBoundary>
        } />
        <Route path="inventory"       element={<InventoryManagement />} />
        {API_MODE && <Route path="settings" element={
          <ErrorBoundary name="Faction Settings">
            <FactionSettingsView />
          </ErrorBoundary>
        } />}
        {isAdmin && <Route path="data-management" element={<DataManagement />} />}
        {isAdmin && API_MODE && <Route path="global-admin" element={
          <ErrorBoundary name="Global Admin">
            <GlobalAdminView />
          </ErrorBoundary>
        } />}
        <Route path="*" element={<Navigate to="/leadership/member-overview" replace />} />
      </Routes>
    </div>
  )
}
