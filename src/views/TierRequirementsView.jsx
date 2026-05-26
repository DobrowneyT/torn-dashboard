import { useState, useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../utils/supabase'
import { config } from '../config'
import { Check, X } from 'lucide-react'

export default function TierRequirementsView() {
  const { user } = useAuth()
  const [userCpr, setUserCpr] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetchUserCpr() {
      if (!user?.id) {
        setLoading(false)
        return
      }

      try {
        const { data, error } = await supabase
          .from('member_cpr_v2')
          .select('crime_name, difficulty, position_label, cpr_value')
          .eq('member_id', user.id.toString())

        if (error) throw error

        // Build lookup: { "crime:position_label" -> cpr_value }
        // Also build { difficulty: [values] } for average tier checks
        const cprMap = {}
        const cprByLevel = {}

        for (const row of (data || [])) {
          const key = `${row.crime_name}:${row.position_label}`
          cprMap[key] = parseFloat(row.cpr_value)

          const lvl = row.difficulty
          if (!cprByLevel[lvl]) cprByLevel[lvl] = []
          cprByLevel[lvl].push(parseFloat(row.cpr_value))
        }

        // Compute averages per level for average-type requirements
        for (const [level, values] of Object.entries(cprByLevel)) {
          cprMap[`avg:${level}`] = values.reduce((a, b) => a + b, 0) / values.length
        }

        setUserCpr(cprMap)
      } catch (error) {
        console.error('Error fetching user CPR:', error)
        setUserCpr({})
      } finally {
        setLoading(false)
      }
    }

    fetchUserCpr()
  }, [user?.id])

  return (
    <div className="space-y-6">
      <div className="card">
        <h2 className="text-xl font-semibold mb-4">Tier Requirements & Progression</h2>
        <p className="text-gray-600 dark:text-gray-400 mb-6">
          Members must meet at least 2/3 of requirements for each tier to qualify.
        </p>
        {loading && (
          <p className="text-sm text-gray-500 dark:text-gray-400">Loading your CPR data...</p>
        )}
      </div>
      {Object.entries(config.tierRequirements).sort(([a], [b]) => parseInt(a) - parseInt(b)).map(([tier, requirements]) => (
        <TierCard key={tier} tier={parseInt(tier)} requirements={requirements} userCpr={userCpr} />
      ))}
    </div>
  )
}

/**
 * Check a single requirement against user CPR data.
 * @returns {'pass' | 'fail' | 'unknown'}
 */
export function checkRequirement(req, userCpr) {
  if (!userCpr) return 'unknown'

  let value
  if (req.isAverage) {
    value = userCpr[`avg:${req.level}`]
  } else {
    value = userCpr[`${req.crime}:${req.role}`]
  }

  if (value === undefined || value === null) return 'unknown'
  return value >= req.minCpr ? 'pass' : 'fail'
}

function getRequirementCpr(req, userCpr) {
  if (!userCpr) return null
  if (req.isAverage) return userCpr[`avg:${req.level}`] ?? null
  return userCpr[`${req.crime}:${req.role}`] ?? null
}

function TierCard({ tier, requirements, userCpr }) {
  const tickets = config.payoutTickets[tier]
  const requiredCount = Math.ceil(requirements.length * (2/3))
  const borderColors = {1:'border-tier-1',2:'border-tier-2',3:'border-tier-3',4:'border-tier-4',5:'border-tier-5',6:'border-tier-6'}

  // Count how many requirements the user meets
  const statuses = requirements.map(req => checkRequirement(req, userCpr))
  const passCount = statuses.filter(s => s === 'pass').length
  const qualifies = passCount >= requiredCount

  return (
    <div className={`card border-l-4 ${borderColors[tier]}`}>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-4">
        <div className="flex items-center gap-3 flex-wrap">
          <TierBadge tier={tier} />
          <h3 className="text-base sm:text-lg font-semibold">Requirements</h3>
          {userCpr && (
            <span className={`text-sm font-medium px-2 py-0.5 rounded ${qualifies ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400' : 'bg-gray-100 text-gray-600 dark:bg-slate-700 dark:text-gray-400'}`}>
              {passCount}/{requirements.length} met
            </span>
          )}
        </div>
        <div className="text-sm text-gray-600 dark:text-gray-400">{tickets} payout tickets</div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        {requirements.map((req, idx) => {
          const status = statuses[idx]
          const actualValue = getRequirementCpr(req, userCpr)
          return (
            <RequirementRow key={idx} req={req} status={status} actualValue={actualValue} />
          )
        })}
      </div>
      <p className="text-sm text-gray-600 dark:text-gray-400">
        Must meet {requiredCount} out of {requirements.length} requirements
        {userCpr && qualifies && ' — You qualify!'}
      </p>
    </div>
  )
}

function RequirementRow({ req, status, actualValue }) {
  // Derive difficulty level from cprRequirements for display
  const difficulty = req.isAverage ? req.level : config.cprRequirements[req.crime]?.difficulty

  const label = req.isAverage
    ? `Level ${req.level} Average ≥ ${req.minCpr} CPR`
    : `Lv${difficulty || '?'} ${req.role} · ${req.crime} ≥ ${req.minCpr} CPR`

  const statusConfig = {
    pass: {
      icon: (
        <Check className="w-5 h-5 text-green-500" />
      ),
      bg: 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800'
    },
    fail: {
      icon: (
        <X className="w-5 h-5 text-red-500" />
      ),
      bg: 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800'
    },
    unknown: {
      icon: (
        <span className="w-5 h-5 flex items-center justify-center text-yellow-500 font-bold text-lg">?</span>
      ),
      bg: 'bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800'
    }
  }

  const cfg = statusConfig[status] || statusConfig.unknown

  return (
    <div className={`flex items-center gap-2 p-3 rounded-lg ${cfg.bg}`}>
      {cfg.icon}
      <span className="text-sm flex-1 truncate">{label}</span>
      {actualValue !== undefined && actualValue !== null && (
        <span className={`text-xs font-mono flex-shrink-0 ${status === 'pass' ? 'text-green-600 dark:text-green-400' : status === 'fail' ? 'text-red-600 dark:text-red-400' : 'text-yellow-600 dark:text-yellow-400'}`}>
          {Math.round(actualValue)}
        </span>
      )}
    </div>
  )
}

function TierBadge({ tier }) {
  const colors = {1:'bg-tier-1',2:'bg-tier-2',3:'bg-tier-3',4:'bg-tier-4',5:'bg-tier-5',6:'bg-tier-6'}
  return <span className={`inline-block px-3 py-1 rounded-lg text-white font-semibold ${colors[tier]}`}>Tier {tier}</span>
}
