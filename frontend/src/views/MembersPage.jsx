// Members page tab shell (mirrors OCPage / RWPage): an Overview tab with the
// roster + tier distribution, and a Competitions tab.
import { Routes, Route, Navigate, NavLink } from 'react-router-dom'
import MembersView from './MembersView'
import CompetitionsSection from '../components/CompetitionsSection'
import CalendarSection from '../components/calendar/CalendarSection'
import UpgradesSection from '../components/upgrades/UpgradesSection'
import HofSection from '../components/hof/HofSection'
import GrudgesSection from '../components/grudges/GrudgesSection'

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
    // #458 — faction standing state, not per-member, but this tab group is
    // where faction-wide surfaces live (Competitions and Calendar are not about
    // individual members either). Read-only and open to everyone.
    { to: '/members/upgrades', label: 'Upgrades' },
    // #872 — a bragging-rights board, open to everyone.
    { to: '/members/hall-of-fame', label: 'Hall of Fame' },
    // #889 — a perpetual shared target list for chaining. Sits here rather
    // than under an event page because the list deliberately outlives any one
    // chain, and this group already holds the faction-wide surfaces.
    { to: '/members/grudges', label: 'Book of Grudges' },
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
        {/* #969 — Chain Watch moved to the event page. Kept as a redirect:
            the bot's sign-up link and old bookmarks still point here. */}
        <Route path="chain-watch" element={<Navigate to="/events/chain-watch" replace />} />
        <Route path="upgrades" element={<UpgradesSection />} />
        <Route path="hall-of-fame" element={<HofSection />} />
        <Route path="grudges" element={<GrudgesSection isLeadership={isLeadership} />} />
        <Route path="*" element={<Navigate to="/members/overview" replace />} />
      </Routes>
    </div>
  )
}
