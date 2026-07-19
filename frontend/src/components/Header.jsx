import { useEffect } from 'react'
import { useTheme } from '../contexts/ThemeContext'
import { useAuth } from '../contexts/AuthContext'
import SettingsDropdown from '../components/SettingsDropdown'
import { useFactionIdentity, faviconHrefFor } from '../utils/factionIdentity'

import { Moon, Sun } from 'lucide-react'

export default function Header({ viewAsRole, setViewAsRole, canViewAs }) {
  const { theme, toggleTheme } = useTheme()
  const { user, logout, isLeadership } = useAuth()
  const faction = useFactionIdentity()

  // Browser tab follows the tenant's display name (#97).
  useEffect(() => {
    if (faction.displayName) document.title = `${faction.displayName} Dashboard`
  }, [faction.displayName])

  // Favicon follows the tenant's own branding.favicon (Leadership -> Settings),
  // falling back to the shared default (#131).
  useEffect(() => {
    const link = document.querySelector('link[rel="icon"]')
    if (link) link.href = faviconHrefFor(faction)
  }, [faction.branding?.favicon])

  return (
    <header className="bg-white dark:bg-slate-800 border-b border-gray-200 dark:border-slate-700">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl sm:text-2xl lg:text-3xl font-bold text-gray-900 dark:text-white">{faction.displayName} Dashboard</h1>
            <p className="text-xs sm:text-sm text-gray-600 dark:text-gray-400 mt-0.5 sm:mt-1">
              {faction.name} - Performance Tracking
            </p>
          </div>

          <div className="flex items-center gap-4">
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

            {user && (
              <SettingsDropdown
                viewAsRole={viewAsRole}
                setViewAsRole={setViewAsRole}
                canViewAs={canViewAs}
              />
            )}

            <button
              onClick={toggleTheme}
              className="p-2 rounded-lg border border-gray-300 dark:border-slate-600 hover:bg-gray-100 dark:hover:bg-slate-700"
            >
              {theme === 'light' ? (
                <Moon className="w-5 h-5" />
              ) : (
                <Sun className="w-5 h-5" />
              )}
            </button>
          </div>
        </div>
      </div>
    </header>
  )
}