import React, { createContext, useContext, useState, useEffect } from 'react'
import { config } from '../config'

const AuthContext = createContext()

export function useAuth() {
  return useContext(AuthContext)
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Load saved session on mount
  useEffect(() => {
    const savedUser = localStorage.getItem('tornForgeUser')
    if (savedUser) {
      try {
        const userData = JSON.parse(savedUser)
        // Verify the session is still valid
        verifySession(userData)
      } catch (err) {
        console.error('Failed to restore session:', err)
        localStorage.removeItem('tornForgeUser')
        setLoading(false)
      }
    } else {
      setLoading(false)
    }
  }, [])

  async function verifySession(userData) {
    try {
      // Re-verify with Torn API
      const response = await fetch(
        `https://api.torn.com/user/?selections=profile,discord&key=${userData.apiKey}`
      )
      
      if (!response.ok) {
        throw new Error('Session expired or invalid API key')
      }

      const data = await response.json()
      
      // Check if still in faction
      if (data.faction.faction_id !== parseInt(import.meta.env.VITE_FACTION_ID || '46427')) {
        throw new Error('You are no longer in the faction')
      }

      // Update user data with fresh info
      const updatedUser = {
        ...userData,
        name: data.name,
        factionPosition: data.faction.position,
        level: data.level
      }

      setUser(updatedUser)
      localStorage.setItem('tornForgeUser', JSON.stringify(updatedUser))
    } catch (err) {
      console.error('Session verification failed:', err)
      logout()
    } finally {
      setLoading(false)
    }
  }

  async function login(apiKey) {
    setLoading(true)
    setError(null)

    try {
      // Fetch user data from Torn API
      const response = await fetch(
        `https://api.torn.com/user/?selections=profile,discord&key=${apiKey}`
      )

      if (!response.ok) {
        throw new Error('Invalid API key')
      }

      const data = await response.json()

      // Check for API error
      if (data.error) {
        throw new Error(data.error.error || 'API error')
      }

      // Verify user is in the correct faction
      const factionId = parseInt(import.meta.env.VITE_FACTION_ID || '46427')
      if (data.faction.faction_id !== factionId) {
        throw new Error('You are not a member of this faction')
      }

      // Determine user role
      const position = data.faction.position
      const isOfficialLeadership = ['Leader', 'Co-leader'].includes(position)
      const isCustomLeadership = config.leadershipUserIds.includes(data.player_id)
      const isLeadership = isOfficialLeadership || isCustomLeadership

      const userData = {
        id: data.player_id,
        name: data.name,
        level: data.level,
        factionId: data.faction.faction_id,
        factionName: data.faction.faction_name,
        factionPosition: position,
        isLeadership: isLeadership,
        leadershipType: isOfficialLeadership ? 'official' : (isCustomLeadership ? 'custom' : 'none'),
        apiKey: apiKey, // Store for future API calls
        loginTime: new Date().toISOString()
      }

      setUser(userData)
      localStorage.setItem('tornForgeUser', JSON.stringify(userData))
      
      return { success: true, user: userData }
    } catch (err) {
      const errorMessage = err.message || 'Authentication failed'
      setError(errorMessage)
      return { success: false, error: errorMessage }
    } finally {
      setLoading(false)
    }
  }

  function logout() {
    setUser(null)
    setError(null)
    localStorage.removeItem('tornForgeUser')
  }

  const value = {
    user,
    loading,
    error,
    login,
    logout,
    isAuthenticated: !!user,
    isLeadership: user?.isLeadership || false
  }

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  )
}