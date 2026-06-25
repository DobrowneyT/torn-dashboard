/**
 * Session token lifecycle for Supabase auth.
 *
 * Owns the lifecycle of the short-lived JWT minted by war-room-fetch's
 * `mint_session_token` action. The JWT carries `role=authenticated` plus
 * custom claims (`faction_id`, `is_leadership`, `is_admin`, `torn_user_id`)
 * that RLS policies key off.
 *
 * Two consumers:
 *   - The supabase-js client's `accessToken` async option (set up in
 *     src/utils/supabase.js). PostgREST and Realtime both pull through it.
 *   - The legacy WarRoomView realtime path (until it migrates to the
 *     accessToken hook in a later pass).
 *
 * Lifecycle:
 *   - First `get()` call after login mints a fresh token. Cached in memory
 *     AND localStorage so reloads don't re-mint until the cached token is
 *     close to expiry.
 *   - A timer schedules a refresh REFRESH_MARGIN_SECONDS before `exp`.
 *   - On `visibilitychange` (tab focus), we check expiry and refresh if
 *     within the margin — covers the "laptop was asleep all day" case.
 *   - `clear()` wipes both caches and cancels the timer (called on logout).
 *
 * Failure mode: if the mint endpoint is down, `get()` returns null. The
 * supabase-js `accessToken` hook treating null as "fall back to anon key"
 * is graceful degradation by design — reads on permissive-policy tables
 * still work, writes that require the JWT will fail clearly.
 */

// NOTE: warRoomApiV2 is imported LAZILY (dynamic import in mint() below) on
// purpose. A static import here creates an init-time cycle —
// supabase.js → sessionToken.js → warRoomApiV2.js → supabase.js — and because
// supabase.js calls this module's get() inside createClient()'s accessToken
// hook *during construction*, that cycle surfaced as a TDZ crash
// ("Cannot access 'X' before initialization"). The dynamic import defers the
// edge to call time, after all modules have finished initializing.

const STORAGE_PREFIX = 'tornSessionToken:'
const REFRESH_MARGIN_SECONDS = 30 * 60      // refresh 30 min before exp
const MIN_REFRESH_INTERVAL_MS = 60_000      // never schedule sooner than 1 min

let currentTornUser = null      // { id, apiKey } — set via configure()
let cached = null               // { token, expiresAt } | null
let mintInFlight = null         // Promise<token|null> while a mint is running
let refreshTimer = null
let readySubscribers = new Set()

/**
 * Tell the module which user is logged in. AuthContext calls this on login
 * and on app-boot-from-cache. Switching users wipes the previous token.
 */
export function configure(user) {
  const prevId = currentTornUser?.id
  const newId  = user?.id ?? null

  if (prevId !== newId) {
    // User switched (or logged out). Wipe everything from the prior session.
    clearTimer()
    if (prevId != null) localStorage.removeItem(storageKey(prevId))
    cached = null
    mintInFlight = null
  }

  currentTornUser = user ? { id: String(user.id), apiKey: user.apiKey } : null

  if (currentTornUser) {
    // Try to rehydrate from localStorage; if stale/missing, kick off a mint.
    const restored = restoreFromStorage(currentTornUser.id)
    if (restored) {
      cached = restored
      scheduleRefresh()
      notifyReady(true)
    } else {
      refresh().catch(() => {})  // background; consumers can await get()
    }
  } else {
    notifyReady(false)
  }
}

/**
 * Returns the current JWT (cached or freshly minted), or null if no user is
 * configured / the mint endpoint failed. Safe to call repeatedly — concurrent
 * callers share the same in-flight mint.
 */
export async function get() {
  if (!currentTornUser) return null

  if (cached && !isExpiring(cached)) return cached.token

  // Either cache is empty or it's close to expiry. Kick off a mint (or
  // wait on one already in flight).
  if (!mintInFlight) mintInFlight = doMint()
  return mintInFlight
}

/**
 * Force a fresh mint, bypassing the cache. Used on the refresh timer and
 * on visibility-change checks. Returns the new token, or null on failure.
 */
export async function refresh() {
  if (!currentTornUser) return null
  if (!mintInFlight) mintInFlight = doMint()
  return mintInFlight
}

/**
 * Wipe everything. AuthContext calls this on logout. Safe to call when no
 * user is configured.
 */
export function clear() {
  const id = currentTornUser?.id
  clearTimer()
  if (id != null) localStorage.removeItem(storageKey(id))
  cached = null
  mintInFlight = null
  currentTornUser = null
  notifyReady(false)
}

/**
 * Subscribe to "token is ready" transitions. Fires once with the current
 * state and again whenever ready flips. Returns an unsubscribe fn.
 *
 * `ready = true` means a non-expired token is available right now (cached
 * or minted). It does NOT guarantee the next get() succeeds — the mint
 * could fail in the interim.
 */
export function subscribeToReady(fn) {
  readySubscribers.add(fn)
  fn(cached != null && !isExpiring(cached))
  return () => readySubscribers.delete(fn)
}

// ─── Internals ────────────────────────────────────────────────────────────

async function doMint() {
  const user = currentTornUser
  if (!user?.apiKey) {
    mintInFlight = null
    return null
  }

  try {
    // Lazy import breaks the supabase ↔ sessionToken ↔ warRoomApiV2 init cycle.
    const { mintSessionToken: mintSessionTokenApi } = await import('./warRoomApiV2')
    const { token, expires_at } = await mintSessionTokenApi(user.apiKey)
    cached = { token, expiresAt: expires_at }
    persistToStorage(user.id, cached)
    scheduleRefresh()
    notifyReady(true)
    return token
  } catch (e) {
    console.warn('[sessionToken] mint failed; falling back to anon for now:', e?.message ?? e)
    // Don't clear cached if we still have a usable one. If we don't, leave
    // it null so callers know they're flying anon.
    notifyReady(cached != null && !isExpiring(cached))
    return cached?.token ?? null
  } finally {
    mintInFlight = null
  }
}

function isExpiring(entry) {
  if (!entry?.expiresAt) return true
  const nowSec = Math.floor(Date.now() / 1000)
  return entry.expiresAt - nowSec <= REFRESH_MARGIN_SECONDS
}

function scheduleRefresh() {
  clearTimer()
  if (!cached?.expiresAt) return
  const nowSec = Math.floor(Date.now() / 1000)
  const secondsUntilRefresh = cached.expiresAt - nowSec - REFRESH_MARGIN_SECONDS
  const msUntilRefresh = Math.max(MIN_REFRESH_INTERVAL_MS, secondsUntilRefresh * 1000)
  refreshTimer = setTimeout(() => { refresh().catch(() => {}) }, msUntilRefresh)
}

function clearTimer() {
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null }
}

function storageKey(userId) {
  return STORAGE_PREFIX + userId
}

function persistToStorage(userId, entry) {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(entry))
  } catch {
    // Quota or disabled storage — ignore; the in-memory cache still works.
  }
}

function restoreFromStorage(userId) {
  try {
    const raw = localStorage.getItem(storageKey(userId))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed?.token || !parsed?.expiresAt) return null
    if (isExpiring(parsed)) return null  // close to expiry — let caller mint fresh
    return parsed
  } catch {
    return null
  }
}

function notifyReady(state) {
  for (const fn of readySubscribers) {
    try { fn(state) } catch { /* listener errors don't break others */ }
  }
}

// Tab-focus refresh: if the cached token is expiring or expired, refresh.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    if (!currentTornUser) return
    if (!cached || isExpiring(cached)) refresh().catch(() => {})
  })
}
