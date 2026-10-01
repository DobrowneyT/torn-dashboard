import { useState, useEffect, useMemo, useCallback } from 'react'
import { apiGet } from '../utils/apiClient'
import { config } from '../config'
import InfoTooltip from '../components/InfoTooltip'
import { RefreshCw, ChevronRight } from 'lucide-react'
import {
  HORIZONS,
  makeCategoryResolver,
  advancedCrimeNames,
  qualifiesForAdvanced,
  maxCategoryForMember,
  buildBase,
  selectAvailable,
  selectPausingSlots,
  buildSpawnPlan,
} from '../utils/ocPlanner'
import SortableTh, { useTableSort } from '../components/SortableTh.jsx'

// ── Presentation maps ────────────────────────────────────────────────────────
const CAT_META = {
  advanced:     { label: 'Advanced',     sub: 'Lv7-8',  bg: 'bg-violet-600', soft: 'bg-violet-50 dark:bg-violet-900/20 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-800' },
  intermediate: { label: 'Intermediate', sub: 'Lv5-6',  bg: 'bg-sky-600',    soft: 'bg-sky-50 dark:bg-sky-900/20 text-sky-700 dark:text-sky-300 border-sky-200 dark:border-sky-800' },
  simple:       { label: 'Simple',       sub: 'Lv3-4',  bg: 'bg-slate-500',  soft: 'bg-slate-100 dark:bg-slate-700/40 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-600' },
  elaborate:    { label: 'Elaborate',    sub: 'Lv8-10', bg: 'bg-rose-600',   soft: 'bg-rose-50 dark:bg-rose-900/20 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800' },
  introductory: { label: 'Introductory', sub: 'Lv1-2',  bg: 'bg-gray-400',   soft: 'bg-gray-100 dark:bg-gray-700/40 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-600' },
}
const catLabel = (c) => CAT_META[c]?.label ?? (c === 'unmapped' || c == null ? 'Unmapped' : c)

const TIER_BG = { 0: 'bg-tier-review', 1: 'bg-tier-1', 2: 'bg-tier-2', 3: 'bg-tier-3', 4: 'bg-tier-4', 5: 'bg-tier-5', 6: 'bg-tier-6' }
function TierPill({ tier }) {
  const isReview = tier == null || tier === 0
  return (
    <span className={`inline-flex items-center rounded text-white font-semibold leading-none px-1.5 py-0.5 text-[10px] ${isReview ? TIER_BG[0] : (TIER_BG[tier] ?? TIER_BG[0])}`}>
      {isReview ? 'Rev' : `T${tier}`}
    </span>
  )
}

function CatPill({ category, sub }) {
  const m = CAT_META[category]
  return (
    <span className={`inline-flex items-center gap-1 rounded text-white font-semibold leading-none px-1.5 py-0.5 text-[11px] ${m?.bg ?? 'bg-gray-400'}`}>
      {catLabel(category)}{sub && m && <span className="opacity-75 font-normal">{m.sub}</span>}
    </span>
  )
}

function HorizonToggle({ label, value, onChange }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">{label}</span>
      <div className="inline-flex rounded-lg border border-gray-200 dark:border-slate-600 overflow-hidden">
        {Object.keys(HORIZONS).map((h) => (
          <button key={h} onClick={() => onChange(h)}
            className={`px-2.5 py-1 text-sm font-medium transition-colors ${value === h ? 'bg-blue-600 text-white' : 'bg-white dark:bg-slate-800 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-slate-700'}`}>
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
  const [crimes, setCrimes] = useState(null)
  const [roster, setRoster] = useState({ currentMembers: [], memberCategory: {}, memberNames: {}, memberTiers: {} })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastUpdated, setLastUpdated] = useState(null)
  const [memberHorizon, setMemberHorizon] = useState('24h')
  const [crimesHorizon, setCrimesHorizon] = useState('24h')
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  const [feedOpen, setFeedOpen] = useState(true)
  const [membersOpen, setMembersOpen] = useState(false)

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(id)
  }, [])

  const categoryOf = useMemo(
    () => makeCategoryResolver({ scenarios: config.ocScenarios || {}, categories: config.ocCategories || {} }),
    [],
  )
  // One role-gated call gives the live board, roster, and T3 CPR; the faction's
  // CPR requirements come from its DB-backed OC config rather than code.
  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [data, ocConfig] = await Promise.all([
        apiGet('/api/oc-planner/data'),
        apiGet('/api/oc-config'),
      ])
      const cprReqs = ocConfig.cpr_requirements || {}
      const advNames = advancedCrimeNames({ scenarios: config.ocScenarios || {}, cprRequirements: cprReqs })

      const memberNames = {}
      const memberTiers = {}
      const current = [] // { id, name, tier }
      for (const m of data.roster) {
        const id = String(m.member_id)
        memberNames[id] = m.member_name
        const tier = m.tier_override ?? m.tier ?? 6 // ?? keeps tier 0 (review)
        memberTiers[id] = tier
        if (m.is_current) current.push({ id, name: m.member_name, tier })
      }

      // T3-only Advanced check, using the CPR the server bundled in.
      const advancedT3 = new Set()
      for (const [id, cprMap] of Object.entries(data.t3_cpr || {})) {
        if (qualifiesForAdvanced(cprMap, { cprRequirements: cprReqs, advancedNames: advNames })) {
          advancedT3.add(id)
        }
      }
      const crimesRes = data.live_crimes

      const memberCategory = {}
      const currentMembers = current.map((m) => {
        const category = maxCategoryForMember(m.tier, advancedT3.has(m.id))
        memberCategory[m.id] = category
        return { ...m, category }
      })

      setRoster({ currentMembers, memberCategory, memberNames, memberTiers })
      setCrimes(crimesRes.crimes || [])
      setLastUpdated(Date.now())
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const base = useMemo(
    () => buildBase({ crimes: crimes || [], ...roster, categoryOf }),
    [crimes, roster, categoryOf],
  )
  const avail = useMemo(
    () => selectAvailable(base, { now, memberHorizonSecs: HORIZONS[memberHorizon] }),
    [base, now, memberHorizon],
  )
  const pausing = useMemo(
    () => selectPausingSlots(base, { now, crimesHorizonSecs: HORIZONS[crimesHorizon] }),
    [base, now, crimesHorizon],
  )
  const plan = useMemo(
    () => buildSpawnPlan({ membersByCategory: avail.membersByCategory, pausingByCategory: pausing.pausingByCategory, categories: config.ocCategories || {} }),
    [avail, pausing],
  )

  const toSpawn = plan.plannable.filter((c) => plan.rows[c].scenariosToSpawn > 0)
  const crewsShort = plan.plannable.filter((c) => plan.rows[c].crewsShort > 0)

  // Member free/out split per category (for the table).
  const splitFor = (cat) => ({
    free: avail.members.filter((m) => m.category === cat && m.source === 'free').length,
    out: avail.members.filter((m) => m.category === cat && m.source === 'coming').length,
  })

  // ⚠️ The ROWS here are category strings; their data lives in `plan.rows[c]`
  // and `splitFor(c)`, so every accessor is a lookup rather than a field.
  //
  // ⚠️ Keys are stable ids, NOT the header text. Two headers carry a horizon
  // that changes with a control ("Free / Out ≤3d"), and sort state keyed on
  // the rendered label would break the moment somebody changed the horizon.
  const plannerColumns = useMemo(() => ([
    { key: 'category',   kind: 'text',   accessor: (c) => c },
    { key: 'free',       kind: 'number', accessor: (c) => splitFor(c).free },
    { key: 'available',  kind: 'number', accessor: (c) => plan.rows[c]?.members },
    { key: 'pausing',    kind: 'number', accessor: (c) => plan.rows[c]?.pausing },
    { key: 'spawn',      kind: 'number', accessor: (c) => plan.rows[c]?.scenariosToSpawn },
    { key: 'crewsShort', kind: 'number', accessor: (c) => plan.rows[c]?.crewsShort },
    { key: 'scope',      kind: 'number', accessor: (c) => plan.rows[c]?.scopeCost },
  ]), [plan, avail])

  // ⚠️ Opens on category, preserving the order this table already read in —
  // the planner groups by category and people know where to look.
  const { sorted: sortedPlannable, sortCol, sortDir, onSort } =
    useTableSort(plan.plannable, plannerColumns, {
      initialCol: 'category', tieBreak: 'category',
    })

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="card">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold text-gray-900 dark:text-white">OC Planner</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Live from Torn — keep the pipeline full: feed pausing crimes, and spawn new scenarios for the surplus.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <HorizonToggle label="Members out" value={memberHorizon} onChange={setMemberHorizon} />
            <HorizonToggle label="Crimes window" value={crimesHorizon} onChange={setCrimesHorizon} />
            <button onClick={load} disabled={loading}
              className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 whitespace-nowrap">
              {loading ? <><div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" /> Refreshing…</> : <><RefreshCw className="w-4 h-4" /> Refresh</>}
            </button>
          </div>
        </div>
        {lastUpdated && (
          <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-2">
            {/* db-time-safe: lastUpdated is Date.now(). */}
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
          {/* Headline: scenarios to spawn */}
          <div className="card">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-1">
              Recommended to spawn
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
              For members free or coming out within <strong>{memberHorizon}</strong>, after feeding crimes pausing within <strong>{crimesHorizon}</strong>. One new crime seeds each surplus member.
            </p>
            {toSpawn.length === 0 ? (
              <div className="rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/20 px-4 py-5 text-center">
                <p className="text-emerald-700 dark:text-emerald-300 font-medium">
                  Pipeline balanced — every available member has a pausing crime to feed.
                </p>
              </div>
            ) : (
              <div className="flex flex-wrap items-stretch gap-2">
                {toSpawn.map((c) => (
                  <div key={c} className={`flex items-center gap-2 rounded-lg px-4 py-3 text-white ${CAT_META[c].bg}`}>
                    <span className="text-2xl font-bold leading-none">{plan.rows[c].scenariosToSpawn}×</span>
                    <span className="text-sm font-semibold leading-tight">{CAT_META[c].label}<br /><span className="opacity-80 font-normal text-xs">{CAT_META[c].sub}</span></span>
                  </div>
                ))}
                <div className="flex flex-col justify-center px-3 text-sm text-gray-500 dark:text-gray-400">
                  <span>{plan.scenariosTotal} scenario{plan.scenariosTotal === 1 ? '' : 's'}</span>
                  <span className="text-xs">≈ {plan.scopeTotal} Scope</span>
                </div>
              </div>
            )}
            {crewsShort.length > 0 && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-3">
                ⚠ Crews short: {crewsShort.map((c) => `${plan.rows[c].crewsShort}× ${CAT_META[c].label}`).join(', ')} — more pausing crimes than members to feed them, so these may stall.
              </p>
            )}
            {avail.reviewCount > 0 && (
              <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-1">
                {avail.reviewCount} available member{avail.reviewCount === 1 ? '' : 's'} still need a tier review — not categorized above.
              </p>
            )}
            <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1">
              Scope shown is the recommendation's cost (Advanced 4 / Intermediate 3 / Simple 2). Current balance isn't in our data feed.
            </p>
          </div>

          {/* Category table */}
          <div className="card">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-3">
              By category — supply vs. pipeline demand
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-slate-700">
                    <SortableTh col="category" className="py-2 pr-3 font-semibold" sortCol={sortCol} sortDir={sortDir} onSort={onSort} label="Category">Category</SortableTh>
                    <SortableTh col="free" className="py-2 px-3 font-semibold text-right" sortCol={sortCol} sortDir={sortDir} onSort={onSort} label="Free">Free / Out ≤{memberHorizon}</SortableTh>
                    <SortableTh col="available" className="py-2 px-3 font-semibold text-right" sortCol={sortCol} sortDir={sortDir} onSort={onSort} label="Available">Available</SortableTh>
                    <SortableTh col="pausing" className="py-2 px-3 font-semibold text-right" sortCol={sortCol} sortDir={sortDir} onSort={onSort} label="Pausing">Pausing ≤{crimesHorizon}</SortableTh>
                    <SortableTh col="spawn" className="py-2 px-3 font-semibold text-right" sortCol={sortCol} sortDir={sortDir} onSort={onSort} label="Spawn">Spawn</SortableTh>
                    <SortableTh col="crewsShort" className="py-2 px-3 font-semibold text-right" sortCol={sortCol} sortDir={sortDir} onSort={onSort} label="Crews short">Crews short</SortableTh>
                    <SortableTh col="scope" className="py-2 pl-3 font-semibold text-right" sortCol={sortCol} sortDir={sortDir} onSort={onSort} label="Scope">Scope</SortableTh>
                  </tr>
                </thead>
                <tbody>
                  {sortedPlannable.map((c) => {
                    const r = plan.rows[c]
                    const { free, out } = splitFor(c)
                    return (
                      <tr key={c} className="border-b border-gray-100 dark:border-slate-700/50">
                        <td className="py-2 pr-3"><CatPill category={c} sub /></td>
                        <td className="py-2 px-3 text-right text-gray-600 dark:text-gray-300">{free} / {out}</td>
                        <td className="py-2 px-3 text-right font-semibold">{r.members || '—'}</td>
                        <td className="py-2 px-3 text-right text-gray-600 dark:text-gray-300">{r.pausing || '—'}</td>
                        <td className={`py-2 px-3 text-right font-bold ${r.scenariosToSpawn > 0 ? 'text-violet-600 dark:text-violet-400' : 'text-gray-400'}`}>{r.scenariosToSpawn > 0 ? `+${r.scenariosToSpawn}` : '0'}</td>
                        <td className={`py-2 px-3 text-right ${r.crewsShort > 0 ? 'text-amber-600 dark:text-amber-400 font-semibold' : 'text-gray-400'}`}>{r.crewsShort || '—'}</td>
                        <td className="py-2 pl-3 text-right text-gray-600 dark:text-gray-300">{r.scopeCost || '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr className="text-xs text-gray-500 dark:text-gray-400">
                    <td className="pt-2 pr-3 font-semibold">Total</td>
                    <td className="pt-2 px-3 text-right">{avail.freeNowCount} / {avail.comingOutCount}</td>
                    <td className="pt-2 px-3 text-right font-semibold">{avail.members.length - avail.reviewCount}</td>
                    <td className="pt-2 px-3 text-right">{plan.plannable.reduce((n, c) => n + plan.rows[c].pausing, 0)}</td>
                    <td className="pt-2 px-3 text-right font-bold text-violet-600 dark:text-violet-400">+{plan.scenariosTotal}</td>
                    <td className="pt-2 px-3 text-right">{plan.crewsShortTotal || '—'}</td>
                    <td className="pt-2 pl-3 text-right font-semibold">{plan.scopeTotal}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-3">
              <strong>Available</strong> = free now + coming out within {memberHorizon}. <strong>Pausing</strong> = crimes paused/empty or pausing within {crimesHorizon}, each needing one feed. <strong>Spawn</strong> = members with no pausing crime to join.
            </p>
          </div>

          {/* Feed queue */}
          <div className="card">
            <button onClick={() => setFeedOpen((o) => !o)}
              className="flex items-center gap-1 text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300">
              <ChevronRight className={`w-4 h-4 transition-transform ${feedOpen ? 'rotate-90' : ''}`} />
              Feed queue — crimes to plug first ({pausing.feedQueue.length})
            </button>
            {feedOpen && (
              <div className="mt-3">
                {pausing.feedQueue.length === 0 ? (
                  <p className="text-sm text-gray-500 dark:text-gray-400">No paused, empty, or soon-to-pause crimes in this window.</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {pausing.feedQueue.map((c) => {
                      const secs = c.pausesAt != null ? c.pausesAt - now : null
                      const status = c.isEmpty ? 'empty' : c.paused ? 'paused' : `pauses ${formatCountdown(secs)}`
                      return (
                        <InfoTooltip
                          key={c.id}
                          decoration="no-underline"
                          className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800"
                          label={<>
                          <CatPill category={c.category} />
                          <span className="font-medium text-gray-700 dark:text-gray-300">{c.name}</span>
                          <span className={`font-mono ${c.isEmpty || c.paused ? 'text-rose-600 dark:text-rose-400 font-semibold' : 'text-gray-500 dark:text-gray-400'}`}>{status}</span>
                          </>}
                        >
                          {c.openCount} open seats — needs 1 to un-pause.
                        </InfoTooltip>
                      )
                    })}
                  </div>
                )}
                <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-2">
                  Ordered most-urgent first. Each crime needs just <strong>one</strong> member to reset its 24h clock — feed one, then move to the next.
                </p>
              </div>
            )}
          </div>

          {/* Available members by category */}
          <div className="card">
            <button onClick={() => setMembersOpen((o) => !o)}
              className="flex items-center gap-1 text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300">
              <ChevronRight className={`w-4 h-4 transition-transform ${membersOpen ? 'rotate-90' : ''}`} />
              Available members ({avail.members.length})
            </button>
            {membersOpen && (
              <div className="mt-3 space-y-3">
                {[...plan.plannable, null].map((cat) => {
                  const list = avail.members.filter((m) => m.category === cat)
                  if (list.length === 0) return null
                  return (
                    <div key={cat ?? 'review'}>
                      <div className="flex items-center gap-2 mb-1.5">
                        {cat ? <CatPill category={cat} sub /> : <span className="text-xs font-semibold text-gray-500 dark:text-gray-400">Needs tier review</span>}
                        <span className="text-xs text-gray-400">{list.length}</span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {list.map((m) => {
                          const secs = m.source === 'coming' ? m.readyAt - now : null
                          return (
                            <InfoTooltip
                              key={m.id}
                              decoration="no-underline"
                              className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800"
                              label={<>
                              <span className="font-medium text-gray-700 dark:text-gray-300">{m.name}</span>
                              <TierPill tier={m.tier} />
                              {m.source === 'coming'
                                ? <span className="font-mono text-gray-500 dark:text-gray-400">{secs <= 0 ? 'ready' : formatCountdown(secs)}</span>
                                : <span className="text-emerald-600 dark:text-emerald-400">free</span>}
                              </>}
                            >
                              {m.source === 'coming' ? `Out of ${m.crimeName}` : 'Free now'}
                            </InfoTooltip>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
