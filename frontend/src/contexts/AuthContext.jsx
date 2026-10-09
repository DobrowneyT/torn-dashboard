import { createContext, useContext, useState, useEffect, useRef } from 'react'
import { config } from '../config'
import { loadFactionIdentity } from '../utils/factionIdentity'
import {
  apiLogin,
  apiBootstrap,
  apiRefresh,
  getApiSession,
  storeApiSession,
  clearApiSession,
} from '../utils/apiClient'
import {
  buildUserFromBootstrap, sessionFieldsChanged, describeRoleDelta,
} from '../utils/sessionUser'

// API-mode login (self-hosted stack): the server does Torn verification, role
// resolution, and JWT minting — the browser never talks to Torn or Supabase.
async function loginViaApi(apiKey) {
  const result = await apiLogin(apiKey)
  if (!result.ok) return { success: false, error: result.error }
  storeApiSession({ token: result.token, expires_at: result.expires_at })

  const boot = await apiBootstrap(result.token)
  if (!boot.ok || !boot.user) {
    clearApiSession()
    return { success: false, error: 'Login succeeded but bootstrap failed. Please try again.' }
  }

  return { success: true, user: buildUserFromBootstrap(boot) }
}

const AuthContext = createContext(null)

// Re-verify the saved session against the server on load. Returns { ok: true }
// when the session can stay live, or { ok: false, reason } when the user must be
// kicked back to the login modal. Remember-me sessions (#119): tokens live 30
// days but only act for 24h from their last verification, so on load we silently
// REFRESH rather than merely check expiry — the server re-verifies roster
// membership + roles and mints a fresh token. Only an unambiguous server verdict
// (401 expired / 403 kicked) tears the session down; network failures are
// transient and must not log anyone out.
async function revalidateSession() {
  if (!getApiSession()) {
    return { ok: false, reason: 'Your session expired. Please log in again.' }
  }
  const refreshed = await apiRefresh()
  if (refreshed.ok || refreshed.transient) return { ok: true }
  // A 403 has more than one cause — roster removal, or a key the members-sync
  // re-verification disabled (#319, e.g. paused or deleted in Torn). The server
  // knows which and says so, and telling someone their "faction access was
  // removed" over a paused key sends them to their leadership for nothing.
  return {
    ok: false,
    reason: refreshed.status === 403
      ? refreshed.error || 'Your faction access was removed. Contact your leadership if this is unexpected.'
      : 'Your session expired. Please log in again.',
  }
}

/**
 * Adopt the server's view of this session, after a refresh has already minted a
 * token with fresh claims (#927).
 *
 * ⚠️ **The refresh alone was never enough.** `/api/auth/refresh` re-reads
 * `role_assignments`, so the SERVER honours a role change immediately — but
 * every permission gate in the app reads the cached `user` object, and that was
 * only ever written by `login()`. A member granted a role got it on the API and
 * never saw it in the UI, which is why the fix was "log out and back in".
 *
 * ⚠️ Best-effort by design: a bootstrap failure here leaves the session exactly
 * as it was. Whether the session is still VALID is `revalidateSession`'s
 * question and it has already been answered; this is only about what the UI
 * knows, so a transient failure must never log anybody out.
 *
 * ⚠️ Returns null when nothing changed, so the caller can skip the state write.
 * Re-rendering the whole app every four hours for an identical object would be
 * churn — and on a revocation it would tear down panels somebody is using, so
 * doing it only when something really moved is the difference between a
 * necessary interruption and a pointless one.
 */
async function syncUserFromServer(cached) {
  const boot = await apiBootstrap()
  if (!boot?.ok || !boot.user) return null
  // ⚠️ Carry `lastLogin`: this runs on a timer, and restamping it would redate
  // a session nobody has actually logged into.
  const fresh = buildUserFromBootstrap(boot, { lastLogin: cached?.lastLogin })
  if (!sessionFieldsChanged(cached, fresh)) return null
  const { gained, lost } = describeRoleDelta(cached, fresh)
  if (gained.length || lost.length) {
    // Named, not just "session updated" — this line is what a bug report will
    // carry, and the delta is the only part worth reading.
    console.info(
      '[auth] roles changed without a re-login:',
      gained.length ? `+${gained.join(', ')}` : '',
      lost.length ? `-${lost.join(', ')}` : ''
    )
  }
  return fresh
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [tokenReady, setTokenReady] = useState(false)
  // Set by the revalidator (and by future periodic checks) to surface the
  // *reason* the user got kicked back to the login modal. The modal reads
  // this on mount and clears it via clearAuthError() once shown.
  const [authError, setAuthError] = useState(null)

  // Check for existing session on mount, then re-verify with Torn so a
  // revoked / paused / faction-changed key doesn't keep granting access.
  useEffect(() => {
    // Faction identity (id/name/branding) must be resolved before any view
    // renders — us-vs-them logic and the header key off it synchronously.
    const identityReady = loadFactionIdentity()
    const savedUser = localStorage.getItem('tornUser')
    if (savedUser) {
      try {
        const userData = JSON.parse(savedUser)
        setUser(userData)
        // Background re-validation — non-blocking so cached UI renders
        // immediately. On a fatal verdict (key invalid / wrong faction /
        // role removed) we tear the session down and surface the reason.
        revalidateSession().then(async result => {
          if (!result.ok) {
            console.warn('Session revalidation: forcing logout —', result.reason)
            clearApiSession()
            setUser(null)
            localStorage.removeItem('tornUser')
            setAuthError(result.reason)
            return
          }
          // #927 — the refresh above re-read roles into a new token; pick up
          // what that changed so the UI agrees with what the API will now allow.
          const fresh = await syncUserFromServer(userData)
          if (fresh) {
            setUser(fresh)
            localStorage.setItem('tornUser', JSON.stringify(fresh))
          }
        })
      } catch (err) {
        console.error('Error loading saved user:', err)
        localStorage.removeItem('tornUser')
      }
    }
    identityReady.finally(() => setLoading(false))
  }, [])

  // ⚠️ The CURRENT user, for the keepalive timer below. The timer must not be
  // re-created every time the user object changes — that would push the next
  // check four hours out on every change — but it also must not close over a
  // stale user, or it would keep comparing against a value it already replaced
  // and write an identical object every four hours forever. A ref is how the
  // interval reads fresh state without being a dependency of it.
  const userRef = useRef(user)
  useEffect(() => { userRef.current = user }, [user])

  // The API session token is the only credential; it's ready as soon as a user
  // is logged in. (tokenReady gates the RLS-era faction-scoped reads.)
  useEffect(() => {
    setTokenReady(!!user)
  }, [user])

  // Keep a long-lived tab's session fresh (#119): tokens only act for 24h from
  // their last verification, so refresh well inside that window while the app
  // is open. A 401 mid-use is still self-healed by apiClient's refresh-retry;
  // this just keeps the WebSocket connect (which can't retry a handshake as
  // gracefully) working across day-spanning war-room sessions.
  useEffect(() => {
    if (!user) return
    const timer = setInterval(async () => {
      const refreshed = await apiRefresh()
      if (!refreshed.ok) return
      // #927 — same reason as on load: the new token may carry different roles,
      // and the UI reads the cached user rather than the token.
      const fresh = await syncUserFromServer(userRef.current)
      if (fresh) {
        setUser(fresh)
        localStorage.setItem('tornUser', JSON.stringify(fresh))
      }
    }, 4 * 60 * 60 * 1000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  async function login(apiKey) {
    try {
      // Validate API key format (should be 16 characters)
      if (!apiKey || apiKey.length !== 16) {
        return {
          success: false,
          error: 'Invalid API key format. API keys must be exactly 16 characters.'
        }
      }

      // Self-hosted stack: the API owns the whole login flow (Torn
      // verification, role resolution, and JWT minting server-side).
      const result = await loginViaApi(apiKey)
      if (result.success) {
        setUser(result.user)
        localStorage.setItem('tornUser', JSON.stringify(result.user))
      }
      return result

    } catch (err) {
      console.error('Login error:', err)
      return {
        success: false,
        error: 'An unexpected error occurred during login. Please try again.'
      }
    }
  }

  function logout() {
    clearApiSession()
    setUser(null)
    localStorage.removeItem('tornUser')
  }

  // Wrap login() so a successful re-auth clears any "your key was invalid"
  // banner from the previous session. Failures keep the banner visible.
  async function loginAndClearError(apiKey) {
    const result = await login(apiKey)
    if (result.success) setAuthError(null)
    return result
  }

  const isLeadership = user?.isLeadership || false
  const isAdminFlag  = user?.isAdmin || false
  const isWarLead    = user?.isWarLead || false
  // OC Manager is a config-list role (like warlead) derived live from the id,
  // so we don't need to thread a flag through every login() branch. In API
  // mode the flag comes from DB-assigned roles instead.
  const isOCManagerFlag = user?.isOCManager || config.ocmanagerUserIds.includes(String(user?.id))

  const value = {
    user,
    isAuthenticated: !!user,
    isLeadership,
    isAdmin: isAdminFlag,
    isWarLead,
    isOCManager: isOCManagerFlag,
    // War Overview is available to leadership, admins, and warleads —
    // anyone whose role meaningfully owns or co-owns ranked-war planning.
    // ⚠️ The deprecated read-only `visitor` role was a fourth term here until
    // #922 removed it (2026-10-06); no member held it.
    canAccessWarOverview: isLeadership || isAdminFlag || isWarLead,
    // OC Planner is for OC Managers, plus leadership/admins as a superset.
    canAccessOCPlanner: isOCManagerFlag || isLeadership || isAdminFlag,
    loading,
    tokenReady,
    authError,
    clearAuthError: () => setAuthError(null),
    login: loginAndClearError,
    logout,
  }

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}