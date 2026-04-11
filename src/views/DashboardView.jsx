import { useState, useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../utils/supabase'
import { loadMemberPayoutHistory, loadMemberCrimeHistory, loadMemberLoanedItems } from '../utils/payoutDataLoader'
import { calculateTierProgress, getTierInfo } from '../utils/tierProgressUtils'
import { formatCurrency } from '../utils/payoutCalculations'
import { submitCprKey } from '../utils/adminApi'
import { config } from '../config'

export default function DashboardView() {
  const { user } = useAuth()
  const [loading, setLoading] = useState(true)
  const [memberData, setMemberData] = useState(null)
  const [payoutHistory, setPayoutHistory] = useState([])
  const [crimeHistory, setCrimeHistory] = useState([])
  const [loanedItems, setLoanedItems] = useState([])
  const [tierProgress, setTierProgress] = useState(null)
  const [showCprKeyModal, setShowCprKeyModal] = useState(false)

  useEffect(() => {
    if (user?.id) loadDashboard()
  }, [user?.id])

  async function loadDashboard() {
    setLoading(true)
    try {
      const memberId = user.id.toString()

      // Load member info + CPR in parallel with history data
      const [memberResult, cprResult, payouts, crimes, loaned] = await Promise.all([
        supabase.from('members').select('*').eq('member_id', memberId).single(),
        supabase.from('member_cpr').select('*').eq('member_id', memberId),
        loadMemberPayoutHistory(memberId).catch(() => []),
        loadMemberCrimeHistory(memberId, 20).catch(() => []),
        loadMemberLoanedItems(memberId).catch(() => []),
      ])

      // Build member data
      const member = memberResult.data
      if (member) {
        // Build CPR by role structure
        const cprByRole = {}
        for (const cpr of (cprResult.data || [])) {
          if (!cprByRole[cpr.difficulty_level]) cprByRole[cpr.difficulty_level] = {}
          cprByRole[cpr.difficulty_level][cpr.role_name] = parseFloat(cpr.cpr_value)
        }

        const effectiveTier = member.tier_override || member.tier || 6
        setMemberData({ ...member, cpr_by_role: cprByRole, effectiveTier })

        // Calculate tier progress
        const progress = calculateTierProgress(cprByRole, effectiveTier)
        setTierProgress(progress)
      }

      setPayoutHistory(payouts.slice(0, 8))
      setCrimeHistory(crimes)
      setLoanedItems(loaned)
    } catch (err) {
      console.error('Error loading dashboard:', err)
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-center">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600 mx-auto mb-3"></div>
          <p className="text-gray-500 dark:text-gray-400">Loading dashboard...</p>
        </div>
      </div>
    )
  }

  if (!memberData) {
    return (
      <div className="card text-center py-10">
        <p className="text-gray-500 dark:text-gray-400">Could not load your member data.</p>
        <p className="text-sm text-gray-400 dark:text-gray-500 mt-2">Make sure your account is registered in the faction database.</p>
      </div>
    )
  }

  const tierInfo = getTierInfo(memberData.effectiveTier)

  return (
    <div className="space-y-6">
      {/* Welcome Header */}
      <div className="card">
        <h2 className="text-xl font-semibold mb-1">
          Welcome, {memberData.member_name}
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Your personal OC dashboard — track your tier, payouts, and crime participation.
        </p>
      </div>

      {/* Top Row: Tier + Payout Summary */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Current Tier Card */}
        <CurrentTierCard tier={memberData.effectiveTier} tierInfo={tierInfo} />

        {/* Payout Summary Card */}
        <PayoutSummaryCard payoutHistory={payoutHistory} />
      </div>

      {/* CPR Scraper Key Card */}
      <CprKeyCard
        hasCprKey={!!memberData.cpr_api_key}
        onOpen={() => setShowCprKeyModal(true)}
      />

      {/* Tier Progress Card */}
      {tierProgress && tierProgress.nextTierProgress && (
        <TierProgressCard
          tierProgress={tierProgress}
          currentTier={memberData.effectiveTier}
        />
      )}

      {/* Crime Participation */}
      {crimeHistory.length > 0 && (
        <CrimeParticipationCard crimes={crimeHistory} />
      )}

      {/* Loaned Items */}
      {loanedItems.length > 0 && (
        <LoanedItemsCard items={loanedItems} />
      )}

      {/* CPR Key Modal */}
      {showCprKeyModal && (
        <CprKeyModal
          user={user}
          hasCprKey={!!memberData.cpr_api_key}
          onClose={() => setShowCprKeyModal(false)}
          onSuccess={(newKey) => {
            setMemberData(prev => ({ ...prev, cpr_api_key: newKey }))
            setShowCprKeyModal(false)
          }}
          onRemove={() => {
            setMemberData(prev => ({ ...prev, cpr_api_key: null }))
            setShowCprKeyModal(false)
          }}
        />
      )}
    </div>
  )
}

// ─── Sub-components ────────────────────────────────────────────────

function CurrentTierCard({ tier, tierInfo }) {
  const tierColors = {
    1: 'bg-tier-1', 2: 'bg-tier-2', 3: 'bg-tier-3',
    4: 'bg-tier-4', 5: 'bg-tier-5', 6: 'bg-tier-6',
  }
  const borderColors = {
    1: 'border-tier-1', 2: 'border-tier-2', 3: 'border-tier-3',
    4: 'border-tier-4', 5: 'border-tier-5', 6: 'border-tier-6',
  }

  return (
    <div className={`card border-l-4 ${borderColors[tier]}`}>
      <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-3">Current Tier</h3>
      <div className="flex items-center gap-4">
        <span className={`text-3xl font-bold text-white px-4 py-2 rounded-lg ${tierColors[tier]}`}>
          {tier}
        </span>
        <div>
          <p className="text-lg font-semibold text-gray-900 dark:text-white">{tierInfo.name}</p>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {tierInfo.tickets} payout tickets per week
          </p>
        </div>
      </div>
    </div>
  )
}

function PayoutSummaryCard({ payoutHistory }) {
  if (payoutHistory.length === 0) {
    return (
      <div className="card">
        <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-3">Recent Payouts</h3>
        <p className="text-gray-400 dark:text-gray-500 text-sm">No payout history available yet.</p>
      </div>
    )
  }

  const recentPayouts = payoutHistory.slice(0, 4)
  const total = recentPayouts.reduce((sum, p) => sum + (p.payout || 0), 0)
  const average = recentPayouts.length > 0 ? Math.floor(total / recentPayouts.length) : 0

  // Trend: compare most recent to previous
  let trend = null
  if (recentPayouts.length >= 2) {
    const current = recentPayouts[0].payout || 0
    const previous = recentPayouts[1].payout || 0
    if (previous > 0) {
      trend = ((current - previous) / previous * 100).toFixed(0)
    }
  }

  return (
    <div className="card">
      <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-3">Recent Payouts</h3>
      <div className="flex items-end gap-4 mb-4">
        <div>
          <p className="text-2xl font-bold text-gray-900 dark:text-white">
            {formatCurrency(recentPayouts[0]?.payout || 0)}
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400">Latest week</p>
        </div>
        {trend !== null && (
          <span className={`text-sm font-medium ${
            parseFloat(trend) >= 0 ? 'text-green-600' : 'text-red-500'
          }`}>
            {parseFloat(trend) >= 0 ? '+' : ''}{trend}% vs prior
          </span>
        )}
      </div>
      <div className="space-y-2">
        {recentPayouts.map((p, i) => (
          <div key={i} className="flex justify-between text-sm">
            <span className="text-gray-500 dark:text-gray-400">
              {p.week_start ? `${p.week_start}` : `Week ${i + 1}`}
            </span>
            <span className="font-medium text-gray-900 dark:text-white">
              {formatCurrency(p.payout || 0)}
            </span>
          </div>
        ))}
      </div>
      {recentPayouts.length > 1 && (
        <p className="text-xs text-gray-400 dark:text-gray-500 mt-3">
          {recentPayouts.length}-week average: {formatCurrency(average)}
        </p>
      )}
    </div>
  )
}

function TierProgressCard({ tierProgress, currentTier }) {
  const next = tierProgress.nextTierProgress
  if (!next) return null

  const nextTierInfo = getTierInfo(next.tier)
  const progressPercent = Math.min(next.progressPercent, 100)

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400">
          Progress to Tier {next.tier} ({nextTierInfo.name})
        </h3>
        <span className="text-sm text-gray-500 dark:text-gray-400">
          {next.metCount}/{next.requiredCount} required ({next.metCount}/{next.totalRequirements} total)
        </span>
      </div>

      {/* Progress bar */}
      <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-3 mb-4">
        <div
          className={`h-3 rounded-full transition-all ${
            next.qualified ? 'bg-green-500' : 'bg-blue-500'
          }`}
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      {next.qualified && (
        <div className="mb-4 p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg">
          <p className="text-sm text-green-700 dark:text-green-300 font-medium">
            You qualify for Tier {next.tier}! Contact leadership for a tier review.
          </p>
        </div>
      )}

      {/* Requirements list */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {next.requirements.map((req, i) => (
          <div
            key={i}
            className={`flex items-center gap-2 p-2 rounded-lg text-sm ${
              req.met
                ? 'bg-green-50 dark:bg-green-900/20'
                : 'bg-gray-50 dark:bg-slate-700/50'
            }`}
          >
            {req.met ? (
              <svg className="w-4 h-4 text-green-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            )}
            <span className={req.met ? 'text-green-700 dark:text-green-300' : 'text-gray-600 dark:text-gray-300'}>
              {req.isAverage ? `Lv${req.level} Avg` : `Lv${req.level} ${req.role}`} {'>'}= {req.minCpr}
            </span>
            {req.currentCpr !== null && (
              <span className={`ml-auto text-xs ${req.met ? 'text-green-600' : 'text-gray-400'}`}>
                ({req.currentCpr.toFixed(0)})
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function CrimeParticipationCard({ crimes }) {
  const recentCrimes = crimes.slice(0, 10)

  const statusCounts = { Successful: 0, Failed: 0, Planning: 0, Recruiting: 0 }
  for (const c of crimes) {
    const s = c.status
    // Torn API uses both 'Failed' and 'Failure' for failed crimes
    if (s === 'Failure') {
      statusCounts.Failed++
    } else if (statusCounts[s] !== undefined) {
      statusCounts[s]++
    }
  }

  const total = statusCounts.Successful + statusCounts.Failed
  const successRate = total > 0 ? ((statusCounts.Successful / total) * 100).toFixed(0) : '-'

  return (
    <div className="card">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 mb-4">
        <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400">Crime Participation</h3>
        <div className="flex gap-3 text-xs">
          <span className="text-green-600">{statusCounts.Successful} success</span>
          <span className="text-red-500">{statusCounts.Failed} failed</span>
          <span className="text-gray-500">{successRate}% rate</span>
        </div>
      </div>

      <div className="space-y-2">
        {recentCrimes.map((crime, i) => {
          const statusColor = crime.status === 'Successful' ? 'text-green-600' :
            crime.status === 'Failed' ? 'text-red-500' :
            'text-yellow-600'

          return (
            <div key={i} className="flex items-center justify-between text-sm border-b border-gray-100 dark:border-gray-700/50 pb-2">
              <div className="flex items-center gap-2">
                <span className="text-gray-500 dark:text-gray-400 text-xs w-6">Lv{crime.difficulty}</span>
                <span className="text-gray-900 dark:text-white">{crime.name}</span>
                {crime.member_position && (
                  <span className="text-xs text-gray-400">({crime.member_position})</span>
                )}
              </div>
              <div className="flex items-center gap-3">
                {crime.member_cpr != null && (
                  <span className="text-xs text-gray-400">{parseFloat(crime.member_cpr).toFixed(0)} CPR</span>
                )}
                <span className={`text-xs font-medium ${statusColor}`}>{crime.status}</span>
              </div>
            </div>
          )
        })}
      </div>

      {crimes.length > 10 && (
        <p className="text-xs text-gray-400 dark:text-gray-500 mt-3">
          Showing 10 of {crimes.length} recent crimes
        </p>
      )}
    </div>
  )
}

function LoanedItemsCard({ items }) {
  const categoryOrder = { armor: 0, weapons: 1, temporary: 2, utilities: 3, medical: 4, drugs: 5, caches: 6, cesium: 7 }

  const sorted = [...items].sort((a, b) => {
    const catA = categoryOrder[a.category] ?? 99
    const catB = categoryOrder[b.category] ?? 99
    if (catA !== catB) return catA - catB
    return (a.item_name || a.name || '').localeCompare(b.item_name || b.name || '')
  })

  // Group by category
  let lastCategory = null

  return (
    <div className="card">
      <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-3">Items on Loan</h3>
      <div className="space-y-1">
        {sorted.map((item, i) => {
          const cat = item.category || 'other'
          const showHeader = cat !== lastCategory
          lastCategory = cat
          return (
            <div key={i}>
              {showHeader && (
                <p className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase mt-2 mb-1">
                  {cat}
                </p>
              )}
              <div className="flex justify-between text-sm">
                <span className="text-gray-900 dark:text-white">{item.item_name || item.name}</span>
                <span className="text-gray-500 dark:text-gray-400">x{item.loaned_to_member}</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function CprKeyCard({ hasCprKey, onOpen }) {
  return (
    <div className="card">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">CPR Scraper Key</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {hasCprKey
              ? 'Your API key is registered — CPR data is collected nightly.'
              : 'No API key on file. Provide a key so your CPR data can be tracked automatically.'}
          </p>
        </div>
        <button
          onClick={onOpen}
          className={`flex-shrink-0 ml-4 flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
            hasCprKey
              ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-400 hover:bg-green-200 dark:hover:bg-green-900/60'
              : 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-900/60'
          }`}
        >
          <span className={`w-2 h-2 rounded-full ${hasCprKey ? 'bg-green-500' : 'bg-red-500'}`} />
          {hasCprKey ? 'Key Registered' : 'No Key — Click to Add'}
        </button>
      </div>
    </div>
  )
}

function CprKeyModal({ user, hasCprKey, onClose, onSuccess, onRemove }) {
  const [cprKey, setCprKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState(null)
  const [success, setSuccess] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    if (!cprKey.trim()) return
    setSaving(true)
    setError(null)
    try {
      const result = await submitCprKey(cprKey.trim(), user.apiKey)
      if (!result.success) {
        setError(result.error || 'Failed to save key. Please try again.')
      } else {
        setSuccess(true)
        setTimeout(() => onSuccess(cprKey.trim()), 1200)
      }
    } catch (err) {
      setError(err.message || 'Unexpected error. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  async function handleRemove() {
    setRemoving(true)
    setError(null)
    try {
      const result = await submitCprKey('', user.apiKey)
      if (!result.success) {
        setError(result.error || 'Failed to remove key.')
      } else {
        onRemove()
      }
    } catch (err) {
      setError(err.message || 'Unexpected error. Please try again.')
    } finally {
      setRemoving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl max-w-md w-full mx-4">
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              CPR Scraper API Key
            </h3>
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-gray-100 dark:hover:bg-slate-700 text-gray-500 dark:text-gray-400"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
            Provide a <strong>Minimal Access</strong> Torn API key so the nightly scraper can collect your CPR stats.
            This key is stored securely and used only for automated data collection — it is never shared.
          </p>

          <div className="mb-4 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg text-xs text-blue-700 dark:text-blue-300 space-y-1">
            <p className="font-semibold">Required key settings in Torn:</p>
            <p>Access Level: <strong>Minimal Access</strong> or higher</p>
            <p>Create at: <a href="https://www.torn.com/preferences.php#tab=api" target="_blank" rel="noopener noreferrer" className="underline hover:no-underline">Torn Preferences → API</a></p>
          </div>

          {success ? (
            <div className="p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg text-sm text-green-700 dark:text-green-300 text-center">
              Key saved successfully!
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-3">
              <div>
                <label className="block text-sm font-medium mb-1 text-gray-700 dark:text-gray-300">
                  API Key (Minimal Access)
                </label>
                <input
                  type="text"
                  value={cprKey}
                  onChange={e => setCprKey(e.target.value)}
                  placeholder="16-character Torn API key"
                  className="input w-full font-mono text-sm"
                  disabled={saving}
                />
              </div>

              {error && (
                <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-600 dark:text-red-400">
                  {error}
                </div>
              )}

              <div className="flex gap-2 justify-between pt-1">
                {hasCprKey && (
                  <button
                    type="button"
                    onClick={handleRemove}
                    disabled={removing || saving}
                    className="px-3 py-2 text-sm text-red-600 dark:text-red-400 border border-red-300 dark:border-red-700 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50"
                  >
                    {removing ? 'Removing…' : 'Remove Key'}
                  </button>
                )}
                <div className="flex gap-2 ml-auto">
                  <button
                    type="button"
                    onClick={onClose}
                    disabled={saving || removing}
                    className="px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-700 rounded-lg"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={saving || removing || !cprKey.trim()}
                    className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {saving ? 'Verifying…' : 'Save Key'}
                  </button>
                </div>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
