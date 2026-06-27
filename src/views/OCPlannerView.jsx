import { useState, useEffect, useMemo, useCallback } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../utils/supabase'
import { getTornErrorMessage } from '../utils/apiUtils'
import { config } from '../config'
import { RefreshCw, ChevronRight } from 'lucide-react'
import {
  PLANNER_TIERS,
  HORIZONS,
  makeCrimeTierResolver,
  buildPositionTierMap,
  buildPlannerSummary,
  selectOpenSlots,
  planForHorizon,
} from '../utils/ocPlanner'

// ── Small shared bits ────────────────────────────────────────────────────────
const TIER_BG = { 0: 'bg-tier-review', 1: 'bg-tier-1', 2: 'bg-tier-2', 3: 'bg-tier-3', 4: 'bg-tier-4', 5: 'bg-tier-5', 6: 'bg-tier-6' }

function TierPill({ tier }) {
  const isReview = tier == null || tier === 0
  const cls = isReview ? TIER_BG[0] : (TIER_BG[tier] ?? TIER_BG[0])
  return (
    <span className={`inline-flex items-center rounded text-white font-semibold leading-none px-1.5 py-0.5 text-[11px] ${cls}`}>
      {isReview ? 'Review' : `Tier ${tier}`}
    </span>
  )
}

function HorizonToggle({ label, value, onChange }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">{label}</span>
      <div className="inline-flex rounded-lg border border-gray-200 dark:border-slate-600 overflow-hidden">
        {Object.keys(HORIZONS).map((h) => (
          <button
            key={h}
            onClick={() => onChange(h)}
            className={`px-2.5 py-1 text-sm font-medium transition-colors ${
              value === h
                ? 'bg-blue-600 text-white'
                : 'bg-white dark:bg-slate-800 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-slate-700'
            }`}
          >
            {h}
          </button>
        ))}
      </div>
    </div>
  )
}

function formatCountdown(secs) {
  if (secs == null) return '—'
  const a = Math.abs(secs)
  const d = Math.floor(a / 86400)
  const h = Math.floor((a % 86400) / 3600)
  const m = Math.floor((a % 3600) / 60)
  const s = a % 60
  const pad = (n) => String(n).padStart(2, '0')
  return `${d > 0 ? d + 'd ' : ''}${pad(h)}:${pad(m)}:${pad(s)}`
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function OCPlannerView() {
  const { user } = useAuth()
  const apiKey = user?.apiKey

  const [crimes, setCrimes] = useState(null)
  const [memberTiers, setMemberTiers] = useState({})
  const [memberNames, setMemberNames] = useState({})
  const [currentMembers, setCurrentMembers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastUpdated, setLastUpdated] = useState(null)
  const [memberHorizon, setMemberHorizon] = useState('24h')
  const [pauseHorizon, setPauseHorizon] = useState('24h')
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  const [comingOpen, setComingOpen] = useState(false)
  const [freeOpen, setFreeOpen] = useState(false)

  // Keep countdowns / horizon boundaries live.
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(id)
  }, [])

  // crime → tier resolver (crime-level fallback) + per-position tier map.
  const resolveTier = useMemo(
    () => makeCrimeTierResolver({ overrideMap: config.ocTierByCrime || {}, tierRequirements: config.tierRequirements || {} }),
    [],
  )
  const positionTierMap = useMemo(() => buildPositionTierMap(config.tierRequirements || {}), [])

  // Re-pull live crime data the same way OC History does (cat=available via the
  // member's pooled Torn key) and refresh the roster, on every load/refresh.
  const load = useCallback(async () => {
    if (!apiKey) { setError('Log in with an API key to use the planner.'); setLoading(false); return }
    setLoading(true)
    setError(null)
    try {
      const [crimesRes, membersRes] = await Promise.all([
        fetch(`https://api.torn.com/v2/faction/crimes?cat=available&sort=ASC&key=${apiKey}&comment=Forge_OC_Planner`).then((r) => r.json()),
        supabase.from('members').select('member_id, member_name, tier, tier_override, is_current'),
      ])

      if (crimesRes.error) {
        const friendly = getTornErrorMessage(crimesRes.error)
        const guidance = crimesRes.error.code === 16
          ? ' This key lacks faction crimes access (e.g. Recruit status). Use an OC Manager / leadership key.'
          : ''
        throw new Error(friendly + guidance)
      }

      const names = {}
      const tiers = {}
      const current = []
      for (const m of (membersRes.data || [])) {
        const id = String(m.member_id)
        names[id] = m.member_name
        // ?? (not ||) so tier 0 ("needs review") survives, not coalesced to 6.
        const tier = m.tier_override ?? m.tier ?? 6
        tiers[id] = tier
        if (m.is_current) current.push({ id, name: m.member_name, tier })
      }

      setMemberNames(names)
      setMemberTiers(tiers)
      setCurrentMembers(current)
      setCrimes(crimesRes.crimes || [])
      setLastUpdated(Date.now())
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [apiKey])

  useEffect(() => { load() }, [load])

  const summary = useMemo(
    () => buildPlannerSummary({
      crimes: crimes || [], currentMembers, memberTiers, memberNames, resolveTier, positionTierMap, preferWeakestSlot: true,
    }),
    [crimes, currentMembers, memberTiers, memberNames, resolveTier, positionTierMap],
  )

  const openSlots = useMemo(
    () => selectOpenSlots(summary.pausingCrimes, { now, pauseHorizonSecs: HORIZONS[pauseHorizon] }),
    [summary, now, pauseHorizon],
  )

  const plan = useMemo(
    () => planForHorizon(summary, openSlots, { now, memberHorizonSecs: HORIZONS[memberHorizon] }),
    [summary, openSlots, now, memberHorizon],
  )

  const unmappedOpen = openSlots.openSlotsByTier.unmapped || 0
  const tiersToSpawn = PLANNER_TIERS.filter((t) => plan.spawnNeedByTier[t] > 0)

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="card">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold text-gray-900 dark:text-white">OC Planner</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Live from Torn — match who's free or coming out against slots that are pausing, and project what to spawn.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <HorizonToggle label="Members out" value={memberHorizon} onChange={setMemberHorizon} />
            <HorizonToggle label="Crimes pausing" value={pauseHorizon} onChange={setPauseHorizon} />
            <button
              onClick={load}
              disabled={loading}
              className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 whitespace-nowrap"
            >
              {loading
                ? <><div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" /> Refreshing…</>
                : <><RefreshCw className="w-4 h-4" /> Refresh</>}
            </button>
          </div>
        </div>
        {lastUpdated && (
          <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-2">
            Updated {new Date(lastUpdated).toLocaleTimeString()} · re-pulls live crime data on every refresh
          </p>
        )}
      </div>

      {error ? (
        <div className="card"><p className="text-sm text-amber-600 dark:text-amber-400">{error}</p></div>
      ) : loading && !crimes ? (
        <div className="card flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600" /> Loading planner…
        </div>
      ) : (
        <>
          {/* Headline: spawn projection */}
          <div className="card">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-1">
              Recommended to spawn
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
              To seat everyone free or coming out within <strong>{memberHorizon}</strong>, after filling slots pausing within <strong>{pauseHorizon}</strong>.
            </p>
            {tiersToSpawn.length === 0 ? (
              <div className="rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/20 px-4 py-5 text-center">
                <p className="text-emerald-700 dark:text-emerald-300 font-medium">
                  You're covered — enough pausing slots to absorb everyone in these windows.
                </p>
              </div>
            ) : (
              <div className="flex flex-wrap items-stretch gap-2">
                {tiersToSpawn.map((t) => (
                  <div key={t} className={`flex items-center gap-2 rounded-lg px-4 py-3 text-white ${TIER_BG[t]}`}>
                    <span className="text-2xl font-bold leading-none">{plan.spawnNeedByTier[t]}×</span>
                    <span className="text-sm font-semibold leading-tight">Tier {t}<br />slots</span>
                  </div>
                ))}
                <div className="flex items-center px-3 text-sm text-gray-500 dark:text-gray-400">
                  = {plan.spawnTotal} slot{plan.spawnTotal === 1 ? '' : 's'} total
                </div>
              </div>
            )}
            {plan.reviewCount > 0 && (
              <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-3">
                {plan.reviewCount} available member{plan.reviewCount === 1 ? '' : 's'} still need a tier review — not included above.
              </p>
            )}
            {unmappedOpen > 0 && (
              <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-1">
                {unmappedOpen} pausing slot{unmappedOpen === 1 ? '' : 's'} in unmapped crimes — pin them in <code className="font-mono">config.ocTierByCrime</code> to factor them in.
              </p>
            )}
          </div>

          {/* Tier matrix */}
          <div className="card">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-3">
              By tier — supply vs. pausing slots
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-slate-700">
                    <th className="py-2 pr-3 font-semibold">Tier</th>
                    <th className="py-2 px-3 font-semibold text-right">Free now</th>
                    <th className="py-2 px-3 font-semibold text-right">Out ≤{memberHorizon}</th>
                    <th className="py-2 px-3 font-semibold text-right">Available</th>
                    <th className="py-2 px-3 font-semibold text-right">Pausing slots ≤{pauseHorizon}</th>
                    <th className="py-2 pl-3 font-semibold text-right">Spawn</th>
                  </tr>
                </thead>
                <tbody>
                  {PLANNER_TIERS.map((t) => {
                    const avail = plan.availableByTier[t] || 0
                    const open = openSlots.openSlotsByTier[t] || 0
                    const freeNow = plan.members.filter((m) => m.tier === t && m.source === 'free').length
                    const coming = plan.members.filter((m) => m.tier === t && m.source === 'coming').length
                    const need = plan.spawnNeedByTier[t]
                    return (
                      <tr key={t} className="border-b border-gray-100 dark:border-slate-700/50">
                        <td className="py-2 pr-3"><TierPill tier={t} /></td>
                        <td className="py-2 px-3 text-right text-gray-600 dark:text-gray-300">{freeNow || '—'}</td>
                        <td className="py-2 px-3 text-right text-gray-600 dark:text-gray-300">{coming || '—'}</td>
                        <td className="py-2 px-3 text-right font-semibold">{avail || '—'}</td>
                        <td className="py-2 px-3 text-right text-gray-600 dark:text-gray-300">{open || '—'}</td>
                        <td className={`py-2 pl-3 text-right font-bold ${need > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-gray-400'}`}>
                          {need > 0 ? `+${need}` : '0'}
                        </td>
                      </tr>
                    )
                  })}
                  {plan.reviewCount > 0 && (
                    <tr className="border-b border-gray-100 dark:border-slate-700/50">
                      <td className="py-2 pr-3"><TierPill tier={0} /></td>
                      <td className="py-2 px-3 text-right text-gray-600 dark:text-gray-300">
                        {plan.members.filter((m) => (m.tier == null || m.tier === 0) && m.source === 'free').length || '—'}
                      </td>
                      <td className="py-2 px-3 text-right text-gray-600 dark:text-gray-300">
                        {plan.members.filter((m) => (m.tier == null || m.tier === 0) && m.source === 'coming').length || '—'}
                      </td>
                      <td className="py-2 px-3 text-right font-semibold">{plan.reviewCount}</td>
                      <td className="py-2 px-3 text-right text-gray-400">—</td>
                      <td className="py-2 pl-3 text-right text-gray-400">—</td>
                    </tr>
                  )}
                </tbody>
                <tfoot>
                  <tr className="text-xs text-gray-500 dark:text-gray-400">
                    <td className="pt-2 pr-3 font-semibold">Total</td>
                    <td className="pt-2 px-3 text-right">{plan.freeNowCount}</td>
                    <td className="pt-2 px-3 text-right">{plan.comingOutCount}</td>
                    <td className="pt-2 px-3 text-right font-semibold">{plan.members.length}</td>
                    <td className="pt-2 px-3 text-right">{openSlots.openSlotsTotal}</td>
                    <td className="pt-2 pl-3 text-right font-bold text-amber-600 dark:text-amber-400">+{plan.spawnTotal}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-3">
              <strong>Available</strong> = free now + coming out within {memberHorizon}. <strong>Pausing slots</strong> = crimes that are paused/empty or pause within {pauseHorizon} — each worth one slot at its weakest open tier. <strong>Spawn</strong> = members with no pausing slot to seat them.
            </p>
          </div>

          {/* Detail: who's coming out / who's free */}
          <div className="card space-y-4">
            <CollapsibleList
              open={comingOpen}
              onToggle={() => setComingOpen((o) => !o)}
              label={`Coming out within ${memberHorizon} (${plan.comingOutCount})`}
              empty="Nobody's OC executes in this window."
              items={plan.comingOut}
              render={(f) => {
                const secs = f.readyAt - now
                const ready = secs <= 0
                return (
                  <span key={`${f.id}-${f.crimeId}`} className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800" title={f.crimeName}>
                    <span className="font-medium text-gray-700 dark:text-gray-300">{f.name}</span>
                    <TierPill tier={f.tier} />
                    <span className={`font-mono ${ready ? 'text-emerald-600 dark:text-emerald-400 font-semibold' : 'text-gray-500 dark:text-gray-400'}`}>
                      {ready ? 'ready' : formatCountdown(secs)}
                    </span>
                  </span>
                )
              }}
            />
            <CollapsibleList
              open={freeOpen}
              onToggle={() => setFreeOpen((o) => !o)}
              label={`Free now — not in an OC (${summary.notInOc.length})`}
              empty="Everyone's currently slotted."
              items={summary.notInOc}
              render={(m) => (
                <span key={m.id} className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800">
                  <span className="font-medium text-gray-700 dark:text-gray-300">{m.name}</span>
                  <TierPill tier={m.tier} />
                </span>
              )}
            />
          </div>

          {/* Pausing slots — the crimes that count, one slot each */}
          <div className="card">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-1">
              Pausing slots within {pauseHorizon} ({openSlots.openSlotsTotal})
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
              Each crime counts as one slot — filling a single position un-pauses it. Tier shown is the weakest open position.
            </p>
            {openSlots.openCrimes.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">No paused, empty, or soon-to-pause crimes in this window.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {openSlots.openCrimes.map((c) => {
                  const secs = c.pausesAt != null ? c.pausesAt - now : null
                  const status = c.isEmpty ? 'empty' : c.paused ? 'paused' : `pauses ${formatCountdown(secs)}`
                  return (
                    <span key={c.id} className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800" title={`${c.openCount} open positions — counts as 1`}>
                      {c.slotTier == null
                        ? <span className="text-rose-600 dark:text-rose-400 font-semibold text-[11px]">Unmapped</span>
                        : <TierPill tier={c.slotTier} />}
                      <span className="font-medium text-gray-700 dark:text-gray-300">{c.name}</span>
                      <span className="text-gray-400">{c.openCount} open</span>
                      <span className={`font-mono ${c.isEmpty || c.paused ? 'text-rose-600 dark:text-rose-400 font-semibold' : 'text-gray-500 dark:text-gray-400'}`}>
                        {status}
                      </span>
                    </span>
                  )
                })}
              </div>
            )}
            <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-3">
              Slot tiers come from <code className="font-mono">config.tierRequirements</code> (per position), falling back to <code className="font-mono">config.ocTierByCrime</code> / inference for the crime overall.
            </p>
          </div>
        </>
      )}
    </div>
  )
}

function CollapsibleList({ open, onToggle, label, items, render, empty }) {
  return (
    <div>
      <button
        onClick={onToggle}
        className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 mb-1.5"
      >
        <ChevronRight className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
        {label}
      </button>
      {open && (
        items.length === 0
          ? <p className="text-xs text-gray-400 dark:text-gray-500">{empty}</p>
          : <div className="flex flex-wrap gap-1.5">{items.map(render)}</div>
      )}
    </div>
  )
}
