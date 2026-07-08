import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import { Menu, X } from 'lucide-react'

const TABS = [
  { to: '/',            label: 'Dashboard', end: true },
  { to: '/members',     label: 'Members' },
  { to: '/oc',          label: 'OC' },
  { to: '/rw',          label: 'RW' },
  { to: '/leadership',  label: 'Leadership', requiresLeadership: true },
]

export default function Navigation({ isLeadership }) {
  const [mobileOpen, setMobileOpen] = useState(false)

  const visibleTabs = TABS.filter(t => !t.requiresLeadership || isLeadership)

  const linkClass = ({ isActive }) =>
    `px-4 py-2 rounded-lg font-medium transition-all whitespace-nowrap ${
      isActive
        ? 'bg-blue-600 text-white shadow-sm'
        : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-700'
    }`

  const mobileLinkClass = ({ isActive }) =>
    `w-full text-left px-4 py-3 rounded-lg font-medium transition-all block ${
      isActive
        ? 'bg-blue-600 text-white shadow-sm'
        : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-700'
    }`

  return (
    <nav className="mt-6">
      {/* Mobile: hamburger */}
      <div className="md:hidden card p-3 flex items-center justify-between">
        <span className="font-medium text-sm text-gray-700 dark:text-gray-300">Menu</span>
        <button
          onClick={() => setMobileOpen(!mobileOpen)}
          className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors"
          aria-label="Toggle navigation menu"
        >
          {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>
      </div>

      {mobileOpen && (
        <div className="md:hidden card mt-2 p-2 space-y-1">
          {visibleTabs.map(tab => (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.end}
              className={mobileLinkClass}
              onClick={() => setMobileOpen(false)}
            >
              {tab.label}
            </NavLink>
          ))}
        </div>
      )}

      {/* Desktop: horizontal tab row */}
      <div className="hidden md:block card p-2">
        <div className="flex gap-2 overflow-x-auto">
          {visibleTabs.map(tab => (
            <NavLink key={tab.to} to={tab.to} end={tab.end} className={linkClass}>
              {tab.label}
            </NavLink>
          ))}
        </div>
      </div>
    </nav>
  )
}
