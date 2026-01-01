import { useState, useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { config } from '../config'

export default function StatsOverview({ cprData, crimesData }) {
  const { user } = useAuth()
  const [currentMemberCount, setCurrentMemberCount] = useState(null)
  const [lastOCPayout, setLastOCPayout] = useState(null)
  const [lastWarPay, setLastWarPay] = useState(null)

  // Fetch current faction member count
  useEffect(() => {
    async function fetchFactionMembers() {
      try {
        const factionId = config.faction.id
        const apiKey = user?.apiKey
        
        if (!apiKey) {
          setCurrentMemberCount(null)
          return
        }

        const response = await fetch(
          `https://api.torn.com/faction/${factionId}?selections=basic&key=${apiKey}`
        )
        
        if (response.ok) {
          const data = await response.json()
          const memberCount = Object.keys(data.members || {}).length
          setCurrentMemberCount(memberCount)
        }
      } catch (error) {
        console.error('Error fetching faction members:', error)
        setCurrentMemberCount(null)
      }
    }

    fetchFactionMembers()
  }, [user])

  // Get last OC payout from localStorage
  useEffect(() => {
    try {
      const savedPayouts = JSON.parse(localStorage.getItem('savedPayouts') || '[]')
      
      if (savedPayouts.length > 0) {
        // Sort by saved_at to get most recent
        const sorted = savedPayouts.sort((a, b) => 
          new Date(b.saved_at) - new Date(a.saved_at)
        )
        const mostRecent = sorted[0]
        setLastOCPayout(mostRecent.week_ending)
      }
    } catch (error) {
      console.error('Error loading last payout:', error)
      setLastOCPayout(null)
    }
  }, [])

  // Placeholder for last war pay (will be implemented later)
  useEffect(() => {
    // TODO: Implement war pay tracking
    setLastWarPay('Not tracked yet')
  }, [])

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      <StatCard 
        label="Current Members" 
        value={currentMemberCount !== null ? currentMemberCount : '...'} 
      />
      <StatCard 
        label="Last OC Payout" 
        value={lastOCPayout || 'No payouts saved'} 
      />
      <StatCard 
        label="Last War Pay" 
        value={lastWarPay || 'Not available'} 
      />
      <StatCard 
        label="Faction" 
        value={config.faction.name.split(' - ')[1] || config.faction.name} 
      />
    </div>
  )
}

function StatCard({ label, value }) {
  return (
    <div className="card hover:shadow-md transition-shadow">
      <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">{value}</div>
      <div className="text-sm text-gray-600 dark:text-gray-400 uppercase tracking-wide mt-1">
        {label}
      </div>
    </div>
  )
}