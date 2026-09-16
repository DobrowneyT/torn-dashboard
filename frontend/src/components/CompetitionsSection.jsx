// Competitions (#183): a section on the Members page. Everyone sees the list
// and a selected competition's live leaderboard; leadership gets a create form.
// Needs the faction API + daily-stats snapshots.
import { useState, useEffect } from 'react'
import { apiGet, apiPost, apiPut } from '../utils/apiClient'
import { Trophy, Plus, X, Award, Pin } from 'lucide-react'
import { boundaryValue, windowLabel } from '../utils/competitionWindow'
import { buildPrizes, buildPrizePayload, prizeTableRows, formatPrize, ordinal } from '../utils/competitionPrizes'
import InfoTooltip, { InfoDot } from './InfoTooltip'

function fmtDate(d) {
  if (!d) return ''
  return String(d).slice(0, 10)
}

export default function CompetitionsSection({ isLeadership }) {
  const [competitions, setCompetitions] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState(null)
  const [detail, setDetail] = useState(null)
  const [history, setHistory] = useState([])
  const [detailLoading, setDetailLoading] = useState(false)
  const [resolving, setResolving] = useState(false)
  const [showForm, setShowForm] = useState(false)

  async function loadList() {
    setLoading(true)
    try {
      const { competitions } = await apiGet('/api/competitions')
      setCompetitions(competitions || [])
    } catch {
      setCompetitions([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadList() }, [])

  async function loadDetail(id) {
    const [d, h] = await Promise.allSettled([
      apiGet(`/api/competitions/${id}`),
      apiGet(`/api/competitions/${id}/history`),
    ])
    setDetail(d.status === 'fulfilled' ? d.value : null)
    setHistory(h.status === 'fulfilled' ? (h.value.resolutions || []) : [])
  }

  async function openCompetition(id) {
    if (selectedId === id) { setSelectedId(null); setDetail(null); setHistory([]); return }
    setSelectedId(id); setDetailLoading(true); setDetail(null); setHistory([])
    try {
      await loadDetail(id)
    } finally {
      setDetailLoading(false)
    }
  }

  async function togglePin(c) {
    try {
      await apiPut(`/api/competitions/${c.id}/pin`, { pinned: !c.pinned })
      await loadList()
    } catch (e) {
      alert(e.message)
    }
  }

  async function resolveCompetition(id) {
    setResolving(true)
    try {
      await apiPost(`/api/competitions/${id}/resolve`, {})
      await loadDetail(id)
    } catch (e) {
      // Surfaced inline below via a thrown message; keep the board as-is.
      alert(e.message)
    } finally {
      setResolving(false)
    }
  }

  return (
    <div className="card mb-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 flex items-center gap-2">
          <Trophy className="w-4 h-4 text-amber-500" /> Competitions
        </h3>
        {isLeadership && (
          <button
            onClick={() => setShowForm((s) => !s)}
            className="flex items-center gap-1 px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium"
          >
            {showForm ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
            {showForm ? 'Cancel' : 'New competition'}
          </button>
        )}
      </div>

      {showForm && (
        <CreateCompetitionForm
          onCreated={() => { setShowForm(false); loadList() }}
        />
      )}

      {loading ? (
        <div className="text-sm text-gray-500 dark:text-gray-400 py-2">Loading…</div>
      ) : competitions.length === 0 ? (
        <div className="text-sm text-gray-500 dark:text-gray-400 py-2">No competitions yet.</div>
      ) : (
        <div className="space-y-2">
          {competitions.map((c) => (
            <div key={c.id} className="border border-gray-200 dark:border-slate-700 rounded-lg overflow-hidden">
              <div className="flex items-center hover:bg-gray-50 dark:hover:bg-slate-700/50">
                <button
                  onClick={() => openCompetition(c.id)}
                  className="flex-1 flex items-center justify-between px-3 py-2 text-left"
                >
                  <div>
                    <div className="text-sm font-medium text-gray-900 dark:text-white">
                      {c.name}
                      {c.type === 'lottery' && (
                        <span className="ml-2 px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300 text-[10px] font-semibold align-middle">lottery</span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      {c.metric_id}{c.reducer === 'avg_per_day' ? ' /day' : ''}
                      {c.type === 'lottery' && ` ${c.threshold_comparator === 'lte' ? '≤' : '≥'} ${c.threshold_value}`}
                      {' · '}{windowLabel(c)}
                    </div>
                  </div>
                  <span className="text-xs text-gray-400">{selectedId === c.id ? '▲' : '▼'}</span>
                </button>
                {isLeadership && (
                  <button
                    onClick={() => togglePin(c)}
                    aria-label={c.pinned ? 'Unpin from dashboard' : 'Pin to dashboard'}
                    className={`px-3 py-2 ${c.pinned ? 'text-blue-600 dark:text-blue-400' : 'text-gray-300 dark:text-gray-600 hover:text-gray-500'}`}
                  >
                    <Pin className="w-4 h-4" fill={c.pinned ? 'currentColor' : 'none'} />
                  </button>
                )}
              </div>
              {selectedId === c.id && (
                <div className="border-t border-gray-100 dark:border-slate-700 p-2 space-y-3">
                  {detailLoading ? (
                    <div className="text-xs text-gray-500 py-2 px-1">Loading standings…</div>
                  ) : (
                    <>
                      <PrizeTable competition={c} />
                      <div>
                        <div className="flex items-center justify-between px-1 mb-1">
                          <span className="text-xs font-semibold text-gray-500 dark:text-gray-400">
                            {c.type === 'lottery' ? 'Qualified pool' : 'Live standings'}
                          </span>
                          {isLeadership && (
                            <span className="inline-flex items-center gap-1.5">
                            <button
                              onClick={() => resolveCompetition(c.id)}
                              disabled={resolving || (detail?.standings || []).length === 0}
                              className="flex items-center gap-1 px-2.5 py-1 rounded bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium disabled:opacity-50"
                            >
                              <Award className="w-3.5 h-3.5" />
                              {resolving ? 'Recording…' : c.type === 'lottery' ? 'Draw winner' : 'Close & record result'}
                            </button>
                            {/* Its own tap target — resolving a competition is
                                irreversible, so what the button is about to do
                                must be readable BEFORE pressing it. */}
                            <InfoDot label="What resolving does" size={12}>
                              {c.type === 'lottery'
                                ? 'Draws a winner at random from the qualified pool and records it.'
                                : 'Freezes the current standings into history and crowns the winner.'}
                            </InfoDot>
                            </span>
                          )}
                        </div>
                        <Leaderboard standings={detail?.standings || []} lottery={c.type === 'lottery'} />
                      </div>
                      {history.length > 0 && <HistoryList resolutions={history} />}
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// Async item picker for an item prize slot (#241): a debounced name search over
// the catalogue plus a quantity. Selecting a result stores id + name + qty on
// the slot; buildPrizes submits only id + qty (the server re-stamps the name).
function ItemPrizeInput({ slot, onChange, field }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const q = query.trim()
    if (!q) { setResults([]); return }
    let live = true
    const t = setTimeout(() => {
      apiGet(`/api/items/search?q=${encodeURIComponent(q)}`)
        .then(({ items }) => { if (live) setResults(items || []) })
        .catch(() => { if (live) setResults([]) })
    }, 250)
    return () => { live = false; clearTimeout(t) }
  }, [query])

  const pick = (it) => {
    onChange({ item_id: it.id, name: it.name })
    setQuery(''); setResults([]); setOpen(false)
  }

  return (
    <div className="flex items-center gap-2 grow">
      <input type="number" min="1" step="1" className="px-2 py-1 rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-900 dark:text-white text-sm w-16 shrink-0"
        value={slot.qty ?? 1} onChange={(e) => onChange({ qty: e.target.value })} aria-label="Quantity" />
      <div className="relative grow">
        <input type="text" className={field}
          placeholder={slot.item_id ? `${slot.name}` : 'search item…'}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)} />
        {open && results.length > 0 && (
          <ul className="absolute z-10 mt-1 w-full max-h-48 overflow-auto rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 shadow-lg text-sm">
            {results.map((it) => (
              <li key={it.id}>
                <button type="button" onClick={() => pick(it)}
                  className="block w-full text-left px-2 py-1 hover:bg-blue-50 dark:hover:bg-slate-600 text-gray-900 dark:text-white">
                  {it.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

// The prize table shown to every member on a competition (#239).
function PrizeTable({ competition }) {
  const rows = prizeTableRows(competition)
  if (rows.length === 0) return null
  return (
    <div className="px-1">
      <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">Prizes</div>
      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
        {rows.map((r) => (
          <span key={r.place} className="text-gray-700 dark:text-gray-200">
            <span className="text-gray-400">{r.place}</span> {r.prize}
          </span>
        ))}
      </div>
    </div>
  )
}

function HistoryList({ resolutions }) {
  const [openSeq, setOpenSeq] = useState(null)
  return (
    <div className="pt-1">
      <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 px-1 mb-1">Past results</div>
      <div className="space-y-1">
        {resolutions.map((r) => (
          <div key={r.resolution_seq} className="rounded border border-gray-100 dark:border-slate-700">
            <button
              onClick={() => setOpenSeq(openSeq === r.resolution_seq ? null : r.resolution_seq)}
              className="w-full flex items-center justify-between px-2 py-1.5 text-left hover:bg-gray-50 dark:hover:bg-slate-700/40"
            >
              <span className="text-xs text-gray-600 dark:text-gray-300">
                {fmtDate(r.resolved_at)} · winner{' '}
                <span className="font-medium text-amber-600 dark:text-amber-400">
                  {r.winner ? `${r.winner.member_name} (${Number(r.winner.value).toLocaleString()})` : '—'}
                </span>
              </span>
              <span className="text-xs text-gray-400">{openSeq === r.resolution_seq ? '▲' : '▼'}</span>
            </button>
            {openSeq === r.resolution_seq && (
              <div className="border-t border-gray-100 dark:border-slate-700 p-1">
                <Leaderboard standings={r.standings} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function Leaderboard({ standings, lottery = false }) {
  if (standings.length === 0) {
    return <div className="text-xs text-gray-500 dark:text-gray-400 py-2 px-1">No data in this window yet.</div>
  }
  // In a lottery, non-qualifiers are shown greyed (they're not in the draw).
  // Frozen history rows carry no `qualified` flag — they are all pool members.
  // A resolved board carries the prize each member earned (#239) → show it.
  const showPrize = standings.some((r) => r.prize)
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-xs text-gray-500 dark:text-gray-400 text-left">
          <th className="py-1 px-2 w-10">#</th>
          <th className="py-1 px-2">Member</th>
          <th className="py-1 px-2 text-right">Value</th>
          {showPrize && <th className="py-1 px-2 text-right">Prize</th>}
        </tr>
      </thead>
      <tbody>
        {standings.map((r) => {
          const dimmed = lottery && r.qualified === false
          return (
            <tr key={r.member_id} className={`border-t border-gray-100 dark:border-slate-700/50 ${dimmed ? 'opacity-40' : ''}`}>
              <td className="py-1 px-2 text-gray-500 dark:text-gray-400">{dimmed ? '—' : r.rank}</td>
              <td className="py-1 px-2 text-gray-900 dark:text-white">
                {r.member_name} <span className="text-gray-400">[{r.member_id}]</span>
                {r.partial && (
                  <InfoTooltip label="⚑" decoration="no-underline" className="ml-1 text-amber-500">
                    Partial — the first snapshot is after the window opened, so this
                    isn&apos;t a full-window figure.
                  </InfoTooltip>
                )}
                {lottery && r.qualified && (
                  <InfoTooltip label="✓" decoration="no-underline" className="ml-1 text-green-600 dark:text-green-400">
                    Qualifies for the draw
                  </InfoTooltip>
                )}
              </td>
              <td className="py-1 px-2 text-right font-medium text-gray-900 dark:text-white">
                {Number(r.value).toLocaleString()}
              </td>
              {showPrize && (
                <td className="py-1 px-2 text-right text-amber-600 dark:text-amber-400">{formatPrize(r.prize)}</td>
              )}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function CreateCompetitionForm({ onCreated }) {
  const [metrics, setMetrics] = useState([])
  const [name, setName] = useState('')
  const [type, setType] = useState('leaderboard')
  const [metricId, setMetricId] = useState('')
  const [direction, setDirection] = useState('desc')
  const [reducer, setReducer] = useState('total')
  const [thresholdComparator, setThresholdComparator] = useState('gte')
  const [thresholdValue, setThresholdValue] = useState('')
  const [windowKind, setWindowKind] = useState('fixed')
  const [windowStart, setWindowStart] = useState('')
  const [windowEnd, setWindowEnd] = useState('')
  const [windowStartTime, setWindowStartTime] = useState('')
  const [windowEndTime, setWindowEndTime] = useState('')
  // Prize distribution (#240): 'placement' = ranked slots, 'flat' = one prize to
  // everyone (collapsed to a single slot). Slots are cash or text (#239).
  const [prizeKind, setPrizeKind] = useState('placement')
  const [prizeSlots, setPrizeSlots] = useState([])
  const addPrize = () => setPrizeSlots((s) => [...s, { kind: 'cash', amount: '', text: '' }])
  const updatePrize = (i, patch) => setPrizeSlots((s) => s.map((p, j) => (j === i ? { ...p, ...patch } : p)))
  const removePrize = (i) => setPrizeSlots((s) => s.filter((_, j) => j !== i))
  const isFlat = prizeKind === 'flat'
  // Flat awards a single prize — keep at most one slot when that mode is on.
  const setDistribution = (kind) => {
    setPrizeKind(kind)
    if (kind === 'flat') setPrizeSlots((s) => (s.length ? [s[0]] : [{ kind: 'cash', amount: '', text: '' }]))
  }
  const [rollingDays, setRollingDays] = useState(90)
  const [autoResolve, setAutoResolve] = useState(false)
  const [resolveIntervalDays, setResolveIntervalDays] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  useEffect(() => {
    apiGet('/api/competitions/metrics')
      .then(({ metrics }) => {
        setMetrics(metrics || [])
        if (metrics?.length) setMetricId(metrics[0].id)
      })
      .catch(() => setMetrics([]))
  }, [])

  const selectedMetric = metrics.find((m) => m.id === metricId)
  const reducers = selectedMetric?.reducers || ['total']
  // Keep the reducer valid when the metric changes.
  useEffect(() => {
    if (!reducers.includes(reducer)) setReducer(reducers[0])
  }, [metricId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(e) {
    e.preventDefault()
    setErr(null); setBusy(true)
    try {
      const payload = { name, type, metric_id: metricId, direction, reducer, window_kind: windowKind, auto_resolve: autoResolve }
      if (windowKind === 'rolling') {
        payload.rolling_days = Number(rollingDays)
        if (autoResolve && resolveIntervalDays) payload.resolve_interval_days = Number(resolveIntervalDays)
      } else {
        // A time-of-day is optional (#231): with one, submit an exact TCT
        // timestamp; without, a bare date the API maps to start/end-of-day.
        payload.window_start = boundaryValue(windowStart, windowStartTime)
        payload.window_end = boundaryValue(windowEnd, windowEndTime)
      }
      if (type === 'lottery') {
        payload.threshold_comparator = thresholdComparator
        payload.threshold_value = Number(thresholdValue)
      }
      // Prizes (#239/#240) — informational; blank slots dropped, flat capped to one.
      Object.assign(payload, buildPrizePayload(prizeKind, prizeSlots))
      await apiPost('/api/competitions', payload)
      onCreated()
    } catch (e2) {
      setErr(e2.message)
    } finally {
      setBusy(false)
    }
  }

  const field = 'w-full px-3 py-2 rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-900 dark:text-white text-sm'

  return (
    <form onSubmit={submit} className="mb-4 p-3 rounded-lg bg-gray-50 dark:bg-slate-700/40 space-y-3">
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="text-xs text-gray-600 dark:text-gray-400">Name</span>
          <input className={field} value={name} onChange={(e) => setName(e.target.value)}
            placeholder="July Xanax Grind" required />
        </label>
        <label className="block">
          <span className="text-xs text-gray-600 dark:text-gray-400">Type</span>
          <select className={field} value={type} onChange={(e) => setType(e.target.value)}>
            <option value="leaderboard">Leaderboard (rank, highest/lowest wins)</option>
            <option value="lottery">Lottery (meet a threshold, random draw)</option>
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-gray-600 dark:text-gray-400">Metric</span>
          <select className={field} value={metricId} onChange={(e) => setMetricId(e.target.value)} required>
            {metrics.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </label>
        {type === 'lottery' && (
          <label className="block">
            <span className="text-xs text-gray-600 dark:text-gray-400">Qualify when the value is</span>
            <div className="flex gap-2">
              <select className={field} value={thresholdComparator} onChange={(e) => setThresholdComparator(e.target.value)}>
                <option value="gte">at least</option>
                <option value="lte">at most</option>
              </select>
              <input type="number" step="any" className={field} value={thresholdValue}
                onChange={(e) => setThresholdValue(e.target.value)} placeholder="threshold" required />
            </div>
          </label>
        )}
        <label className="block">
          <span className="text-xs text-gray-600 dark:text-gray-400">Window</span>
          <select className={field} value={windowKind} onChange={(e) => setWindowKind(e.target.value)}>
            <option value="fixed">Fixed dates</option>
            <option value="rolling">Rolling (last N days)</option>
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-gray-600 dark:text-gray-400">Score</span>
          <select className={field} value={reducer} onChange={(e) => setReducer(e.target.value)}>
            {reducers.includes('total') && <option value="total">Total over window</option>}
            {reducers.includes('avg_per_day') && <option value="avg_per_day">Average per day</option>}
          </select>
        </label>
        {windowKind === 'fixed' ? (
          <>
            <label className="block">
              <span className="text-xs text-gray-600 dark:text-gray-400">Start date</span>
              <div className="flex gap-2">
                <input type="date" className={field} value={windowStart} onChange={(e) => setWindowStart(e.target.value)} required />
                <input type="time" className={field} value={windowStartTime} onChange={(e) => setWindowStartTime(e.target.value)}
                  aria-label="Optional start time (TCT)" />
              </div>
            </label>
            <label className="block">
              <span className="text-xs text-gray-600 dark:text-gray-400">End date</span>
              <div className="flex gap-2">
                <input type="date" className={field} value={windowEnd} onChange={(e) => setWindowEnd(e.target.value)} required />
                <input type="time" className={field} value={windowEndTime} onChange={(e) => setWindowEndTime(e.target.value)}
                  aria-label="Optional end time (TCT)" />
              </div>
            </label>
            <p className="sm:col-span-2 text-[11px] text-gray-500 dark:text-gray-400 -mt-1">
              Times are Torn City Time (TCT). Leave a time blank for start-of-day / end-of-day.
            </p>
          </>
        ) : (
          <label className="block">
            <span className="text-xs text-gray-600 dark:text-gray-400">Trailing days</span>
            <input type="number" min="1" max="366" className={field} value={rollingDays}
              onChange={(e) => setRollingDays(e.target.value)} required />
          </label>
        )}
        <label className="block">
          <span className="text-xs text-gray-600 dark:text-gray-400">Ranking</span>
          <select className={field} value={direction} onChange={(e) => setDirection(e.target.value)}>
            <option value="desc">Highest wins</option>
            <option value="asc">Lowest wins</option>
          </select>
        </label>
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-gray-600 dark:text-gray-400">Prizes (optional)</span>
          <div className="flex items-center gap-3">
            <select className="px-2 py-1 rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-900 dark:text-white text-xs"
              value={prizeKind} onChange={(e) => setDistribution(e.target.value)}>
              <option value="placement">Placement</option>
              <option value="flat">Flat (everyone)</option>
            </select>
            {!isFlat && (
              <button type="button" onClick={addPrize} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">+ Add prize</button>
            )}
          </div>
        </div>
        {prizeSlots.map((p, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="text-xs text-gray-400 w-14 shrink-0">{isFlat ? 'Everyone' : ordinal(i + 1)}</span>
            <select className="px-2 py-1 rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-900 dark:text-white text-sm shrink-0"
              value={p.kind} onChange={(e) => updatePrize(i, { kind: e.target.value })}>
              <option value="cash">Cash</option>
              <option value="text">Text</option>
              <option value="item">Item</option>
            </select>
            {p.kind === 'cash' ? (
              <input type="number" min="1" step="any" className={field} placeholder="amount ($)"
                value={p.amount} onChange={(e) => updatePrize(i, { amount: e.target.value })} />
            ) : p.kind === 'item' ? (
              <ItemPrizeInput slot={p} onChange={(patch) => updatePrize(i, patch)} field={field} />
            ) : (
              <input type="text" maxLength={120} className={field} placeholder="e.g. Bragging rights"
                value={p.text} onChange={(e) => updatePrize(i, { text: e.target.value })} />
            )}
            {!isFlat && (
              <button type="button" onClick={() => removePrize(i)} className="text-gray-400 hover:text-red-500 shrink-0" aria-label="Remove prize">
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        ))}
        <p className="text-[11px] text-gray-500 dark:text-gray-400">
          {isFlat
            ? 'Flat — one prize awarded to every ranked / qualified member. Cash, text, or a Torn item.'
            : 'Placement — 1st, 2nd, 3rd… A lottery awards the top slot to the drawn winner. Cash, text, or a Torn item.'}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
          <input type="checkbox" checked={autoResolve} onChange={(e) => setAutoResolve(e.target.checked)} />
          Auto-resolve{' '}
          {windowKind === 'fixed'
            ? '(close automatically at the end date)'
            : '(draw automatically on an interval)'}
        </label>
        {autoResolve && windowKind === 'rolling' && (
          <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
            Draw every
            <input type="number" min="1" max="366" placeholder="= window"
              className="w-20 px-2 py-1 rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-900 dark:text-white text-sm"
              value={resolveIntervalDays} onChange={(e) => setResolveIntervalDays(e.target.value)} />
            days
          </label>
        )}
      </div>
      {err && <div className="text-xs text-red-500">{err}</div>}
      <button type="submit" disabled={busy}
        className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium disabled:opacity-50">
        {busy ? 'Creating…' : 'Create competition'}
      </button>
    </form>
  )
}
