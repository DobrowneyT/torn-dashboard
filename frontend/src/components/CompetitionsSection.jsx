// Competitions (#183): a section on the Members page. Everyone sees the list
// and a selected competition's live leaderboard; leadership gets a create form.
// API-only feature (needs the faction API + daily-stats snapshots), so the
// caller gates rendering on API_MODE.
import { useState, useEffect } from 'react'
import { apiGet, apiPost } from '../utils/apiClient'
import { Trophy, Plus, X, Award } from 'lucide-react'

function fmtDate(d) {
  if (!d) return ''
  return String(d).slice(0, 10)
}

function windowLabel(c) {
  if (c.window_kind === 'rolling') return `rolling · last ${c.rolling_days} days`
  return `${fmtDate(c.window_start)} → ${fmtDate(c.window_end)}`
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
              <button
                onClick={() => openCompetition(c.id)}
                className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-slate-700/50"
              >
                <div>
                  <div className="text-sm font-medium text-gray-900 dark:text-white">{c.name}</div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {c.metric_id}{c.reducer === 'avg_per_day' ? ' /day' : ''} · {windowLabel(c)}
                  </div>
                </div>
                <span className="text-xs text-gray-400">{selectedId === c.id ? '▲' : '▼'}</span>
              </button>
              {selectedId === c.id && (
                <div className="border-t border-gray-100 dark:border-slate-700 p-2 space-y-3">
                  {detailLoading ? (
                    <div className="text-xs text-gray-500 py-2 px-1">Loading standings…</div>
                  ) : (
                    <>
                      <div>
                        <div className="flex items-center justify-between px-1 mb-1">
                          <span className="text-xs font-semibold text-gray-500 dark:text-gray-400">Live standings</span>
                          {isLeadership && (
                            <button
                              onClick={() => resolveCompetition(c.id)}
                              disabled={resolving || (detail?.standings || []).length === 0}
                              className="flex items-center gap-1 px-2.5 py-1 rounded bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium disabled:opacity-50"
                              title="Freeze the current standings into history and crown the winner"
                            >
                              <Award className="w-3.5 h-3.5" />
                              {resolving ? 'Recording…' : 'Close & record result'}
                            </button>
                          )}
                        </div>
                        <Leaderboard standings={detail?.standings || []} />
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

function Leaderboard({ standings }) {
  if (standings.length === 0) {
    return <div className="text-xs text-gray-500 dark:text-gray-400 py-2 px-1">No data in this window yet.</div>
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-xs text-gray-500 dark:text-gray-400 text-left">
          <th className="py-1 px-2 w-10">#</th>
          <th className="py-1 px-2">Member</th>
          <th className="py-1 px-2 text-right">Value</th>
        </tr>
      </thead>
      <tbody>
        {standings.map((r) => (
          <tr key={r.member_id} className="border-t border-gray-100 dark:border-slate-700/50">
            <td className="py-1 px-2 text-gray-500 dark:text-gray-400">{r.rank}</td>
            <td className="py-1 px-2 text-gray-900 dark:text-white">
              {r.member_name} <span className="text-gray-400">[{r.member_id}]</span>
              {r.partial && (
                <span
                  className="ml-1 text-amber-500 cursor-help"
                  title="Partial — first snapshot is after the window opened, so this isn't a full-window figure"
                >⚑</span>
              )}
            </td>
            <td className="py-1 px-2 text-right font-medium text-gray-900 dark:text-white">
              {Number(r.value).toLocaleString()}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function CreateCompetitionForm({ onCreated }) {
  const [metrics, setMetrics] = useState([])
  const [name, setName] = useState('')
  const [metricId, setMetricId] = useState('')
  const [direction, setDirection] = useState('desc')
  const [reducer, setReducer] = useState('total')
  const [windowKind, setWindowKind] = useState('fixed')
  const [windowStart, setWindowStart] = useState('')
  const [windowEnd, setWindowEnd] = useState('')
  const [rollingDays, setRollingDays] = useState(90)
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
      const payload = { name, metric_id: metricId, direction, reducer, window_kind: windowKind }
      if (windowKind === 'rolling') {
        payload.rolling_days = Number(rollingDays)
      } else {
        payload.window_start = windowStart
        payload.window_end = windowEnd
      }
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
          <span className="text-xs text-gray-600 dark:text-gray-400">Metric</span>
          <select className={field} value={metricId} onChange={(e) => setMetricId(e.target.value)} required>
            {metrics.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </label>
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
              <input type="date" className={field} value={windowStart} onChange={(e) => setWindowStart(e.target.value)} required />
            </label>
            <label className="block">
              <span className="text-xs text-gray-600 dark:text-gray-400">End date</span>
              <input type="date" className={field} value={windowEnd} onChange={(e) => setWindowEnd(e.target.value)} required />
            </label>
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
      {err && <div className="text-xs text-red-500">{err}</div>}
      <button type="submit" disabled={busy}
        className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium disabled:opacity-50">
        {busy ? 'Creating…' : 'Create competition'}
      </button>
    </form>
  )
}
