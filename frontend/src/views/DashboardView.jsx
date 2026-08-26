import { useState, useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { apiGet } from '../utils/apiClient'
import CompetitionPins from '../components/CompetitionPins'
import UpcomingEvents from '../components/UpcomingEvents'
import { filterItemsForMember } from '../utils/payoutDataLoader'
import { calculateTierProgress, getTierInfo } from '../utils/tierProgressUtils'
import { formatCurrency } from '../utils/payoutCalculations'
import { formatWarDateRange } from '../utils/warPayoutCalculations'
import ApiKeyDisclosure from '../components/ApiKeyDisclosure'
import { STAT_PATHS, DASHBOARD_STAT_KEYS, getByPath } from '../utils/statPaths'
import { Check, X } from 'lucide-react'

export default function DashboardView() {
  const { user } = useAuth()
  const [loading, setLoading] = useState(true)
  const [memberData, setMemberData] = useState(null)
  const [payoutHistory, setPayoutHistory] = useState([])
  const [crimeHistory, setCrimeHistory] = useState([])
  const [loanedItems, setLoanedItems] = useState([])
  const [tierProgress, setTierProgress] = useState(null)
  const [personalStats, setPersonalStats] = useState(null)
  const [ocConfig, setOcConfig] = useState(null)
  const [showCprKeyModal, setShowCprKeyModal] = useState(false)

  // RW data
  const [recentWars, setRecentWars] = useState([])
  const [warPayouts, setWarPayouts] = useState([])

  useEffect(() => {
    if (user?.id) loadDashboard()
  }, [user?.id])

  async function loadDashboard() {
    setLoading(true)
    try {
      const memberId = user.id.toString()

      const [profileResult, statsResult, payoutsResult, crimesResult, loanedResult, ocConfigResult] = await Promise.all([
        apiGet(`/api/members/${memberId}`).catch(() => null),
        apiGet(`/api/members/${memberId}/daily-stats?limit=31`).catch(() => ({ daily_stats: [] })),
        apiGet(`/api/members/${memberId}/payouts`).catch(() => ({ payouts: [] })),
        apiGet(`/api/members/${memberId}/crimes?limit=500`).catch(() => ({ crimes: [] })),
        apiGet('/api/inventory/loaned').catch(() => ({ items: [] })),
        apiGet('/api/oc-config').catch(() => null),
      ])
      setOcConfig(ocConfigResult)
      const payouts = payoutsResult.payouts
      const crimes = crimesResult.crimes
      const loaned = filterItemsForMember(loanedResult.items, memberId)

      // Build member data
      const member = profileResult?.member
      if (member) {
        const cprV2Data = profileResult.cpr || []
        // Use ?? so tier 0 ("needs manual review") is preserved instead of
        // falling through to tier 6 like a falsy value would with ||.
        const effectiveTier = member.tier_override ?? member.tier ?? 6
        setMemberData({ ...member, cprV2Data, effectiveTier })

        // Tier policy comes from the faction's DB-backed OC config.
        const progress = calculateTierProgress(cprV2Data, effectiveTier, ocConfigResult?.tier_requirements)
        setTierProgress(progress)
      }

      // Personal stats
      const statsData = statsResult.daily_stats || []
      if (statsData.length > 0) {
        setPersonalStats({
          latest: statsData[0],
          oldest: statsData[statsData.length - 1],
          daysCovered: statsData.length,
          allRows: statsData,
        })
      }

      setPayoutHistory(payouts.slice(0, 8))
      setCrimeHistory(crimes)
      setLoanedItems(loaned)

      // Load RW data: recent wars where this member contributed, and war payouts
      try {
        const { wars } = await apiGet(`/api/members/${memberId}/wars`)
        if (wars.length > 0) {
          setRecentWars(wars.map(war => ({ ...war, myScore: war.my_score, myAttacks: war.my_attacks })))
        }

        const { war_payouts: wpMembers } = await apiGet(`/api/members/${memberId}/war-payouts?limit=5`)
        setWarPayouts(wpMembers)
      } catch (err) {
        console.error('Error loading RW data:', err)
      }

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

  const tierInfo = getTierInfo(memberData.effectiveTier, ocConfig?.payout_tickets)

  return (
    <div className="space-y-6">
      <CompetitionPins />
      {/* #395 — renders nothing at all when the next 7 days are empty. */}
      <UpcomingEvents />

      {/* Welcome Header */}
      <div className="card">
        <h2 className="text-xl font-semibold mb-1">
          Welcome, {memberData.member_name}
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Your personal Torn dashboard — track your personal stats, OC participation, and more.
        </p>
      </div>

      {/* 1. Personal Stats (top) */}
      {personalStats && (
        <PersonalStatsCard stats={personalStats} />
      )}

      {/* 2. RW Summary */}
      <RWSummaryCard wars={recentWars} payouts={warPayouts} />

      {/* 3. OC Summary */}
      <OCSummaryCard
        tier={memberData.effectiveTier}
        tierInfo={tierInfo}
        hasCprKey={!!memberData.has_cpr_key}
        onOpenCprKey={() => setShowCprKeyModal(true)}
        payoutHistory={payoutHistory}
        crimeHistory={crimeHistory}
      />

      {/* Tier Progress Card */}
      {tierProgress && tierProgress.nextTierProgress && (
        <TierProgressCard tierProgress={tierProgress} payoutTickets={ocConfig?.payout_tickets} />
      )}

      {/* Loaned Items */}
      {loanedItems.length > 0 && (
        <LoanedItemsCard items={loanedItems} />
      )}

      {/* API Key status / usage info */}
      {showCprKeyModal && (
        <ApiKeyInfoModal
          hasKey={!!memberData.has_cpr_key}
          onClose={() => setShowCprKeyModal(false)}
        />
      )}
    </div>
  )
}

// ─── OC Summary Card ──────────────────────────────────────────────

function OCSummaryCard({ tier, tierInfo, hasCprKey, onOpenCprKey, payoutHistory, crimeHistory }) {
  const tierColors = {
    0: 'bg-tier-review',
    1: 'bg-tier-1', 2: 'bg-tier-2', 3: 'bg-tier-3',
    4: 'bg-tier-4', 5: 'bg-tier-5', 6: 'bg-tier-6',
  }
  const tierLabel = tier === 0 ? 'Review' : `T${tier}`

  const recentPayouts = payoutHistory.slice(0, 5)
  const avgPayout = recentPayouts.length > 0
    ? Math.floor(recentPayouts.reduce((s, p) => s + (p.payout || 0), 0) / recentPayouts.length)
    : 0

  return (
    <div className="card">
      {/* Header row: Tier badge left, CPR key status right */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <span className={`text-lg font-bold text-white px-3 py-1 rounded-lg ${tierColors[tier] ?? 'bg-tier-review'}`}>
            {tierLabel}
          </span>
          <div>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">OC Summary</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400">{tierInfo.name} — {tierInfo.tickets} tickets/wk</p>
          </div>
        </div>

        <button
          onClick={onOpenCprKey}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
            hasCprKey
              ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-400 hover:bg-green-200 dark:hover:bg-green-900/60'
              : 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-900/60'
          }`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${hasCprKey ? 'bg-green-500' : 'bg-red-500'}`} />
          {hasCprKey ? 'API Key Active' : 'API Key Missing'}
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Recent Payouts */}
        <div>
          <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
            Recent Payouts
            {recentPayouts.length > 1 && (
              <span className="font-normal ml-1">({formatCurrency(avgPayout)}/wk avg)</span>
            )}
          </h4>
          {recentPayouts.length === 0 ? (
            <p className="text-xs text-gray-400 dark:text-gray-500">No payout history yet.</p>
          ) : (
            <div className="space-y-1.5">
              {recentPayouts.map((p, i) => (
                <div key={i} className="flex justify-between text-sm">
                  <span className="text-gray-500 dark:text-gray-400 text-xs">
                    {p.week_start || `Week ${i + 1}`}
                  </span>
                  <span className="font-medium text-gray-900 dark:text-white text-xs">
                    {formatCurrency(p.payout || 0)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Crime Participation */}
        <div>
          <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
            Crime Participation
          </h4>
          {crimeHistory.length === 0 ? (
            <p className="text-xs text-gray-400 dark:text-gray-500">No crime history yet.</p>
          ) : (
            <div className="overflow-y-auto max-h-[160px] scrollbar-thin">
              <table className="w-full text-xs border-separate border-spacing-0">
                <thead>
                  <tr className="text-left text-gray-400 dark:text-gray-500">
                    <th className="pb-1 font-medium sticky top-0 bg-white dark:bg-slate-800 z-10" style={{ width: '55%' }}>Crime</th>
                    <th className="pb-1 font-medium sticky top-0 bg-white dark:bg-slate-800 z-10" style={{ width: '25%' }}>Role</th>
                    <th className="pb-1 font-medium sticky top-0 bg-white dark:bg-slate-800 z-10 text-right pr-2" style={{ width: '10%' }}>CPR</th>
                    <th className="pb-1 font-medium sticky top-0 bg-white dark:bg-slate-800 z-10 text-right" style={{ width: '10%' }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {crimeHistory.map((crime, i) => {
                    const statusColor = crime.status === 'Successful' ? 'text-green-600' :
                      (crime.status === 'Failed' || crime.status === 'Failure') ? 'text-red-500' :
                      'text-yellow-600'
                    const statusLabel = crime.status === 'Successful' ? 'Pass' :
                      (crime.status === 'Failed' || crime.status === 'Failure') ? 'Fail' :
                      'IP'

                    return (
                      <tr key={i}>
                        <td className="py-0.5 pr-2 text-gray-900 dark:text-white truncate max-w-0">
                          <span className="text-gray-400 mr-1">Lv{crime.difficulty}</span>
                          {crime.name}
                        </td>
                        <td className="py-0.5 pr-2 text-gray-500 dark:text-gray-400 whitespace-nowrap truncate max-w-0">
                          {crime.member_position || '—'}
                        </td>
                        <td className="py-0.5 pr-2 text-right tabular-nums text-gray-500 dark:text-gray-400">
                          {crime.member_cpr != null ? Math.round(crime.member_cpr) : '—'}
                        </td>
                        <td className={`py-0.5 text-right font-medium ${statusColor}`}>
                          {statusLabel}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── RW Summary Card ──────────────────────────────────────────────

function RWSummaryCard({ wars, payouts }) {
  const hasData = wars.length > 0 || payouts.length > 0

  if (!hasData) {
    return (
      <div className="card">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-1">RW Summary</h3>
        <p className="text-xs text-gray-400 dark:text-gray-500">No ranked war data available yet.</p>
      </div>
    )
  }

  const payoutValues = payouts.filter(p => p.payout_amount > 0).map(p => p.payout_amount)
  const avgPayout = payoutValues.length > 0
    ? Math.floor(payoutValues.reduce((s, v) => s + v, 0) / payoutValues.length)
    : 0

  return (
    <div className="card">
      <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-4">RW Summary</h3>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Recent Wars */}
        <div>
          <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
            Recent Wars
          </h4>
          {wars.length === 0 ? (
            <p className="text-xs text-gray-400 dark:text-gray-500">No wars found.</p>
          ) : (
            <div className="overflow-y-auto max-h-[160px] scrollbar-thin">
              <table className="w-full text-xs border-separate border-spacing-0">
                <thead>
                  <tr className="text-left text-gray-400 dark:text-gray-500">
                    <th className="pb-1 font-medium sticky top-0 bg-white dark:bg-slate-800 z-10" style={{ width: '8%' }}></th>
                    <th className="pb-1 font-medium sticky top-0 bg-white dark:bg-slate-800 z-10" style={{ width: '52%' }}>Opponent</th>
                    <th className="pb-1 font-medium text-right pr-2 sticky top-0 bg-white dark:bg-slate-800 z-10" style={{ width: '20%' }}>Hits</th>
                    <th className="pb-1 font-medium text-right sticky top-0 bg-white dark:bg-slate-800 z-10" style={{ width: '20%' }}>Score</th>
                  </tr>
                </thead>
                <tbody>
                  {wars.map((war) => {
                    const result = !war.end_at || war.end_at === 0 ? 'ongoing' :
                      war.we_won ? 'win' : 'loss'
                    const resultColor = result === 'win' ? 'text-green-600' :
                      result === 'loss' ? 'text-red-500' : 'text-yellow-600'

                    return (
                      <tr key={war.id}>
                        <td className="py-0.5 pr-1">
                          <span className={`font-medium ${resultColor}`}>
                            {result === 'win' ? 'W' : result === 'loss' ? 'L' : 'IP'}
                          </span>
                        </td>
                        <td className="py-0.5 text-gray-500 dark:text-gray-400 truncate max-w-0">
                          {war.opponent_name || `#${war.opponent_id}`}
                        </td>
                        <td className="py-0.5 text-right pr-2 text-gray-500 dark:text-gray-400 tabular-nums">
                          {war.myAttacks || 0}
                        </td>
                        <td className="py-0.5 text-right font-mono font-medium text-gray-900 dark:text-white tabular-nums">
                          {Math.round(Number(war.myScore || 0)).toLocaleString()}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* War Payouts */}
        <div>
          <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
            RW Payouts
            {avgPayout > 0 && (
              <span className="font-normal ml-1">({formatCurrency(avgPayout)} avg)</span>
            )}
          </h4>
          {payouts.length === 0 ? (
            <p className="text-xs text-gray-400 dark:text-gray-500">No war payouts yet.</p>
          ) : (
            <div className="space-y-1.5">
              {payouts.map((wp, i) => {
                const war = wp.war_payouts?.ranked_wars
                const label = war ? (war.opponent_name || formatWarDateRange(war.start_at, war.end_at)) : `Payout ${i + 1}`

                return (
                  <div key={i} className="flex justify-between text-xs">
                    <span className="text-gray-500 dark:text-gray-400 truncate">{label}</span>
                    <span className="font-medium text-gray-900 dark:text-white flex-shrink-0 ml-2">
                      {formatCurrency(wp.payout_amount || 0)}
                      {wp.effort_share != null && (
                        <span className="font-normal text-gray-400 dark:text-gray-500 ml-1">
                          ({(Number(wp.effort_share) * 100).toFixed(1)}%)
                        </span>
                      )}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Tier Progress Card ───────────────────────────────────────────

function TierProgressCard({ tierProgress, payoutTickets }) {
  const next = tierProgress.nextTierProgress
  if (!next) return null

  const nextTierInfo = getTierInfo(next.tier, payoutTickets)
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
              <Check className="w-4 h-4 text-green-500 flex-shrink-0" />
            ) : (
              <X className="w-4 h-4 text-gray-400 flex-shrink-0" />
            )}
            <span className={`truncate ${req.met ? 'text-green-700 dark:text-green-300' : 'text-gray-600 dark:text-gray-300'}`}>
              {req.isAverage ? `Lv${req.level} Avg` : `${req.role} · ${req.crime}`} {'>'}= {req.minCpr}
            </span>
            {req.currentCpr !== null && (
              <span className={`ml-auto text-xs ${req.met ? 'text-green-600' : 'text-gray-400'}`}>
                ({Math.round(req.currentCpr)})
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Stat extraction helpers ──────────────────────────────────────
// As of Phase 2/3, personalstats is the full nested object returned by
// /v2/user/{id}/personalstats?cat=all. Path lookups live in
// src/utils/statPaths.js (shared with the Leadership Member Overview).

function parseStats(raw) {
  if (!raw) return null
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch { return null }
  }
  return raw
}

function PersonalStatsCard({ stats }) {
  const { latest, oldest, daysCovered, allRows } = stats
  const latestStats = parseStats(latest?.personalstats)
  const oldestStats = parseStats(oldest?.personalstats)
  const hasDelta = daysCovered > 1 && oldestStats

  // Gym: filter to rows that have non-null gym data, compute delta from those
  const gymRows_raw = allRows ? allRows.filter(r => r.gym_strength != null || r.gym_speed != null || r.gym_dexterity != null || r.gym_defense != null) : []
  const gymSamples = gymRows_raw.length
  const gymNewest = gymRows_raw[0]
  const gymOldest = gymRows_raw[gymRows_raw.length - 1]
  const gymDays = gymSamples > 1 ? gymSamples - 1 : 0

  const gymDefs = [
    { label: 'Strength', key: 'gym_strength' },
    { label: 'Speed', key: 'gym_speed' },
    { label: 'Dexterity', key: 'gym_dexterity' },
    { label: 'Defense', key: 'gym_defense' },
  ]
  const gymRows = gymDefs.map(g => {
    const latestVal = gymNewest?.[g.key]
    const oldestVal = gymOldest?.[g.key]
    const delta = (latestVal != null && oldestVal != null) ? latestVal - oldestVal : null
    const perDay = (delta != null && gymDays > 0) ? delta / gymDays : null
    return { ...g, total: latestVal, perDay }
  })
  // Total energy spent in gym (from gymenergy contributor stat)
  const gymEnergyRows = allRows ? allRows.filter(r => r.gym_energy != null) : []
  const gymEnergySamples = gymEnergyRows.length
  const gymEnergyNewest = gymEnergyRows[0]
  const gymEnergyOldest_row = gymEnergyRows[gymEnergyRows.length - 1]
  const gymEnergyDays = gymEnergySamples > 1 ? gymEnergySamples - 1 : 0
  const gymEnergyLatest = gymEnergyNewest?.gym_energy
  const gymEnergyDelta = (gymEnergyLatest != null && gymEnergyOldest_row?.gym_energy != null) ? gymEnergyLatest - gymEnergyOldest_row.gym_energy : null
  const gymEnergyPerDay = (gymEnergyDelta != null && gymEnergyDays > 0) ? gymEnergyDelta / gymEnergyDays : null

  const hasGym = gymRows.some(g => g.total != null && g.total > 0) || gymEnergyLatest != null
  const maxPerDay = Math.max(...gymRows.map(g => g.perDay || 0), 1)

  // Personal stats: compute avg per day from the nested path in each snapshot
  const statRows = STAT_PATHS.filter(def => DASHBOARD_STAT_KEYS.has(def.key)).map(def => {
    let current = getByPath(latestStats, def.path)
    let old = hasDelta ? getByPath(oldestStats, def.path) : null
    // Convert seconds to hours for activity
    if (def.isSeconds) {
      if (current != null) current = current / 3600
      if (old != null) old = old / 3600
    }
    const delta = (current != null && old != null) ? current - old : null
    const perDay = (delta != null && daysCovered > 1) ? delta / (daysCovered - 1) : null
    return { ...def, current, delta, perDay }
  }).filter(r => r.current != null)

  if (!latestStats && !hasGym) return null

  const days = daysCovered > 1 ? daysCovered - 1 : 0

  return (
    <div className="card">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 mb-4">
        <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400">Personal Stats</h3>
        <span className="text-xs text-gray-400 dark:text-gray-500">
          {latest?.snapshot_date}
          {days > 0 && ` · ${days}d delta`}
        </span>
      </div>

      {/* Gym: Avg Energy Per Day */}
      {hasGym && (
        <div className="mb-5">
          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
            Avg Gym Energy / Day {gymDays > 0 && <span className="font-normal">({gymDays}d sample)</span>}
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {gymRows.map(g => (
              <div key={g.label}>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-gray-600 dark:text-gray-400">{g.label}</span>
                  <span className="font-mono font-medium text-gray-900 dark:text-white">
                    {g.perDay != null ? g.perDay.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'}
                  </span>
                </div>
                <div className="w-full bg-gray-100 dark:bg-slate-600 rounded-full h-1.5">
                  <div
                    className="h-1.5 rounded-full bg-blue-500"
                    style={{ width: `${g.perDay ? (g.perDay / maxPerDay) * 100 : 0}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
          {gymEnergyLatest != null && (
            <div className="mt-2 flex justify-between text-xs">
              <span className="text-gray-600 dark:text-gray-400">Total Energy</span>
              <span className="font-mono font-medium text-gray-900 dark:text-white">
                {gymEnergyLatest.toLocaleString()}
                {gymEnergyPerDay != null && (
                  <span className="text-gray-400 dark:text-gray-500 ml-1">
                    ({gymEnergyPerDay.toLocaleString(undefined, { maximumFractionDigits: 0 })}/day)
                  </span>
                )}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Personal Stats: Avg Per Day */}
      {statRows.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
            Avg Per Day {days > 0 && <span className="font-normal">({days}d)</span>}
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2">
            {statRows.map(row => (
              <div key={row.key} className="flex items-center justify-between py-1 border-b border-gray-100 dark:border-slate-700/50">
                <span className="text-xs text-gray-600 dark:text-gray-400 truncate mr-2">{row.label}</span>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <span className="text-xs font-mono font-medium text-gray-900 dark:text-white">
                    {row.perDay != null
                      ? (row.isCurrency
                          ? formatCurrency(Math.round(row.perDay))
                          : row.perDay.toLocaleString(undefined, { maximumFractionDigits: 1 }))
                      : '—'}
                  </span>
                  {row.delta != null && (
                    <span className="text-xs text-gray-400">
                      ({row.isCurrency
                        ? formatCurrency(Math.round(row.delta))
                        : row.delta.toLocaleString(undefined, { maximumFractionDigits: 0 })})
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Loaned Items Card ────────────────────────────────────────────

function LoanedItemsCard({ items }) {
  const categoryOrder = { armor: 0, weapons: 1, temporary: 2, utilities: 3, medical: 4, drugs: 5, caches: 6, cesium: 7 }

  const sorted = [...items].sort((a, b) => {
    const catA = categoryOrder[a.category] ?? 99
    const catB = categoryOrder[b.category] ?? 99
    if (catA !== catB) return catA - catB
    return (a.item_name || a.name || '').localeCompare(b.item_name || b.name || '')
  })

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

// ─── API Key status / usage info ──────────────────────────────────
// 2.0: the consolidated key is captured at login (with consent), so there's no
// separate key entry here anymore. This modal just shows current status + the
// shared usage disclosure. To change the key, members re-enter it via the
// hamburger menu → "Update Torn API Key".

function ApiKeyInfoModal({ hasKey, onClose }) {
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl max-w-lg w-full mx-4 max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Your API Key
            </h3>
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-gray-100 dark:hover:bg-slate-700 text-gray-500 dark:text-gray-400"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className={`mb-4 p-3 rounded-lg text-sm flex items-center gap-2 ${
            hasKey
              ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 text-green-700 dark:text-green-300'
              : 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300'
          }`}>
            <span className={`w-2 h-2 rounded-full ${hasKey ? 'bg-green-500' : 'bg-red-500'}`} />
            {hasKey
              ? 'Your key is active and stored securely. It powers your CPR stats, the War Room, and faction data scrapers.'
              : 'No key is stored yet. Log out and log back in (or use the menu → Update Torn API Key) to register your Limited Access key.'}
          </div>

          <ApiKeyDisclosure />

          <p className="text-xs text-gray-500 dark:text-gray-500 mt-3">
            To change your key, use the menu (top-right) → <strong>Update Torn API Key</strong>.
          </p>

          <div className="mt-5 flex justify-end">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-slate-600 transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
