// Service-worker registration (#206). Registers the single app-owned worker
// (public/sw.js) that caches the app shell and — once #198 lands — handles War
// Room push. Only in production builds: a caching SW fights Vite's HMR in dev,
// and SWs require HTTPS or localhost anyway.
export function registerServiceWorker() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  if (!import.meta.env.PROD) return
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      // A failed registration must never break the app — it just means no
      // offline shell / no install prompt this session.
      console.warn('Service worker registration failed:', err)
    })
  })
}
