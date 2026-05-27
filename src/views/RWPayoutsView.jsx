import { useState, useEffect, useMemo } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../utils/supabase'
import { formatCurrency, formatCurrencyShort } from '../utils/payoutCalculations'
import { formatWarDateRange } from '../utils/warPayoutCalculations'
import { X, Info } from 'lucide-react'
import StatCards from '../components/StatCards'

const OUR_FACTION_ID = 10739

export default function RWPayoutsView() {
  const { user } = useAuth()
  const [loading, setLoading] = useState(true)
  const [warPayouts, setWarPayouts] = useState([])
  const [showInfo, setShowInfo] = useState(false)

  // Modal state
  const [modalWp, setModalWp] = useState(null)
  const [modalMembers, setModalMembers] = useState([])
  const [loadingModal, setLoadingModal] = useState(false)
  const [modalTab, setModalTab] = useState('sheet')

  useEffect(() => {
    if (user?.id) loadPayoutData()
  }, [user?.id])

  async function loadPayoutData() {
    try {
      setLoading(true)

      const { data, error } = await supabase
        .from('war_payout_members')
        .select(`
          payout_amount, payout_id,
          war_payouts(
            id, war_id, total_reward, total_payout, faction_cut_percent,
            member_count, war_type, termed_mode, notes, created_at,
            ranked_wars(start_at, end_at, opponent_name, opponent_id, winner_faction_id, our_score, opponent_score)
          )
        `)
        .eq('member_id', user.id.toString())
        .order('payout_id', { ascending: false })

      if (error) throw error
      setWarPayouts(data || [])
    } catch (err) {
      console.error('Error loading war payout data:', err)
    } finally {
      setLoading(false)
    }
  }

  async function openModal(wp) {
    setModalWp(wp)
    setModalTab('sheet')
    setLoadingModal(true)
    try {
      const { data, error } = await supabase
        .from('war_payout_members')
        .select('member_id, member_name, payout_amount, is_eligible, war_hits, assist_attacks, losses, mugs, regular_hits, score')
        .eq('payout_id', wp.payout_id)
        .order('payout_amount', { ascending: false })

      if (error) throw error
      setModalMembers(data || [])
    } catch (err) {
      console.error('Error loading modal members:', err)
    } finally {
      setLoadingModal(false)
    }
  }

  function closeModal() {
    setModalWp(null)
    setModalMembers([])
  }

  const myStats = useMemo(() => {
    if (warPayouts.length === 0) return null
    const totalEarned = warPayouts.reduce((sum, p) => sum + (p.payout_amount || 0), 0)
    return {
      totalEarned,
      warsActive: warPayouts.length,
      avgPerWar: totalEarned / warPayouts.length,
      lastPayout: warPayouts[0]?.payout_amount || 0,
    }
  }, [warPayouts])

  if (loading) {
    return (
      <div className="card">
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mr-3"></div>
          <p className="text-gray-600 dark:text-gray-400">Loading payout data...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {myStats && (
        <StatCards stats={[
          { label: 'Total Earned', value: formatCurrencyShort(myStats.totalEarned), color: 'text-blue-600' },
          { label: 'Wars Paid', value: myStats.warsActive },
          { label: 'Avg / War', value: formatCurrencyShort(myStats.avgPerWar) },
          { label: 'Last Payout', value: formatCurrencyShort(myStats.lastPayout), color: 'text-green-600' },
        ]} />
      )}

      <div className="card">
        <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
          Payout History
          <button
            onClick={() => setShowInfo(true)}
            className="p-1 rounded hover:bg-gray-100 dark:hover:bg-slate-700 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
            aria-label="How RW payouts work"
            title="How RW payouts work"
          >
            <Info className="w-4 h-4" />
          </button>
        </h2>

        {warPayouts.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400 py-4">No war payouts yet.</p>
        ) : (
          <div className="space-y-2">
            {warPayouts.map((wp) => {
              const war = wp.war_payouts?.ranked_wars
              const payoutData = wp.war_payouts
              const result = war
                ? (!war.end_at || war.end_at === 0
                    ? 'ongoing'
                    : war.winner_faction_id === OUR_FACTION_ID ? 'win' : 'loss')
                : null
              const resultColor = result === 'win' ? 'text-green-600' : result === 'loss' ? 'text-red-500' : 'text-yellow-600'
              const label = war
                ? `vs ${war.opponent_name || `#${war.opponent_id}`}`
                : `Payout #${wp.payout_id}`
              const dateLabel = war ? formatWarDateRange(war.start_at, war.end_at) : ''

              return (
                <div
                  key={wp.payout_id}
                  className="border rounded-lg p-4 cursor-pointer transition-colors border-gray-200 dark:border-slate-700 hover:border-blue-400 dark:hover:border-blue-500 hover:bg-blue-50/40 dark:hover:bg-blue-900/10"
                  onClick={() => openModal(wp)}
                >
                  <div className="flex items-center justify-between">
                    <div className="min-w-0">
                      <div className="font-semibold flex items-center gap-2">
                        {result && (
                          <span className={`text-xs font-bold ${resultColor}`}>
                            {result === 'win' ? 'W' : result === 'loss' ? 'L' : 'IP'}
                          </span>
                        )}
                        <span className="truncate">{label}</span>
                      </div>
                      <div className="text-sm text-gray-600 dark:text-gray-400">
                        {dateLabel}
                        {payoutData?.member_count && ` | ${payoutData.member_count} members`}
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0 ml-4">
                      <div className="text-lg font-bold text-blue-600">
                        {formatCurrencyShort(wp.payout_amount || 0)}
                      </div>
                      {payoutData?.total_payout && (
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          Pool: {formatCurrencyShort(payoutData.total_payout)}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {modalWp && (
        <WarPayoutModal
          wp={modalWp}
          members={modalMembers}
          loading={loadingModal}
          tab={modalTab}
          setTab={setModalTab}
          onClose={closeModal}
        />
      )}

      {showInfo && <RwPayoutInfoModal onClose={() => setShowInfo(false)} />}
    </div>
  )
}

function RwPayoutInfoModal({ onClose }) {
  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal-dialog sm:max-w-lg">
        <div className="px-5 py-4 flex items-center justify-between border-b border-gray-200 dark:border-slate-700">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">How RW payouts work</h3>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-gray-100 dark:hover:bg-slate-700 text-gray-500 dark:text-gray-400"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="px-5 py-4 overflow-y-auto text-sm text-gray-700 dark:text-gray-300 space-y-3">
          <p>
            RW payouts are split based on a combination of <strong>contribution</strong> and <strong>participation</strong> — your war hits/assists and the score they generated.
          </p>
          <p>
            To maximise your pay, focus on landing hits as close to <strong>3.00× FF</strong> as possible.
          </p>
          <p>
            The weight of <strong>assists</strong> changes per war depending on the war's difficulty and how necessary the war leaders judge assists were for winning. So check in before each war to understand the formula being used.
          </p>
        </div>
        <div className="px-5 py-3 border-t border-gray-200 dark:border-slate-700 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  )
}

function WarPayoutModal({ wp, members, loading, tab, setTab, onClose }) {
  const [sortCol, setSortCol] = useState('payout_amount')
  const [sortDir, setSortDir] = useState('desc')

  const war = wp.war_payouts?.ranked_wars
  const payoutData = wp.war_payouts

  const result = war
    ? (!war.end_at || war.end_at === 0 ? 'ongoing' : war.winner_faction_id === OUR_FACTION_ID ? 'win' : 'loss')
    : null
  const resultColor = result === 'win' ? 'text-green-500' : result === 'loss' ? 'text-red-500' : 'text-yellow-500'
  const label = war ? `vs ${war.opponent_name || `#${war.opponent_id}`}` : `Payout #${wp.payout_id}`
  const dateLabel = war ? formatWarDateRange(war.start_at, war.end_at) : ''

  const eligibleMembers = members.filter(m => m.is_eligible)
  const totalEligiblePayout = eligibleMembers.reduce((s, m) => s + (m.payout_amount || 0), 0)

  const factionCutPct = payoutData?.faction_cut_percent ?? 0
  const totalReward = payoutData?.total_reward ?? 0
  const memberPool = totalReward > 0 ? Math.round(totalReward * (1 - factionCutPct / 100)) : (payoutData?.total_payout ?? 0)

  const isReal = payoutData?.war_type === 'real' || payoutData?.war_type === 'race'

  function handleSort(col) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('desc') }
  }

  const sortedMembers = useMemo(() => {
    const d = sortDir === 'asc' ? 1 : -1
    return members.slice().sort((a, b) => {
      const av = a[sortCol] ?? 0
      const bv = b[sortCol] ?? 0
      if (sortCol === 'member_name') return d * (a.member_name || '').localeCompare(b.member_name || '')
      return d * (Number(av) - Number(bv))
    })
  }, [members, sortCol, sortDir])

  const hitTotals = useMemo(() => ({
    warHits:     members.reduce((s, m) => s + (m.war_hits || 0), 0),
    assists:     members.reduce((s, m) => s + (m.assist_attacks || 0), 0),
    losses:      members.reduce((s, m) => s + (m.losses || 0), 0),
    mugs:        members.reduce((s, m) => s + (m.mugs || 0), 0),
    regularHits: members.reduce((s, m) => s + (m.regular_hits || 0), 0),
    score:       members.reduce((s, m) => s + (m.score || 0), 0),
  }), [members])

  function SortTh({ col, label, className = '' }) {
    const active = sortCol === col
    return (
      <th
        onClick={() => handleSort(col)}
        className={`px-2 py-2 text-xs font-semibold cursor-pointer select-none hover:text-gray-700 dark:hover:text-gray-200 sticky top-0 z-10 bg-gray-50 dark:bg-slate-700 border-b border-gray-200 dark:border-slate-700 ${className}`}
      >
        {label}
        <span className="ml-1 text-gray-400">{active ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}</span>
      </th>
    )
  }

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal-dialog sm:max-w-5xl">
        {/* Header */}
        <div className="flex-shrink-0 p-4 border-b border-gray-200 dark:border-slate-700 flex items-start justify-between gap-4">
          <div>
            <h3 className="text-lg font-semibold flex items-center gap-2">
              {result && <span className={`text-sm font-bold ${resultColor}`}>{result === 'win' ? 'WIN' : result === 'loss' ? 'LOSS' : 'IN PROGRESS'}</span>}
              {label}
            </h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-0.5">
              {dateLabel}
              {payoutData?.war_type && <span className="ml-2 capitalize">{payoutData.war_type} war</span>}
              {war?.our_score != null && <span className="ml-2">{war.our_score} – {war.opponent_score}</span>}
            </p>
          </div>
          <button onClick={onClose} className="flex-shrink-0 p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Summary stats */}
        <div className="flex-shrink-0 px-4 pt-4 pb-2">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard label="Total Reward" value={formatCurrency(totalReward)} />
            <StatCard label={`Faction Cut (${factionCutPct}%)`} value={formatCurrency(Math.round(totalReward * factionCutPct / 100))} />
            <StatCard label="Member Pool" value={formatCurrency(memberPool)} color="text-blue-600" />
            <StatCard label="Total Payout" value={formatCurrency(totalEligiblePayout)} color="text-green-600" />
            <StatCard label="Members" value={`${eligibleMembers.length} / ${members.length}`} />
            <StatCard label="Your Payout" value={formatCurrency(wp.payout_amount || 0)} color="text-blue-600" />
            {payoutData?.notes && <div className="col-span-2 sm:col-span-2 bg-gray-50 dark:bg-slate-700/50 rounded-lg p-3 text-xs text-gray-600 dark:text-gray-400 italic">{payoutData.notes}</div>}
          </div>
        </div>

        {/* Tabs */}
        <div className="flex-shrink-0 flex gap-1 px-4 pt-2 pb-0 border-b border-gray-200 dark:border-slate-700">
          <button
            onClick={() => setTab('sheet')}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${tab === 'sheet' ? 'bg-white dark:bg-slate-800 border border-b-white dark:border-slate-600 dark:border-b-slate-800 text-blue-600' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}
          >
            Payout Sheet
          </button>
          <button
            onClick={() => setTab('hits')}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${tab === 'hits' ? 'bg-white dark:bg-slate-800 border border-b-white dark:border-slate-600 dark:border-b-slate-800 text-blue-600' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}
          >
            Hit Report
          </button>
        </div>

        {/* Tab content */}
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mr-3"></div>
            <span className="text-gray-500 dark:text-gray-400">Loading...</span>
          </div>
        ) : (
          <div className="flex-1 overflow-auto">
            {tab === 'sheet' && (
              <table className="w-full text-xs border-separate border-spacing-0">
                <thead>
                  <tr className="text-left text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-slate-700">
                    <SortTh col="member_name" label="Member" className="text-left" />
                    {isReal && (
                      <>
                        <SortTh col="war_hits"      label="War"     className="text-right" />
                        <SortTh col="assist_attacks" label="Assist" className="text-right" />
                        <SortTh col="losses"         label="Lost"   className="text-right" />
                        <SortTh col="mugs"           label="Mugs"   className="text-right" />
                        <SortTh col="regular_hits"   label="Reg."   className="text-right" />
                        <SortTh col="score"          label="Respect" className="text-right" />
                      </>
                    )}
                    {!isReal && (
                      <SortTh col="score" label="Score" className="text-right" />
                    )}
                    <SortTh col="payout_amount" label="Payout" className="text-right" />
                  </tr>
                </thead>
                <tbody>
                  {sortedMembers.map(m => (
                    <tr
                      key={m.member_id}
                      className={`border-b border-gray-100 dark:border-slate-700/50 last:border-0 hover:bg-gray-50 dark:hover:bg-slate-700/30 ${!m.is_eligible ? 'opacity-40' : ''}`}
                    >
                      <td className="px-2 py-1.5 font-medium text-gray-900 dark:text-white whitespace-nowrap">{m.member_name}</td>
                      {isReal && (
                        <>
                          <td className="px-2 py-1.5 text-right font-medium text-blue-700 dark:text-blue-400">{m.war_hits ?? 0}</td>
                          <td className="px-2 py-1.5 text-right text-gray-600 dark:text-gray-400">{m.assist_attacks ?? 0}</td>
                          <td className="px-2 py-1.5 text-right text-gray-600 dark:text-gray-400">{m.losses ?? 0}</td>
                          <td className="px-2 py-1.5 text-right text-gray-600 dark:text-gray-400">{m.mugs ?? 0}</td>
                          <td className="px-2 py-1.5 text-right text-gray-600 dark:text-gray-400">{m.regular_hits ?? 0}</td>
                          <td className="px-2 py-1.5 text-right text-gray-600 dark:text-gray-400">
                            {Number(m.score ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                          </td>
                        </>
                      )}
                      {!isReal && (
                        <td className="px-2 py-1.5 text-right text-gray-600 dark:text-gray-400">
                          {Number(m.score ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </td>
                      )}
                      <td className="px-2 py-1.5 text-right font-semibold font-mono text-gray-900 dark:text-white whitespace-nowrap">
                        {m.is_eligible ? formatCurrency(m.payout_amount || 0) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {tab === 'hits' && (
              <div>
                {/* Hit totals summary */}
                <div className="px-4 py-3 border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-700/30">
                  <h4 className="text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wider mb-3">Summary</h4>
                  <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
                    <StatCard label="War Hits"    value={hitTotals.warHits}     color="text-blue-600" />
                    <StatCard label="Assists"     value={hitTotals.assists}     />
                    <StatCard label="Losses"      value={hitTotals.losses}      color="text-red-500" />
                    <StatCard label="Mugs"        value={hitTotals.mugs}        color="text-amber-600" />
                    <StatCard label="Regular"     value={hitTotals.regularHits} />
                    <StatCard label="Total Respect" value={hitTotals.score.toLocaleString(undefined, { maximumFractionDigits: 0 })} color="text-purple-600" />
                  </div>
                </div>

                {/* Per-member hit table */}
                <table className="w-full text-xs border-separate border-spacing-0">
                  <thead>
                    <tr className="text-left text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-slate-700">
                      <SortTh col="member_name"   label="Member"  className="text-left" />
                      <SortTh col="war_hits"       label="War"     className="text-right" />
                      <SortTh col="assist_attacks" label="Assist"  className="text-right" />
                      <SortTh col="losses"         label="Lost"    className="text-right" />
                      <SortTh col="mugs"           label="Mugs"    className="text-right" />
                      <SortTh col="regular_hits"   label="Reg."    className="text-right" />
                      <SortTh col="score"          label="Respect" className="text-right" />
                      <SortTh col="payout_amount"  label="Payout"  className="text-right" />
                    </tr>
                  </thead>
                  <tbody>
                    {sortedMembers.map(m => (
                      <tr
                        key={m.member_id}
                        className={`border-b border-gray-100 dark:border-slate-700/50 last:border-0 hover:bg-gray-50 dark:hover:bg-slate-700/30 ${!m.is_eligible ? 'opacity-40' : ''}`}
                      >
                        <td className="px-2 py-1.5 font-medium text-gray-900 dark:text-white whitespace-nowrap">{m.member_name}</td>
                        <td className="px-2 py-1.5 text-right font-medium text-blue-700 dark:text-blue-400">{m.war_hits ?? 0}</td>
                        <td className="px-2 py-1.5 text-right text-gray-600 dark:text-gray-400">{m.assist_attacks ?? 0}</td>
                        <td className="px-2 py-1.5 text-right text-gray-600 dark:text-gray-400">{m.losses ?? 0}</td>
                        <td className="px-2 py-1.5 text-right text-gray-600 dark:text-gray-400">{m.mugs ?? 0}</td>
                        <td className="px-2 py-1.5 text-right text-gray-600 dark:text-gray-400">{m.regular_hits ?? 0}</td>
                        <td className="px-2 py-1.5 text-right text-gray-600 dark:text-gray-400">
                          {Number(m.score ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </td>
                        <td className="px-2 py-1.5 text-right font-semibold font-mono text-gray-900 dark:text-white whitespace-nowrap">
                          {m.is_eligible ? formatCurrency(m.payout_amount || 0) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function StatCard({ label, value, color = '' }) {
  return (
    <div className="bg-gray-50 dark:bg-slate-700/50 rounded-lg p-3">
      <div className={`text-sm font-bold ${color || 'text-gray-900 dark:text-gray-100'}`}>{value}</div>
      <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{label}</div>
    </div>
  )
}
