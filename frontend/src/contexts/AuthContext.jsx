import { createContext, useContext, useState, useEffect } from 'react'
import { config } from '../config'
import { loadFactionIdentity } from '../utils/factionIdentity'
import { getTornErrorMessage } from '../utils/apiUtils'
import { submitApiKey, setVisitorReadOnly } from '../utils/adminApi'
import * as sessionToken from '../utils/sessionToken'
import {
  API_MODE,
  apiLogin,
  apiBootstrap,
  apiSessionValid,
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

// Persist the member's consented key + ToS acceptance into member_secrets so it
// joins the rotating pool (War Room + scrapers) and the CPR scraper. Best-effort:
// the key already validated, so a transient storage hiccup must not block login —
// the pool just won't include this key until the next successful store.
async function persistConsentedKey(apiKey, rank) {
  try {
    await submitApiKey(apiKey, apiKey, {
      rank: rank ?? null,
      consentVersion: config.apiKey.consentVersion,
    })
  } catch (e) {
    console.warn('Could not persist consented API key:', e?.message || e)
  }
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
    // The API session token is the authority; when it lapses, re-login re-runs
    // the server-side Torn + role checks.
    return apiSessionValid()
      ? { ok: true }
      : { ok: false, reason: 'Your session expired. Please log in again.' }
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

      // Fetch key info from Torn API v2
      const response = await fetch(`https://api.torn.com/v2/key/info?key=${apiKey}`)

      if (!response.ok) {
        return {
          success: false,
          error: 'Failed to connect to Torn API. Please try again.'
        }
      }

      const data = await response.json()

      // Check for Torn API errors
      if (data.error) {
        return {
          success: false,
          error: getTornErrorMessage(data.error)
        }
      }

      // Get user ID and check permissions FIRST
      const userId = data.info.user.id
      const isLeader = config.leadershipUserIds.includes(String(userId))
      const isAdminUser = config.adminsUserIds.includes(String(userId))
      const isWarLeadUser = config.warleadUserIds.includes(String(userId))
      const isVisitorUser = config.visitorUserIds.includes(String(userId))

      // Get faction info
      const userFactionId = data.info?.user?.faction_id
      const requiredFactionId = parseInt(config.faction.id)

      // 2.0: the single consolidated key must be Limited Access (level 3+) for
      // EVERYONE — it powers identity, CPR, the War Room rotation pool, and the
      // faction scrapers. This is independent of `access.faction`, which is
      // false for Recruits; Recruits with a Limited key still log in fine (we
      // just flag their key so faction-scoped pool usage skips it).
      const accessLevel = data.info?.access?.level ?? 0
      if (accessLevel < config.apiKey.requiredLevel) {
        return {
          success: false,
          error: 'This dashboard needs a Limited Access key. Use the "Generate Limited Key" button below, then paste the new key here.',
        }
      }

      // LEADERSHIP USERS: Skip all permission checks
      if (isLeader) {
        console.log(`Leadership user ${userId} detected - bypassing all permission checks`)

        // Fetch user details for name and faction position
        const userResponse = await fetch(`https://api.torn.com/user/?selections=profile&key=${apiKey}`)
        const userData = await userResponse.json()

        if (userData.error) {
          return {
            success: false,
            error: getTornErrorMessage(userData.error)
          }
        }

        // Create user object for leadership user
        const userObj = {
          id: userId,
          name: userData.name,
          factionId: userFactionId || null,
          factionPosition: userData.faction?.position || 'Leadership',
          apiKey: apiKey,
          accessLevel: data.info?.access?.level || 1,
          isLeadership: true,
          isAdmin: isAdminUser,
          isWarLead: isWarLeadUser,
          consentVersion: config.apiKey.consentVersion,
          lastLogin: new Date().toISOString()
        }

        // Store the consented key (leaders' keys feed the pool too) then save.
        await persistConsentedKey(apiKey, userObj.factionPosition)
        setUser(userObj)
        localStorage.setItem('tornUser', JSON.stringify(userObj))

        return {
          success: true,
          user: userObj
        }
      }

      // VISITOR USERS: read-only demo access for allied faction leaders.
      // Skips faction validation like admins, but the key is used for
      // identity + session-token minting ONLY — it is never persisted to
      // member_secrets, so it can't join the CPR/War-Room rotation pool.
      if (isVisitorUser && !isLeader && !isAdminUser) {
        const userResponse = await fetch(`https://api.torn.com/user/?selections=profile&key=${apiKey}`)
        const userData = await userResponse.json()

        if (userData.error) {
          return {
            success: false,
            error: getTornErrorMessage(userData.error)
          }
        }

        const userObj = {
          id: userId,
          name: userData.name,
          factionId: userFactionId || null,
          factionPosition: userData.faction?.position || 'Visitor',
          apiKey: apiKey,
          accessLevel: data.info?.access?.level || 1,
          isLeadership: false,
          isAdmin: false,
          isWarLead: false,
          isVisitor: true,
          consentVersion: config.apiKey.consentVersion,
          lastLogin: new Date().toISOString()
        }

        // NOTE: deliberately NO persistConsentedKey() here — visitor keys
        // must never enter the rotation pool.
        setUser(userObj)
        localStorage.setItem('tornUser', JSON.stringify(userObj))

        return {
          success: true,
          user: userObj
        }
      }

      // ADMIN USERS: Skip faction validation
      if (isAdminUser) {
        console.log(`Admin user ${userId} detected - bypassing faction checks`)

        // Fetch user details for name
        const userResponse = await fetch(`https://api.torn.com/user/?selections=profile&key=${apiKey}`)
        const userData = await userResponse.json()

        if (userData.error) {
          return {
            success: false,
            error: getTornErrorMessage(userData.error)
          }
        }

        // Create user object for admin user
        const userObj = {
          id: userId,
          name: userData.name,
          factionId: userFactionId || null,
          factionPosition: userData.faction?.position || 'Admin',
          apiKey: apiKey,
          accessLevel: data.info?.access?.level || 1,
          isLeadership: isLeader,
          isAdmin: true,
          isWarLead: isWarLeadUser,
          consentVersion: config.apiKey.consentVersion,
          lastLogin: new Date().toISOString()
        }

        await persistConsentedKey(apiKey, userObj.factionPosition)
        setUser(userObj)
        localStorage.setItem('tornUser', JSON.stringify(userObj))

        return {
          success: true,
          user: userObj
        }
      }

      if (!userFactionId) {
        return {
          success: false,
          error: 'You are not currently in a faction. Please join The Next Level - Forge to access this dashboard.'
        }
      }

      if (userFactionId !== requiredFactionId) {
        return {
          success: false,
          error: `Incorrect faction. This dashboard is for ${config.faction.name} members only.`
        }
      }

      // Access level was already validated above (Limited, uniform for all
      // roles). We do NOT additionally require `access.faction` — Recruits have
      // it false but still get full access to everything the site reads from
      // Supabase via their JWT; their key is simply flagged out of the
      // faction-scoped rotation pool until they're off Recruit.

      // NON-LEADERSHIP USERS: Fetch user details for name and faction position
      const userResponse = await fetch(`https://api.torn.com/user/?selections=profile&key=${apiKey}`)
      const userData = await userResponse.json()

      if (userData.error) {
        return {
          success: false,
          error: getTornErrorMessage(userData.error)
        }
      }

      // Create user object for non-leadership user
      const userObj = {
        id: userId,
        name: userData.name,
        factionId: userFactionId,
        factionPosition: userData.faction?.position || 'Member',
        apiKey: apiKey,
        accessLevel: accessLevel,
        isLeadership: isLeader,
        isAdmin: false,
        isWarLead: isWarLeadUser,
        consentVersion: config.apiKey.consentVersion,
        lastLogin: new Date().toISOString()
      }

      // Store the consented key (powers CPR + the rotation pool) then save.
      await persistConsentedKey(apiKey, userObj.factionPosition)
      setUser(userObj)
      localStorage.setItem('tornUser', JSON.stringify(userObj))

      return {
        success: true,
        user: userObj
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