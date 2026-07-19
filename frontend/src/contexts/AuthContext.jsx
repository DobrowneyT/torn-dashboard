import { createContext, useContext, useState, useEffect } from 'react'
import { config } from '../config'
import { loadFactionIdentity } from '../utils/factionIdentity'
import { getTornErrorMessage } from '../utils/apiUtils'
import { setVisitorReadOnly } from '../utils/adminApi'
import * as sessionToken from '../utils/sessionToken'
import {
  API_MODE,
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
    apiMode: true,
    lastLogin: new Date().toISOString(),
  }
  return { success: true, user: userObj }
}

const AuthContext = createContext(null)

// Torn /v2/key/info error codes that mean the saved key is fundamentally
// no longer usable for this site. Hitting any of these on revalidation
// forces a logout with a friendly reason; transient codes (5/8/9/14/15/17)
// are ignored so a rate-limit blip doesn't kick everyone out.
const FATAL_REVAL_CODES = new Set([
  2,   // Incorrect API key format
  7,   // Access denied (private)
  13,  // Key disabled due to inactivity
  16,  // Insufficient permissions
  18,  // Key paused
])

// Re-verify the saved API key against Torn. Returns { ok: true } when the
// session can stay live, or { ok: false, reason } when the user must be
// kicked back to the login modal. Network/HTTP failures default to ok=true
// so transient outages don't log everyone out — a fatal verdict only
// comes from an unambiguous "this key is invalid" response.
async function revalidateSession(savedUser) {
  if (API_MODE) {
    // Remember-me sessions (#119): tokens live 30 days but only act for 24h
    // from their last verification, so on load we silently REFRESH rather
    // than merely check expiry — the server re-verifies roster membership +
    // roles and mints a fresh token. Only an unambiguous server verdict
    // (401 expired / 403 kicked) tears the session down; network failures
    // are transient and must not log anyone out.
    if (!getApiSession()) {
      return { ok: false, reason: 'Your session expired. Please log in again.' }
    }
    const refreshed = await apiRefresh()
    if (refreshed.ok || refreshed.transient) return { ok: true }
    return {
      ok: false,
      reason: refreshed.status === 403
        ? 'Your faction access was removed. Contact your leadership if this is unexpected.'
        : 'Your session expired. Please log in again.',
    }
  }
  if (!savedUser?.apiKey) {
    return { ok: false, reason: 'Saved session is missing its API key. Please log in again.' }
  }
  let data
  try {
    const resp = await fetch(`https://api.torn.com/v2/key/info?key=${savedUser.apiKey}`)
    if (!resp.ok) return { ok: true }   // Network / 5xx — treat as transient
    data = await resp.json()
  } catch (e) {
    console.warn('Session revalidation failed (transient):', e)
    return { ok: true }
  }

  if (data.error) {
    if (FATAL_REVAL_CODES.has(data.error.code)) {
      return {
        ok: false,
        reason: `Your saved API key is no longer valid: ${getTornErrorMessage(data.error)} Please log in again.`,
      }
    }
    return { ok: true }   // Transient Torn error — keep session
  }

  const liveUserId = data.info?.user?.id
  if (liveUserId && String(liveUserId) !== String(savedUser.id)) {
    return {
      ok: false,
      reason: 'Your API key now belongs to a different Torn account. Please log in again with your own key.',
    }
  }

  // Leadership + admin + visitor users bypass faction/access checks at login
  // (see login() below); mirror that here so the revalidator doesn't kick out
  // a leader (or read-only visitor from another faction) whose key still works.
  const idStr = String(savedUser.id)
  const isLeader = config.leadershipUserIds.includes(idStr)
  const isAdminUser = config.adminsUserIds.includes(idStr)
  const isVisitorUser = config.visitorUserIds.includes(idStr)
  if (isLeader || isAdminUser || isVisitorUser) return { ok: true }

  const requiredFactionId = parseInt(config.faction.id)
  const liveFactionId = data.info?.user?.faction_id
  if (!liveFactionId || liveFactionId !== requiredFactionId) {
    return {
      ok: false,
      reason: `You're no longer a member of ${config.faction.name}. Please log in again with a faction-member key.`,
    }
  }
  const liveAccessLevel = data.info?.access?.level ?? 0
  if (liveAccessLevel < config.apiKey.requiredLevel) {
    return {
      ok: false,
      reason: 'Your API key no longer has Limited Access. Please generate a new Limited key in Torn Preferences and log in again.',
    }
  }
  return { ok: true }
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
        revalidateSession(userData).then(result => {
          if (!result.ok) {
            console.warn('Session revalidation: forcing logout —', result.reason)
            sessionToken.clear()
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

  // Keep the session-token module in sync with whoever is logged in.
  // configure() is non-blocking — login completes regardless of whether the
  // mint succeeds. Until tokenReady flips true, supabase calls fall back to
  // the anon key (graceful degradation, see src/utils/supabase.js).
  useEffect(() => {
    // Flip the adminApi read-only latch for visitors so every write path
    // fails fast with a friendly message instead of a server 403.
    setVisitorReadOnly(
      !!user && (user.isVisitor || config.visitorUserIds.includes(String(user.id)))
    )
    if (API_MODE) {
      // No Supabase session token to mint — the API session token is the
      // only credential. (Minting here caused POSTs to
      // {undefined}/functions/v1/war-room-fetch on every page.)
      setTokenReady(!!user)
      return
    }
    sessionToken.configure(user)
    const unsubscribe = sessionToken.subscribeToReady(setTokenReady)
    return unsubscribe
  }, [user])

  // Keep a long-lived tab's session fresh (#119): tokens only act for 24h from
  // their last verification, so refresh well inside that window while the app
  // is open. A 401 mid-use is still self-healed by apiClient's refresh-retry;
  // this just keeps the WebSocket connect (which can't retry a handshake as
  // gracefully) working across day-spanning war-room sessions.
  useEffect(() => {
    if (!API_MODE || !user) return
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

      // Self-hosted stack: the API owns the whole login flow.
      if (API_MODE) {
        const result = await loginViaApi(apiKey)
        if (result.success) {
          setUser(result.user)
          localStorage.setItem('tornUser', JSON.stringify(result.user))
        }
        return result
      }

      // API_MODE is always true for this stack (self-hosted, VITE_API_MODE=true
      // at build time) — nothing reaches past here in production. Kept as a
      // defensive fallback rather than throwing, matching login()'s existing
      // error-result contract.
      return {
        success: false,
        error: 'This dashboard is API-mode only. Please contact an admin.'
      }

    } catch (err) {
      console.error('Login error:', err)
      return {
        success: false,
        error: 'An unexpected error occurred during login. Please try again.'
      }
    }
  }

  function logout() {
    sessionToken.clear()
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