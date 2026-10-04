import { createContext, useContext, useState, useEffect } from 'react'
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

  const roles = boot.user.roles
  const userObj = {
    id: Number(boot.user.torn_user_id),
    // Roster name from bootstrap (login stubs it from Torn on first login);
    // the id-based fallback covers visitors, who are never on the roster.
    name: boot.user.member_name || `Player ${boot.user.torn_user_id}`,
    factionId: null,
    factionPosition: roles.includes('leadership') ? 'Leadership'
      : roles.includes('admin') ? 'Admin'
      : roles.includes('visitor') ? 'Visitor'
      : 'Member',
    // Deliberately NO apiKey: in API mode the browser holds only the session
    // token — raw key material never reaches localStorage (visitors included).
    accessLevel: 3,
    isLeadership: roles.includes('leadership'),
    isAdmin: roles.includes('admin'),
    isWarLead: roles.includes('warlead'),
    isOCManager: roles.includes('ocmanager'),
    isVisitor: roles.includes('visitor'),
    // Whether the in-app feedback form is available (server has a PAT) — the
    // hamburger "Send feedback" entry is hidden when false (#253).
    feedbackEnabled: boot.feedback_enabled === true,
    // Last 4 chars of this user's own pooled key (#264) — shown masked in the
    // hamburger menu; null when no key is on file (e.g. visitors).
    apiKeyHint: boot.user.api_key_hint ?? null,
    // #894 — the API Key Usage disclosure this member last accepted, and
    // whether it is behind the current one. ⚠️ Both, not just the boolean:
    // without the version the client can show that somebody must re-accept but
    // never what changed.
    consentVersion: boot.user.consent_version ?? null,
    consentRequired: boot.user.consent_required === true,
    apiMode: true,
    lastLogin: new Date().toISOString(),
  }
  return { success: true, user: userObj }
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
        revalidateSession().then(result => {
          if (!result.ok) {
            console.warn('Session revalidation: forcing logout —', result.reason)
            clearApiSession()
            setUser(null)
            localStorage.removeItem('tornUser')
            setAuthError(result.reason)
          }
        })
      } catch (err) {
        console.error('Error loading saved user:', err)
        localStorage.removeItem('tornUser')
      }
    }
    identityReady.finally(() => setLoading(false))
  }, [])

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
    const timer = setInterval(() => { apiRefresh() }, 4 * 60 * 60 * 1000)
    return () => clearInterval(timer)
  }, [user])

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
  // Visitor is also derived live from the config list (belt-and-braces on top
  // of the persisted flag) so removing an ID from the list revokes access on
  // the next app load even before revalidation runs.
  const isVisitorFlag = user?.isVisitor || config.visitorUserIds.includes(String(user?.id))

  const value = {
    user,
    isAuthenticated: !!user,
    isLeadership,
    isAdmin: isAdminFlag,
    isWarLead,
    isOCManager: isOCManagerFlag,
    // Read-only demo profile: sees everything leadership sees, saves nothing.
    isVisitor: isVisitorFlag,
    // War Overview is available to leadership, admins, and warleads —
    // anyone whose role meaningfully owns or co-owns ranked-war planning.
    // Visitors get view access to everything role-gated.
    canAccessWarOverview: isLeadership || isAdminFlag || isWarLead || isVisitorFlag,
    // OC Planner is for OC Managers, plus leadership/admins as a superset.
    canAccessOCPlanner: isOCManagerFlag || isLeadership || isAdminFlag || isVisitorFlag,
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