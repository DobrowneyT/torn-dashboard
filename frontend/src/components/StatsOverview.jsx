import { useState, useEffect } from 'react'
import { supabase } from '../utils/supabase'

export default function StatsOverview() {
  const [stats, setStats] = useState({
    totalMembers: 0,
    totalCrimes: 0,
    successRate: 0
  })

  useEffect(() => {
    async function loadStats() {
      try {
        // Get current member count
        const { count: memberCount } = await supabase
          .from('members')
          .select('*', { count: 'exact', head: true })
          .eq('is_current', true)

        // Get crime stats
        const { data: crimeStats } = await supabase
          .from('crime_stats')
          .select('*')

        const totalCrimes = crimeStats?.reduce((sum, s) => sum + (s.count || 0), 0) || 0
        const successfulCrimes = crimeStats
          ?.filter(s => s.status === 'Successful' || s.status === 'Success')
          .reduce((sum, s) => sum + (s.count || 0), 0) || 0
        const successRate = totalCrimes > 0 ? (successfulCrimes / totalCrimes) * 100 : 0

        setStats({
          totalMembers: memberCount || 0,
          totalCrimes,
          successRate
        })
      } catch (error) {
        console.error('Error loading stats:', error)
      }
    }

    loadStats()
  }, [])

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
      <StatCard
        label="Active Members"
        value={stats.totalMembers}
        icon="👥"
      />
      <StatCard
        label="Total Crimes"
        value={stats.totalCrimes}
        icon="🎯"
      />
      <StatCard
        label="Success Rate"
        value={`${stats.successRate.toFixed(1)}%`}
        icon="✓"
      />
    </div>
  )
}

function StatCard({ label, value, icon }) {
  return (
    <div className="bg-white dark:bg-slate-800 rounded-lg shadow p-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-gray-600 dark:text-gray-400">{label}</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white mt-1">{value}</p>
        </div>
        <div className="text-4xl">{icon}</div>
      </div>
    </div>
  )
}