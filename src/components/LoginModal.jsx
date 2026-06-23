import { useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { Info, LoaderCircle } from 'lucide-react'
import ApiKeyDisclosure from './ApiKeyDisclosure'

export default function LoginModal() {
  const [apiKey, setApiKey] = useState('')
  const [consented, setConsented] = useState(false)
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
    if (!consented) {
      setError('Please agree to how your API key is used to continue')
      return
    }

    setIsLoading(true)
    setError('')

    // Consent is mandatory: the user can only reach this point by ticking the
    // agreement box, so login() will store their key + record acceptance.
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
      <div className="card max-w-md w-full max-h-[92vh] overflow-y-auto">
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
          {/* Mandatory opt-in disclosure (Torn API ToS) + one-click key gen */}
          <ApiKeyDisclosure showGenerateButton />

          <div>
            <label className="block text-sm font-medium mb-2">
              Torn API Key{' '}
              <span className="font-normal text-gray-500 dark:text-gray-400">(Limited Access)</span>
            </label>
            <input
              type="text"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Paste your Limited Access key"
              className="input w-full"
              disabled={isLoading}
              autoFocus
            />
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Don&apos;t have one? Use the <span className="font-medium">Generate Limited Key</span> button above,
              then paste the key it creates here.
            </p>
          </div>

          <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
            <input
              type="checkbox"
              checked={consented}
              onChange={(e) => setConsented(e.target.checked)}
              disabled={isLoading}
              className="mt-0.5"
            />
            <span>
              I have read and agree to how my API key is used and stored, as described above.
            </span>
          </label>

          {error && (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3">
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            </div>
          )}

          <button
            type="submit"
            disabled={isLoading || !consented || !apiKey.trim()}
            className="btn-primary w-full disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLoading ? (
              <span className="flex items-center justify-center">
                <LoaderCircle className="animate-spin h-5 w-5 mr-2" />
                Authenticating...
              </span>
            ) : (
              'I Agree & Log In'
            )}
          </button>
        </form>
      </div>
    </div>
  )
}
