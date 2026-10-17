import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import { Menu, X } from 'lucide-react'
import { eventIsVisible } from '../utils/factionEvent'

const TABS = [
  // ⚠️ /dashboard, not `/` — `/` redirects to the event while one is live (#969).
  { to: '/dashboard',   label: 'Dashboard' },
  { to: '/members',     label: 'Members' },
  { to: '/oc',          label: 'OC' },
  { to: '/rw',          label: 'RW' },
  { to: '/leadership',  label: 'Leadership', requiresLeadership: true },
]

export default function Navigation({ isLeadership, event }) {
  const [mobileOpen, setMobileOpen] = useState(false)

  const visibleTabs = TABS.filter(t => !t.requiresLeadership || isLeadership)
  // #969 — members see the event tab only while an event is upcoming or live,
  // in the event's own colour. ⚠️ Leadership ALWAYS see it ("Events" when
  // nothing is scheduled): Settings is where an event gets created, and a tab
  // that only appears once an event exists left them typing the URL.
  const showEvent = eventIsVisible(event)
  if (showEvent || isLeadership) {
    const at = visibleTabs.findIndex(t => t.requiresLeadership)
    visibleTabs.splice(at === -1 ? visibleTabs.length : at, 0, showEvent
      ? { to: '/events', label: event.name, color: event.theme_color }
      : { to: '/events', label: 'Events' })
  }
  const tabStyle = (tab, isActive) => tab.color
    ? (isActive
      ? { backgroundColor: tab.color, color: '#fff' }
      : { color: tab.color, boxShadow: `inset 0 0 0 1px ${tab.color}` })
    : undefined

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
              style={({ isActive }) => tabStyle(tab, isActive)}
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
            <NavLink key={tab.to} to={tab.to} end={tab.end} className={linkClass} style={({ isActive }) => tabStyle(tab, isActive)}>
              {tab.label}
            </NavLink>
          ))}
        </div>
      </div>
    </nav>
  )
}
