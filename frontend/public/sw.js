/* Service worker for the TNL Forge Dashboard PWA (#206).
 *
 * Two jobs today:
 *   1. Make an installed launch fast and offline-tolerant by caching the app
 *      shell and static assets.
 *   2. Be the ONE service worker the whole app owns — the War Room push
 *      notifications (#198) extend THIS file with `push` / `notificationclick`
 *      handlers rather than registering a second worker. The extension point is
 *      marked at the bottom; keep push logic there.
 *
 * Caching strategy is deliberately deploy-safe (past deploys "not taking" was a
 * real complaint): navigations are network-first so a fresh index.html always
 * wins when online, and Vite content-hashes static assets so a new build ships
 * new URLs — cache-first on those can never serve stale code.
 */

const CACHE = 'tnl-forge-shell-v1'

// Cache-first candidates: content-hashed build output and static art. These
// URLs change when their content changes, so serving them from cache is safe.
function isStaticAsset(url) {
  return (
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.webmanifest' ||
    /\.(?:png|jpg|jpeg|svg|gif|ico|webp|woff2?)$/.test(url.pathname)
  )
}

self.addEventListener('install', (event) => {
  // Pre-cache the app shell so a cold offline launch still boots.
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(['/', '/index.html']).catch(() => {})),
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  // Drop caches from older SW versions, then take control of open pages.
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  // Only handle our own origin; never intercept the API (auth, live data).
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/')) return

  // Navigations (HTML): network-first so deploys land immediately; fall back to
  // the cached shell when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put('/index.html', copy)).catch(() => {})
          return res
        })
        .catch(() => caches.match('/index.html').then((r) => r || caches.match('/'))),
    )
    return
  }

  // Static hashed assets: cache-first, populating the cache on first hit.
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((res) => {
            if (res.ok) {
              const copy = res.clone()
              caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {})
            }
            return res
          }),
      ),
    )
  }
})

// Let the page tell a waiting worker to activate immediately (used by the
// in-app "update available" flow, if added later).
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting()
})

/* ---------------------------------------------------------------------------
 * War Room push notifications (#207). The server sends a VAPID-signed push with
 * a JSON payload { title, body, url?, tag? }; we surface it as a notification
 * and, on click, focus an existing dashboard tab or open the target path.
 * ------------------------------------------------------------------------- */

const DEFAULT_PUSH_URL = '/war-room'

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { body: event.data ? event.data.text() : '' }
  }
  const title = data.title || 'War Room'
  const options = {
    body: data.body || '',
    icon: '/icons/pwa-icon-192.png',
    badge: '/icons/pwa-icon-192.png',
    tag: data.tag || undefined,
    // Re-alert even when a notification with the same tag is showing.
    renotify: !!data.tag,
    data: { url: data.url || DEFAULT_PUSH_URL },
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = (event.notification.data && event.notification.data.url) || DEFAULT_PUSH_URL
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Focus an already-open dashboard tab if we have one; else open a new one.
      for (const client of clients) {
        const path = new URL(client.url).pathname
        if (path === target || path.startsWith(target)) return client.focus()
      }
      if (clients.length > 0 && 'navigate' in clients[0]) {
        return clients[0].focus().then((c) => c.navigate(target))
      }
      return self.clients.openWindow(target)
    }),
  )
})
