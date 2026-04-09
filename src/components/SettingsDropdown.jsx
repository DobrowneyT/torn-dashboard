import { useState, useRef, useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { isAdmin } from '../config'

export default function SettingsDropdown({ onNavigate, viewAsRole, setViewAsRole, canViewAs }) {
  const { user, logout } = useAuth()
  const [isOpen, setIsOpen] = useState(false)
  const [showApiKeyModal, setShowApiKeyModal] = useState(false)
  const [showApiUsageModal, setShowApiUsageModal] = useState(false)
  const [showViewAsMenu, setShowViewAsMenu] = useState(false)
  const dropdownRef = useRef(null)

  useEffect(() => {
    function handleClickOutside(event) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsOpen(false)
        setShowViewAsMenu(false)
      }
    }
    
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handleLogout = () => {
    logout()
    setIsOpen(false)
  }

  const handleDataManagement = () => {
    if (onNavigate) {
      onNavigate('data-mgmt')
    }
    setIsOpen(false)
  }

  const handleApiKeyChange = () => {
    setShowApiKeyModal(true)
    setIsOpen(false)
  }

  const handleApiUsage = () => {
    setShowApiUsageModal(true)
    setIsOpen(false)
  }

  const handleViewAsSelect = (role) => {
    if (setViewAsRole) {
      setViewAsRole(role)
    }
    setShowViewAsMenu(false)
    setIsOpen(false)
  }

  const userIsAdmin = isAdmin(user?.id)

  return (
    <>
      <div className="relative" ref={dropdownRef}>
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors"
          aria-label="Settings"
        >
          <svg 
            className="w-6 h-6 text-gray-700 dark:text-gray-300" 
            fill="none" 
            stroke="currentColor" 
            viewBox="0 0 24 24"
          >
            <path 
              strokeLinecap="round" 
              strokeLinejoin="round" 
              strokeWidth={2} 
              d="M4 6h16M4 12h16M4 18h16" 
            />
          </svg>
        </button>

        {isOpen && (
          <div className="absolute right-0 mt-2 w-56 bg-white dark:bg-slate-800 rounded-lg shadow-lg border border-gray-200 dark:border-slate-700 overflow-hidden z-50">
            {/* User Info */}
            <div className="px-4 py-3 border-b border-gray-200 dark:border-slate-700">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {user?.name}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                ID: {user?.id}
              </p>
              {userIsAdmin && (
                <span className="inline-block mt-1 px-2 py-0.5 text-xs font-semibold bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400 rounded">
                  Admin
                </span>
              )}
            </div>

            {/* Menu Items */}
            <div className="py-1">
              <button
                onClick={handleApiKeyChange}
                className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-700 flex items-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                </svg>
                Change API Key
              </button>

              <button
                onClick={handleApiUsage}
                className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-700 flex items-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                API Key Usage
              </button>

              {/* View As option - only for admins */}
              {canViewAs && (
                <div className="relative">
                  <button
                    onClick={() => setShowViewAsMenu(!showViewAsMenu)}
                    className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-700 flex items-center justify-between"
                  >
                    <span className="flex items-center gap-2">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                      </svg>
                      View As
                    </span>
                    <svg className={`w-4 h-4 transition-transform ${showViewAsMenu ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </button>
                  
                  {showViewAsMenu && (
                    <div className="bg-gray-50 dark:bg-slate-700/50 py-1">
                      <button
                        onClick={() => handleViewAsSelect(null)}
                        className={`w-full text-left px-8 py-2 text-sm hover:bg-gray-100 dark:hover:bg-slate-600 flex items-center gap-2 ${
                          viewAsRole === null ? 'text-blue-600 dark:text-blue-400 font-medium' : 'text-gray-700 dark:text-gray-300'
                        }`}
                      >
                        {viewAsRole === null && (
                          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                          </svg>
                        )}
                        <span className={viewAsRole === null ? '' : 'ml-6'}>Normal (Admin)</span>
                      </button>
                      <button
                        onClick={() => handleViewAsSelect('leadership')}
                        className={`w-full text-left px-8 py-2 text-sm hover:bg-gray-100 dark:hover:bg-slate-600 flex items-center gap-2 ${
                          viewAsRole === 'leadership' ? 'text-blue-600 dark:text-blue-400 font-medium' : 'text-gray-700 dark:text-gray-300'
                        }`}
                      >
                        {viewAsRole === 'leadership' && (
                          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                          </svg>
                        )}
                        <span className={viewAsRole === 'leadership' ? '' : 'ml-6'}>Leadership</span>
                      </button>
                      <button
                        onClick={() => handleViewAsSelect('member')}
                        className={`w-full text-left px-8 py-2 text-sm hover:bg-gray-100 dark:hover:bg-slate-600 flex items-center gap-2 ${
                          viewAsRole === 'member' ? 'text-blue-600 dark:text-blue-400 font-medium' : 'text-gray-700 dark:text-gray-300'
                        }`}
                      >
                        {viewAsRole === 'member' && (
                          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                          </svg>
                        )}
                        <span className={viewAsRole === 'member' ? '' : 'ml-6'}>Member</span>
                      </button>
                    </div>
                  )}
                </div>
              )}

              {userIsAdmin && (
                <button
                  onClick={handleDataManagement}
                  className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-700 flex items-center gap-2"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
                  </svg>
                  Data Management
                </button>
              )}

              <div className="border-t border-gray-200 dark:border-slate-700 my-1"></div>

              <button
                onClick={handleLogout}
                className="w-full text-left px-4 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-gray-100 dark:hover:bg-slate-700 flex items-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
                Logout
              </button>
            </div>
          </div>
        )}
      </div>

      {showApiKeyModal && (
        <ApiKeyModal onClose={() => setShowApiKeyModal(false)} />
      )}

      {showApiUsageModal && (
        <ApiKeyUsageModal onClose={() => setShowApiUsageModal(false)} />
      )}
    </>
  )
}

function ApiKeyModal({ onClose }) {
  const { user, login } = useAuth()
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const handleSave = async () => {
    try {
      setSaving(true)
      setError(null)
      
      // Re-login with new API key
      const result = await login(apiKey)
      
      if (!result.success) {
        throw new Error(result.error || 'Invalid API key')
      }
      
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl max-w-md w-full mx-4">
        <div className="p-6">
          <h3 className="text-lg font-semibold mb-4 text-gray-900 dark:text-gray-100">
            Update Torn API Key
          </h3>
          
          <div className="mb-4">
            <label className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-300">
              API Key
            </label>
            <input
              type="text"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="input w-full font-mono text-sm"
              placeholder="Enter your Torn API key"
            />
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Get your API key from Torn Settings &gt; API
            </p>
          </div>

          {error && (
            <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            </div>
          )}

          <div className="flex gap-2 justify-end">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-700 rounded-lg"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !apiKey}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? 'Verifying...' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function ApiKeyUsageModal({ onClose }) {
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl max-w-lg w-full mx-4 max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              API Key Usage
            </h3>
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-gray-100 dark:hover:bg-slate-700 text-gray-500 dark:text-gray-400"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
            This dashboard uses your Torn API key in accordance with{' '}
            <a
              href="https://www.torn.com/wiki.php#chapter=Terms-of-Service"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 dark:text-blue-400 hover:underline"
            >
              Torn's API Terms of Service
            </a>
            . Here is exactly how your key is used.
          </p>

          <div className="space-y-5">
            {/* Login Key */}
            <div>
              <h4 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-2">
                Login API Key
              </h4>
              <div className="rounded-lg border border-gray-200 dark:border-slate-600 overflow-hidden">
                <table className="w-full text-xs">
                  <tbody>
                    {[
                      ['Storage', 'Browser localStorage only — never sent to our servers'],
                      ['Sharing', 'Not shared — visible only to you on your device'],
                      ['Purpose', 'Verify faction membership and determine your access level (member vs. leadership)'],
                      ['API Calls', 'GET /v2/key/info · GET /user/?selections=profile'],
                      ['Access Level', 'Limited Access (with Faction permission enabled)'],
                    ].map(([label, value]) => (
                      <tr key={label} className="border-b border-gray-100 dark:border-slate-700 last:border-0">
                        <td className="px-3 py-2 font-medium text-gray-700 dark:text-gray-300 w-1/3 bg-gray-50 dark:bg-slate-700/40">
                          {label}
                        </td>
                        <td className="px-3 py-2 text-gray-600 dark:text-gray-400">
                          {label === 'API Calls'
                            ? value.split(' · ').map((call, i) => (
                                <span key={i} className="block font-mono">{call}</span>
                              ))
                            : value
                          }
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-500 mt-1.5 italic">
                Your login key is cleared from storage when you log out. You can revoke access at any time by generating a new API key in Torn.
              </p>
            </div>

            {/* CPR Scraper Key */}
            <div>
              <h4 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-2">
                CPR Scraper Key{' '}
                <span className="text-xs font-normal text-gray-500 dark:text-gray-400">(optional — for members on the CPR roster)</span>
              </h4>
              <div className="rounded-lg border border-gray-200 dark:border-slate-600 overflow-hidden">
                <table className="w-full text-xs">
                  <tbody>
                    {[
                      ['Storage', 'Encrypted GitHub Secret — accessible only to repository administrators'],
                      ['Sharing', 'Key not shared. CPR stats derived from it are visible to faction members'],
                      ['Purpose', 'Automated nightly scripts collect your Checkpoint Pass Rate (CPR) to assist with OC slot optimisation'],
                      ['Access Level', 'Limited Access'],
                    ].map(([label, value]) => (
                      <tr key={label} className="border-b border-gray-100 dark:border-slate-700 last:border-0">
                        <td className="px-3 py-2 font-medium text-gray-700 dark:text-gray-300 w-1/3 bg-gray-50 dark:bg-slate-700/40">
                          {label}
                        </td>
                        <td className="px-3 py-2 text-gray-600 dark:text-gray-400">
                          {value}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-500 mt-1.5 italic">
                You are only added to the CPR roster by leadership with your consent. You can revoke access at any time by generating a new Torn API key and notifying leadership.
              </p>
            </div>
          </div>

          <div className="mt-5 flex justify-end">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-slate-600 transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}