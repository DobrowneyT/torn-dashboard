// War Room push client (#207). Pure, injectable helpers so the subscribe
// decision flow is testable without a browser; the React hook (useWarRoomPush)
// wires the live ServiceWorker/PushManager/Notification APIs to them.
import { apiGet, apiPost } from './apiClient'

// VAPID public keys are URL-safe base64; PushManager wants a Uint8Array.
export function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

// Does this browser support the whole Web Push stack?
export function pushSupported(win = typeof window !== 'undefined' ? window : undefined) {
  if (!win) return false
  return 'serviceWorker' in (win.navigator || {}) && 'PushManager' in win && 'Notification' in win
}

// Should we prompt this member for notification permission on entering a live
// war room? Only when the browser supports it, the server has push configured
// (a public key), the user hasn't already answered the OS prompt, and we
// haven't already asked this session.
export function shouldPrompt({ supported, permission, vapidPublicKey, alreadyAsked }) {
  if (!supported) return false
  if (!vapidPublicKey) return false
  if (alreadyAsked) return false
  return permission === 'default'
}

/**
 * Ensure this browser has an active, server-registered push subscription.
 * Injectable deps keep the branching testable:
 *   getPublicKey()       -> VAPID public key string | null
 *   requestPermission()  -> 'granted' | 'denied' | 'default'
 *   getRegistration()    -> ServiceWorkerRegistration (with .pushManager)
 *   post(path, body)     -> persist the subscription server-side
 * Returns the subscription JSON that was stored, or null when we didn't
 * subscribe (unsupported / no key / permission not granted).
 */
export async function ensurePushSubscription({
  getPublicKey = () => apiGet('/api/push/vapid-public-key').then((r) => r.publicKey),
  requestPermission = () => Notification.requestPermission(),
  getRegistration = () => navigator.serviceWorker.ready,
  post = (path, body) => apiPost(path, body),
} = {}) {
  const publicKey = await getPublicKey()
  if (!publicKey) return null

  const registration = await getRegistration()
  // Reuse an existing subscription if the browser already has one — just make
  // sure the server knows about it.
  let sub = await registration.pushManager.getSubscription()
  if (!sub) {
    const permission = await requestPermission()
    if (permission !== 'granted') return null
    sub = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    })
  }
  const json = sub.toJSON()
  await post('/api/push/subscribe', json)
  return json
}
