import { useState } from 'react'

export default function Navigation({ activeTab, onTabChange, tabs }) {
  const [mobileOpen, setMobileOpen] = useState(false)

  const handleTabChange = (id) => {
    onTabChange(id)
    setMobileOpen(false)
  }

  const activeLabel = tabs.find(t => t.id === activeTab)?.label || 'Menu'

  return (
    <nav className="mt-6">
      {/* Mobile: hamburger button showing current tab */}
      <div className="md:hidden card p-3 flex items-center justify-between">
        <span className="font-medium text-sm text-gray-700 dark:text-gray-300">
          {activeLabel}
        </span>
        <button
          onClick={() => setMobileOpen(!mobileOpen)}
          className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors"
          aria-label="Toggle navigation menu"
        >
          {mobileOpen ? (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          ) : (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          )}
        </button>
      </div>

      {/* Mobile: dropdown menu */}
      {mobileOpen && (
        <div className="md:hidden card mt-2 p-2 space-y-1">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => handleTabChange(tab.id)}
              className={`w-full text-left px-4 py-3 rounded-lg font-medium transition-all ${
                activeTab === tab.id
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-700'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}

      {/* Desktop: horizontal tab row */}
      <div className="hidden md:block card p-2">
        <div className="flex gap-2 overflow-x-auto">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              className={`px-4 py-2 rounded-lg font-medium transition-all whitespace-nowrap ${
                activeTab === tab.id
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-700'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>
    </nav>
  )
}
