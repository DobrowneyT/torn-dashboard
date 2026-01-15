import { createContext, useContext, useState, useEffect } from 'react'
import { config } from '../config'
import { getTornErrorMessage } from '../utils/apiUtils'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  // Check for existing session on mount
  useEffect(() => {
    const savedUser = localStorage.getItem('tornUser')
    if (savedUser) {
      try {
        const userData = JSON.parse(savedUser)
        setUser(userData)
      } catch (err) {
        console.error('Error loading saved user:', err)
        localStorage.removeItem('tornUser')
      }
    }
    setLoading(false)
  }, [])

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

      // NON-LEADERSHIP USERS: Validate API access level
      const accessLevel = data.info?.access?.level
      const hasFactionAccess = data.info?.access?.faction

      if (!hasFactionAccess) {
        return {
          success: false,
          error: 'Insufficient permissions. Your API key does not have faction access enabled. Please create a new API key with faction permissions.'
        }
      }

      if (accessLevel < 2) {
        return {
          success: false,
          error: 'Insufficient permissions. Your API key has limited access. Please create a Full Access or Limited Access API key.'
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
    setUser(null)
    localStorage.removeItem('tornUser')
  }

  const value = {
    user,
    isAuthenticated: !!user,
    isLeadership: user?.isLeadership || false,
    isAdmin: user?.isAdmin || false,
    loading,
    login,
    logout
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