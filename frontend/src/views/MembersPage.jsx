// Members page tab shell (mirrors OCPage / RWPage): an Overview tab with the
// roster + tier distribution, and a Competitions tab.
import { Routes, Route, Navigate, NavLink } from 'react-router-dom'
import MembersView from './MembersView'
import CompetitionsSection from '../components/CompetitionsSection'
import CalendarSection from '../components/calendar/CalendarSection'
import ChainWatchSection from '../components/chainWatch/ChainWatchSection'

const tabClass = ({ isActive }) =>
  `px-4 py-2 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
    isActive
      ? 'border-blue-600 text-blue-600 dark:text-blue-400 dark:border-blue-400'
      : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300 dark:hover:border-slate-600'
  }`

export default function MembersPage({ isLeadership }) {
  const tabs = [
    { to: '/members/overview', label: 'Overview' },
    { to: '/members/competitions', label: 'Competitions' },
    { to: '/members/calendar', label: 'Calendar' },
    { to: '/members/chain-watch', label: 'Chain Watch' },
  ]

  return (
    <div className="space-y-6">
      <div className="flex gap-1 overflow-x-auto border-b border-gray-200 dark:border-slate-700">
        {tabs.map((tab) => (
          <NavLink key={tab.to} to={tab.to} className={tabClass}>{tab.label}</NavLink>
        ))}
      </div>

      <Routes>
        <Route index element={<Navigate to="/members/overview" replace />} />
        <Route path="overview" element={<MembersView isLeadership={isLeadership} />} />
        <Route path="competitions" element={<CompetitionsSection isLeadership={isLeadership} />} />
        <Route path="calendar" element={<CalendarSection isLeadership={isLeadership} />} />
        <Route path="chain-watch" element={<ChainWatchSection isLeadership={isLeadership} />} />
        <Route path="*" element={<Navigate to="/members/overview" replace />} />
      </Routes>
    </div>
  )
}
