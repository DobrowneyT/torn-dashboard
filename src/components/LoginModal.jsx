import { useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { Info, ChevronDown, LoaderCircle } from 'lucide-react'

function ApiKeyUsageInfo() {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="mt-4 border border-gray-200 dark:border-slate-600 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-slate-700/50 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors"
      >
        <span className="flex items-center gap-1.5 font-medium">
          <Info className="w-3.5 h-3.5" />
          How is my API key used?
        </span>
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>
      {expanded && (
        <div className="px-3 py-2 text-xs text-gray-600 dark:text-gray-400 space-y-2 bg-white dark:bg-slate-800">
          <p className="font-semibold text-gray-700 dark:text-gray-300">Torn API ToS Compliance</p>
          <table className="w-full text-xs border-collapse">
            <tbody>
              <tr className="border-b border-gray-100 dark:border-slate-700">
                <td className="py-1 pr-2 font-medium text-gray-700 dark:text-gray-300 w-1/3">Storage</td>
                <td className="py-1 text-gray-600 dark:text-gray-400">Browser localStorage on your device. Sent to our Edge Functions over HTTPS to verify identity; we cache a SHA-256 hash for 24h. The raw key is never persisted server-side.</td>
              </tr>
              <tr className="border-b border-gray-100 dark:border-slate-700">
                <td className="py-1 pr-2 font-medium text-gray-700 dark:text-gray-300">Sharing</td>
                <td className="py-1 text-gray-600 dark:text-gray-400">Not shared with other users</td>
              </tr>
              <tr className="border-b border-gray-100 dark:border-slate-700">
                <td className="py-1 pr-2 font-medium text-gray-700 dark:text-gray-300">Purpose</td>
                <td className="py-1 text-gray-600 dark:text-gray-400">Verify faction membership and gate access to leadership features</td>
              </tr>
              <tr className="border-b border-gray-100 dark:border-slate-700">
                <td className="py-1 pr-2 font-medium text-gray-700 dark:text-gray-300">Torn API Calls</td>
                <td className="py-1 text-gray-600 dark:text-gray-400"><code className="font-mono">GET /v2/key/info</code> and <code className="font-mono">GET /user/?selections=profile</code> — identity verification only, no quota-consuming gameplay queries on your key</td>
              </tr>
              <tr>
                <td className="py-1 pr-2 font-medium text-gray-700 dark:text-gray-300">Access Level</td>
                <td className="py-1 text-gray-600 dark:text-gray-400">Minimal Access</td>
              </tr>
            </tbody>
          </table>
          <p className="text-gray-500 dark:text-gray-500 italic">
            Your key is cleared from storage when you log out. You can revoke access at any time by generating a new key in{' '}
            <a href="https://www.torn.com/preferences.php#tab=api" target="_blank" rel="noopener noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline">Torn Preferences</a>.
          </p>
        </div>
      )}
    </div>
  )
}

export default function LoginModal() {
  const [apiKey, setApiKey] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')
  const { login, authError, clearAuthError } = useAuth()

  // When the session revalidator (or future periodic checker) forces a
  // logout, it stashes the reason in authError so this modal can show it
  // *above* the standard login form. We don't auto-clear — the message
  // stays visible until the user either logs in successfully (login()
  // clears it) or actively dismisses it.
  function dismissAuthError() {
    clearAuthError?.()
  }

  async function handleLogin(e) {
    e.preventDefault()

    if (!apiKey.trim()) {
      setError('Please enter your API key')
      return
    }

    setIsLoading(true)
    setError('')

    const result = await login(apiKey.trim())

    if (!result.success) {
      setError(result.error)
      setIsLoading(false)
    }
    // On success, the user state will update and modal will disappear.
    // authError is cleared by the wrapped login() in AuthContext.
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="card max-w-md w-full">
        <div className="mb-6">
          <h2 className="text-2xl font-bold mb-2">Faction Member Login</h2>
          <p className="text-gray-600 dark:text-gray-400">
            Enter your Torn API key to access the OC Dashboard
          </p>
        </div>

        {authError && (
          <div className="mb-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-300 dark:border-amber-700 rounded-lg p-3 flex items-start gap-2">
            <Info className="w-4 h-4 mt-0.5 flex-shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-amber-800 dark:text-amber-300 mb-0.5">Session ended</p>
              <p className="text-xs text-amber-700 dark:text-amber-400">{authError}</p>
            </div>
            <button
              type="button"
              onClick={dismissAuthError}
              className="text-xs text-amber-700 dark:text-amber-400 hover:underline whitespace-nowrap"
              aria-label="Dismiss"
            >
              Dismiss
            </button>
          </div>
        )}

        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-2">
              Torn API Key{' '}
              <span className="font-normal text-gray-500 dark:text-gray-400">(Minimal Access)</span>
            </label>
            <input
              type="text"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Enter your API key"
              className="input w-full"
              disabled={isLoading}
              autoFocus
            />
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Get your API key from{' '}
              <a
                href="https://www.torn.com/preferences.php#tab=api"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 dark:text-blue-400 hover:underline"
              >
                Torn Preferences
              </a>
            </p>
          </div>

          {error && (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3">
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            </div>
          )}

          <button
            type="submit"
            disabled={isLoading}
            className="btn-primary w-full disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLoading ? (
              <span className="flex items-center justify-center">
                <LoaderCircle className="animate-spin h-5 w-5 mr-2" />
                Authenticating...
              </span>
            ) : (
              'Login'
            )}
          </button>
        </form>

        <div className="mt-6 pt-6 border-t border-gray-200 dark:border-slate-700">
          <h3 className="font-semibold mb-2 text-sm">Why do I need an API key?</h3>
          <ul className="text-xs text-gray-600 dark:text-gray-400 space-y-1">
            <li>• Verifies you're a member of our faction</li>
            <li>• Determines your access level (member vs leadership)</li>
            <li>• Your API key is stored locally and never shared</li>
            <li>• You can revoke access by generating a new key in Torn</li>
          </ul>
          <ApiKeyUsageInfo />
        </div>
      </div>
    </div>
  )
}