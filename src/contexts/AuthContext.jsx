import { createContext, useContext, useState, useEffect } from 'react'
import { config } from '../config'
import { getTornErrorMessage } from '../utils/apiUtils'
import * as sessionToken from '../utils/sessionToken'

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

  // Leadership + admin users bypass faction/access checks at login (see
  // login() below); mirror that here so the revalidator doesn't kick out
  // a leader whose key still works.
  const idStr = String(savedUser.id)
  const isLeader = config.leadershipUserIds.includes(idStr)
  const isAdminUser = config.adminsUserIds.includes(idStr)
  if (isLeader || isAdminUser) return { ok: true }

  const requiredFactionId = parseInt(config.faction.id)
  const liveFactionId = data.info?.user?.faction_id
  if (!liveFactionId || liveFactionId !== requiredFactionId) {
    return {
      ok: false,
      reason: `You're no longer a member of ${config.faction.name}. Please log in again with a faction-member key.`,
    }
  }
  const liveAccessLevel = data.info?.access?.level ?? 0
  if (liveAccessLevel < 1) {
    return {
      ok: false,
      reason: 'Your API key no longer has Minimal Access. Please generate a new key in Torn Preferences and log in again.',
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
    setLoading(false)
  }, [])

  // Keep the session-token module in sync with whoever is logged in.
  // configure() is non-blocking — login completes regardless of whether the
  // mint succeeds. Until tokenReady flips true, supabase calls fall back to
  // the anon key (graceful degradation, see src/utils/supabase.js).
  useEffect(() => {
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

      // Get faction info
      const userFactionId = data.info?.user?.faction_id
      const requiredFactionId = parseInt(config.faction.id)

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
          lastLogin: new Date().toISOString()
        }

        // Save to state and localStorage
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
          lastLogin: new Date().toISOString()
        }

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

      // NON-LEADERSHIP USERS: validate API access level.
      // We intentionally DO NOT require `access.faction` here — Recruits
      // (3-day probationary status) have that flag set false by Torn even
      // though they are real faction members. They can still use everything
      // on this site that reads from Supabase via their JWT (gated by
      // faction_id claim, not key access level). Features that DO need
      // faction-level Torn API access (Fetch Crimes / Fetch Members / etc.)
      // are leadership-only at the UI layer, so a Recruit never hits them.
      // Minimal Access (level >= 1) is all the site itself needs.
      const accessLevel = data.info?.access?.level

      if (accessLevel < 1) {
        return {
          success: false,
          error: 'Insufficient permissions. Your API key needs at least Minimal Access. Create a new key in Torn Preferences and paste it here.'
        }
      }

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
        lastLogin: new Date().toISOString()
      }

      // Save to state and localStorage
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

  const value = {
    user,
    isAuthenticated: !!user,
    isLeadership,
    isAdmin: isAdminFlag,
    isWarLead,
    // War Overview is available to leadership, admins, and warleads —
    // anyone whose role meaningfully owns or co-owns ranked-war planning.
    canAccessWarOverview: isLeadership || isAdminFlag || isWarLead,
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