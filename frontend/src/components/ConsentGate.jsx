// Force a re-approval when the API Key Usage page changes (#894).
//
// ⚠️ **The rule this implements:** *"Anytime we adjust the API Key Usage page
// then, lets force a re-approval"* (MonChoon, 2026-10-04). The mechanism it
// replaces did nothing at all — `config.js` said "bump to re-prompt", nothing
// read the value, and the page could be rewritten with no member ever asked.
//
// ⚠️ **This does NOT reload the tab.** `useVersionGate` reloads on the War
// Room, because stale code there shows wrong dibs. Here a reload would throw
// away whatever somebody was in the middle of, and the thing we want is an
// acknowledgement, not fresh code.
//
// ⚠️ **It does not block the app either.** A member who has not accepted keeps
// working, and their key keeps serving every purpose the disclosure they DID
// accept covers — only a new purpose skips them. Locking the dashboard would
// punish them for our change.
import { useState } from 'react'
import { KeyRound, X } from 'lucide-react'
import ApiKeyDisclosure from './ApiKeyDisclosure'
import { apiPost } from '../utils/apiClient'

export default function ConsentGate({ user, onAccepted }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [dismissed, setDismissed] = useState(false)
  // ⚠️ Local, because the bootstrap payload this reads is fetched once at
  // login. Waiting for it to refresh would leave the modal on screen after a
  // successful accept, which reads as the button not having worked.
  const [accepted, setAccepted] = useState(false)

  if (!user?.consentRequired || dismissed || accepted) return null

  const accept = async () => {
    setBusy(true); setError(null)
    try {
      // ⚠️ No version is sent. The server records what IS current; a stale tab
      // must not be able to accept wording that has since been replaced.
      await apiPost('/api/auth/consent', {})
      setAccepted(true)
      onAccepted?.()
    } catch (e) {
      setError(e?.message || 'Could not record your acceptance')
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4">
      <div className="my-8 w-full max-w-2xl rounded-lg bg-white p-6 shadow-xl dark:bg-slate-800">
        <div className="flex items-start justify-between gap-4">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
            <KeyRound className="h-5 w-5" aria-hidden="true" />
            How your API key is used has changed
          </h2>
          <button
            // ⚠️ "Close", not "Remind me later" — the footer button already
            // carries that name, and two controls with the same accessible
            // name are ambiguous to a screen reader even though they do the
            // same thing.
            type="button" onClick={() => setDismissed(true)} aria-label="Close"
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
          Please read it and confirm you are happy. Until you do, your key keeps doing
          only what you already agreed to — nothing stops working.
        </p>

        <div className="mt-4 max-h-[50vh] overflow-y-auto rounded border border-gray-200 p-3 dark:border-slate-700">
          <ApiKeyDisclosure />
        </div>

        {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            type="button" onClick={() => setDismissed(true)}
            className="rounded px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-slate-700"
          >
            Remind me later
          </button>
          <button
            type="button" onClick={accept} disabled={busy}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'I accept'}
          </button>
        </div>
      </div>
    </div>
  )
}
