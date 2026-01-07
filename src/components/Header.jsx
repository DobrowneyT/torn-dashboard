import { useTheme } from '../contexts/ThemeContext'
import { useAuth } from '../contexts/AuthContext'
import SettingsDropdown from '../components/SettingsDropdown'
import { config } from '../config'

export default function Header() {
  const { theme, toggleTheme } = useTheme()
  const { user, logout, isLeadership } = useAuth()

  return (
    <header className="bg-white dark:bg-slate-800 border-b border-gray-200 dark:border-slate-700">
      <div className="max-w-7xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">Torn Forge OC Dashboard</h1>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
              {config.faction.name} • Performance Tracking
            </p>
          </div>
          
          <div className="flex items-center gap-4">
            {/* User Info */}
            {user && (
              <div className="hidden md:block text-right">
                <div className="font-semibold text-sm">{user.name}</div>
                <div className="text-xs text-gray-600 dark:text-gray-400">
                  {user.factionPosition}
                  {isLeadership && (
                    <span className="ml-2 px-2 py-0.5 bg-purple-600 text-white rounded text-xs">
                      Leadership
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Settings Dropdown */}
            {user && (
              <SettingsDropdown />
            )}

            {/* Theme Toggle */}
            <button
              onClick={toggleTheme}
              className="p-2 rounded-lg border border-gray-300 dark:border-slate-600 hover:bg-gray-100 dark:hover:bg-slate-700"
            >
              {theme === 'light' ? (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                </svg>
              ) : (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>
    </header>
  )
}