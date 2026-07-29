import { useState, useRef, useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { isAdmin, tornKeyGenUrl } from '../config'
import { Menu, Key, Info, Eye, ChevronRight, Check, LogOut, X, MessageSquarePlus } from 'lucide-react'
import ApiKeyDisclosure from './ApiKeyDisclosure'
import InstallAppMenuItem from './InstallAppMenuItem'
import FeedbackModal from './FeedbackModal'

export default function SettingsDropdown({ viewAsRole, setViewAsRole, canViewAs }) {
  const { user, logout } = useAuth()
  const [isOpen, setIsOpen] = useState(false)
  const [showApiKeyModal, setShowApiKeyModal] = useState(false)
  const [showApiUsageModal, setShowApiUsageModal] = useState(false)
  const [showFeedbackModal, setShowFeedbackModal] = useState(false)
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

  const userIsAdmin = user?.isAdmin ?? isAdmin(user?.id)

  return (
    <>
      <div className="relative" ref={dropdownRef}>
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors"
          aria-label="Settings"
        >
          <Menu className="w-6 h-6 text-gray-700 dark:text-gray-300" />
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
                <Key className="w-4 h-4" />
                Change API Key
              </button>

              <button
                onClick={handleApiUsage}
                className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-700 flex items-center gap-2"
              >
                <Info className="w-4 h-4" />
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
                      <Eye className="w-4 h-4" />
                      View As
                    </span>
                    <ChevronRight className={`w-4 h-4 transition-transform ${showViewAsMenu ? 'rotate-90' : ''}`} />
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
                          <Check className="w-4 h-4" />
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
                          <Check className="w-4 h-4" />
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
                          <Check className="w-4 h-4" />
                        )}
                        <span className={viewAsRole === 'member' ? '' : 'ml-6'}>Member</span>
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Feedback (#253): any non-visitor member, only when the server
                  has a PAT configured. */}
              {user?.feedbackEnabled && !user?.isVisitor && (
                <button
                  onClick={() => { setShowFeedbackModal(true); setIsOpen(false) }}
                  className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-700 flex items-center gap-2"
                >
                  <MessageSquarePlus className="w-4 h-4" />
                  Send feedback
                </button>
              )}

              <InstallAppMenuItem onAction={() => setIsOpen(false)} />

              <div className="border-t border-gray-200 dark:border-slate-700 my-1"></div>

              <button
                onClick={handleLogout}
                className="w-full text-left px-4 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-gray-100 dark:hover:bg-slate-700 flex items-center gap-2"
              >
                <LogOut className="w-4 h-4" />
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

      {showFeedbackModal && (
        <FeedbackModal onClose={() => setShowFeedbackModal(false)} />
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

          {user?.apiKey && (
            <div className="mb-4 p-2.5 rounded-lg bg-gray-50 dark:bg-slate-700/40 border border-gray-200 dark:border-slate-600 flex items-center gap-2 text-sm">
              <Key className="w-4 h-4 text-gray-400 flex-shrink-0" />
              <span className="text-gray-600 dark:text-gray-400">Current key:</span>
              <span className="font-mono text-gray-800 dark:text-gray-200">••••••••••••{user.apiKey.slice(-4)}</span>
            </div>
          )}

          <div className="mb-4">
            <label className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-300">
              API Key <span className="font-normal text-gray-500 dark:text-gray-400">(Limited Access)</span>
            </label>
            <input
              type="text"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="input w-full font-mono text-sm"
              placeholder="Paste your Limited Access key"
            />
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Need a key? {' '}
              <a
                href={tornKeyGenUrl()}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 dark:text-blue-400 hover:underline"
              >
                Generate a Limited Access key
              </a>
              , then paste it here.
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
              <X className="w-5 h-5" />
            </button>
          </div>

          <ApiKeyDisclosure />

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