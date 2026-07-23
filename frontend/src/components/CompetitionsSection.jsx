// Competitions (#183): a section on the Members page. Everyone sees the list
// and a selected competition's live leaderboard; leadership gets a create form.
// API-only feature (needs the faction API + daily-stats snapshots), so the
// caller gates rendering on API_MODE.
import { useState, useEffect } from 'react'
import { apiGet, apiPost } from '../utils/apiClient'
import { Trophy, Plus, X } from 'lucide-react'

function fmtDate(d) {
  if (!d) return ''
  return String(d).slice(0, 10)
}

export default function CompetitionsSection({ isLeadership }) {
  const [competitions, setCompetitions] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState(null)
  const [detail, setDetail] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
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

  async function openCompetition(id) {
    if (selectedId === id) { setSelectedId(null); setDetail(null); return }
    setSelectedId(id); setDetailLoading(true); setDetail(null)
    try {
      setDetail(await apiGet(`/api/competitions/${id}`))
    } catch {
      setDetail(null)
    } finally {
      setDetailLoading(false)
    }
  }

  if (!loading && competitions.length === 0 && !isLeadership) return null

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
                    {c.metric_id} · {fmtDate(c.window_start)} → {fmtDate(c.window_end)}
                  </div>
                </div>
                <span className="text-xs text-gray-400">{selectedId === c.id ? '▲' : '▼'}</span>
              </button>
              {selectedId === c.id && (
                <div className="border-t border-gray-100 dark:border-slate-700 p-2">
                  {detailLoading ? (
                    <div className="text-xs text-gray-500 py-2 px-1">Loading standings…</div>
                  ) : (
                    <Leaderboard standings={detail?.standings || []} />
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
  const [windowStart, setWindowStart] = useState('')
  const [windowEnd, setWindowEnd] = useState('')
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

  async function submit(e) {
    e.preventDefault()
    setErr(null); setBusy(true)
    try {
      await apiPost('/api/competitions', {
        name, metric_id: metricId, direction,
        window_start: windowStart, window_end: windowEnd,
      })
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
          <span className="text-xs text-gray-600 dark:text-gray-400">Start date</span>
          <input type="date" className={field} value={windowStart} onChange={(e) => setWindowStart(e.target.value)} required />
        </label>
        <label className="block">
          <span className="text-xs text-gray-600 dark:text-gray-400">End date</span>
          <input type="date" className={field} value={windowEnd} onChange={(e) => setWindowEnd(e.target.value)} required />
        </label>
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
