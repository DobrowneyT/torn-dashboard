// War Room push opt-in (#207). When a member enters a live war room we offer
// to turn on background push notifications. Showing our own banner first (with
// an Enable button) means the OS permission prompt fires from a real click —
// friendlier and more reliable than firing it unprompted on page load.
//
// Renders nothing unless: push is supported, the server has VAPID configured,
// and the member hasn't already answered. If permission was already granted we
// silently re-register this browser's subscription and show no banner.
import { useEffect, useState } from 'react'
import { Bell, X } from 'lucide-react'
import { apiGet } from '../../utils/apiClient'
import { ensurePushSubscription, pushSupported, shouldPrompt } from '../../utils/pushClient'

const ASKED_KEY = 'wr-push-asked'

function alreadyAsked() {
  try { return sessionStorage.getItem(ASKED_KEY) === '1' } catch { return false }
}
function markAsked() {
  try { sessionStorage.setItem(ASKED_KEY, '1') } catch { /* ignore */ }
}

export default function WarRoomPushPrompt({ live }) {
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!live || !pushSupported()) return
    let cancelled = false
    ;(async () => {
      const publicKey = await apiGet('/api/push/vapid-public-key')
        .then((r) => r.publicKey)
        .catch(() => null)
      if (cancelled || !publicKey) return

      const permission = typeof Notification !== 'undefined' ? Notification.permission : 'denied'
      if (permission === 'granted') {
        // Already opted in on this device — just make sure the server still has
        // a current subscription (endpoints rotate), silently.
        ensurePushSubscription().catch(() => {})
        return
      }
      if (shouldPrompt({ supported: true, permission, vapidPublicKey: publicKey, alreadyAsked: alreadyAsked() })) {
        setShow(true)
      }
    })()
    return () => { cancelled = true }
  }, [live])

  async function enable() {
    setBusy(true)
    try {
      await ensurePushSubscription()
    } finally {
      markAsked()
      setBusy(false)
      setShow(false)
    }
  }

  function dismiss() {
    markAsked()
    setShow(false)
  }

  if (!show) return null

  return (
    <div className="mb-3 rounded-lg border border-blue-200 dark:border-blue-900/50 bg-blue-50 dark:bg-blue-900/20 px-4 py-3 flex items-center justify-between gap-3">
      <div className="flex items-center gap-2.5 min-w-0">
        <Bell className="w-5 h-5 text-blue-600 dark:text-blue-400 flex-shrink-0" />
        <p className="text-sm text-blue-900 dark:text-blue-200 min-w-0">
          <span className="font-semibold">Get War Room alerts on this device.</span>{' '}
          <span className="hidden sm:inline">Turn on notifications for incoming-push warnings and leader calls, even with the tab closed.</span>
        </p>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <button
          onClick={enable}
          disabled={busy}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
        >
          {busy ? 'Enabling…' : 'Enable'}
        </button>
        <button onClick={dismiss} aria-label="Dismiss" className="p-1 rounded text-blue-500 hover:text-blue-700 dark:hover:text-blue-300">
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}
