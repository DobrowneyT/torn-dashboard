// Faction event page (#969) — the home of a time-boxed faction event such as
// Halloween. Becomes the landing page while the event is live (App.jsx).
//
// ⚠️ The route always exists, even with no event: Chain Watch lives here now,
// and sign-ups open BEFORE an event starts. Only the nav tab is conditional.
import { useEffect, useState } from 'react'
import { Routes, Route, Navigate, NavLink } from 'react-router-dom'
import ChainWatchSection from '../components/chainWatch/ChainWatchSection'
import { apiGet, apiPatch, apiPost } from '../utils/apiClient'
import { parseDbTime } from '../utils/time'
import { formatTct, halloweenDefaults, msToTctInput, tctInputToMs } from '../utils/factionEvent'

const PHASE_LABEL = { upcoming: 'Starts soon', live: 'Live', ended: 'Ended' }

function tabClass(color) {
  return ({ isActive }) =>
    `px-4 py-2 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
      isActive
        ? (color ? '' : 'border-blue-600 text-blue-600 dark:text-blue-400 dark:border-blue-400')
        : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300 dark:hover:border-slate-600'
    }`
}

export default function EventsPage({ event, isLeadership, onChanged }) {
  const color = event?.theme_color ?? null
  const tabs = [
    { to: '/events/report', label: 'Report' },
    { to: '/events/chain-watch', label: 'Chain Watch' },
    ...(isLeadership ? [{ to: '/events/settings', label: 'Settings' }] : []),
  ]
  const activeStyle = ({ isActive }) =>
    isActive && color ? { borderColor: color, color } : undefined

  return (
    <div className="space-y-6">
      <EventHeader event={event} />
      <div className="flex gap-1 overflow-x-auto border-b border-gray-200 dark:border-slate-700">
        {tabs.map((tab) => (
          <NavLink key={tab.to} to={tab.to} className={tabClass(color)} style={activeStyle}>{tab.label}</NavLink>
        ))}
      </div>
      <Routes>
        {/* With no event the report has nothing to say; Chain Watch still does. */}
        <Route index element={<Navigate to={event ? '/events/report' : '/events/chain-watch'} replace />} />
        <Route path="report" element={<ReportPlaceholder event={event} />} />
        <Route path="chain-watch" element={<ChainWatchSection isLeadership={isLeadership} />} />
        {isLeadership && (
          <Route path="settings" element={<EventSettings event={event} onChanged={onChanged} />} />
        )}
        <Route path="*" element={<Navigate to="/events" replace />} />
      </Routes>
    </div>
  )
}

function EventHeader({ event }) {
  if (!event) {
    return (
      <div className="card p-4">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Events</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">No event is scheduled. Chain Watch sign-ups stay open here.</p>
      </div>
    )
  }
  const c = event.theme_color
  return (
    <div className="card p-4" style={{ boxShadow: `inset 0 3px 0 ${c}` }}>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-semibold" style={{ color: c }}>{event.name}</h2>
        <span
          className="text-xs font-semibold uppercase tracking-wide px-2 py-0.5 rounded"
          style={event.phase === 'live' ? { backgroundColor: c, color: '#fff' } : { color: c, boxShadow: `inset 0 0 0 1px ${c}` }}
        >
          {PHASE_LABEL[event.phase] ?? event.phase}
        </span>
      </div>
      <p className="text-sm text-gray-600 dark:text-gray-300 mt-2">
        Opens {formatTct(event.starts_at)} · daily figures from {formatTct(event.daily_from)} ·
        runs at least to {formatTct(event.min_ends_at)}
        {event.ends_with_chain ? ', then until the chain ends' : ''}
      </p>
    </div>
  )
}

function ReportPlaceholder({ event }) {
  return (
    <div className="card p-6 text-sm text-gray-600 dark:text-gray-300">
      {event
        ? 'The live chain report arrives here once the event chain is running.'
        : 'No event is scheduled.'}
    </div>
  )
}

const FIELD = 'w-full rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-gray-900 dark:text-white'
const LABEL = 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1'

function toForm(e) {
  return {
    name: e.name,
    theme_color: e.theme_color,
    starts_at: msToTctInput(e.starts_at),
    daily_from: msToTctInput(e.daily_from),
    min_ends_at: msToTctInput(e.min_ends_at),
    ends_with_chain: e.ends_with_chain,
    chain_event_id: e.chain_event_id == null ? '' : String(e.chain_event_id),
  }
}

/**
 * Leadership: schedule the event, or edit the one scheduled.
 *
 * ⚠️ Every time here is TCT. The inputs carry no timezone and are read as
 * UTC (factionEvent.js) — read as local time they would put the start hours
 * off for everyone outside UTC.
 */
export function EventSettings({ event, onChanged }) {
  const [form, setForm] = useState(() => toForm(event ?? halloweenDefaults()))
  const [chains, setChains] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)

  // Re-seed when the event behind the form changes (created, or another
  // leader edited it and the poll picked it up).
  useEffect(() => { setForm(toForm(event ?? halloweenDefaults())) }, [event?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    apiGet('/api/chain-events').then((r) => setChains(r.events ?? [])).catch(() => setChains([]))
  }, [])

  const set = (k) => (e) => {
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value
    setForm((f) => ({ ...f, [k]: v }))
  }

  async function save(extra = {}) {
    setBusy(true); setError(null); setNotice(null)
    try {
      const body = {
        name: form.name.trim(),
        theme_color: form.theme_color,
        starts_at: tctInputToMs(form.starts_at),
        daily_from: tctInputToMs(form.daily_from),
        min_ends_at: tctInputToMs(form.min_ends_at),
        ends_with_chain: form.ends_with_chain,
        chain_event_id: form.chain_event_id === '' ? null : Number(form.chain_event_id),
        ...extra,
      }
      for (const k of ['starts_at', 'daily_from', 'min_ends_at']) {
        if (body[k] == null) throw new Error('Every time needs a date and an hour.')
      }
      if (event) await apiPatch(`/api/events/${event.id}`, body)
      else await apiPost('/api/events', body)
      setNotice(extra.ended_at ? 'Event ended.' : event ? 'Saved.' : 'Event scheduled.')
      await onChanged?.()
    } catch (err) {
      setError(err.message || 'Could not save the event.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="card p-6 space-y-4 max-w-2xl"
      onSubmit={(e) => { e.preventDefault(); save() }}
    >
      <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
        {event ? `Edit ${event.name}` : 'Schedule an event'}
      </h3>
      <p className="text-sm text-gray-500 dark:text-gray-400">All times are TCT.</p>

      <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
        <label>
          <span className={LABEL}>Name</span>
          <input className={FIELD} value={form.name} maxLength={60} required onChange={set('name')} />
        </label>
        <label>
          <span className={LABEL}>Colour</span>
          <input type="color" className="h-10 w-16 rounded border border-gray-300 dark:border-slate-600" value={form.theme_color} onChange={set('theme_color')} />
        </label>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <label>
          <span className={LABEL}>Opens</span>
          <input type="datetime-local" className={FIELD} value={form.starts_at} required onChange={set('starts_at')} />
        </label>
        <label>
          <span className={LABEL}>Daily figures from</span>
          <input type="datetime-local" className={FIELD} value={form.daily_from} required onChange={set('daily_from')} />
        </label>
        <label>
          <span className={LABEL}>Runs at least until</span>
          <input type="datetime-local" className={FIELD} value={form.min_ends_at} required onChange={set('min_ends_at')} />
        </label>
      </div>

      <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
        <input type="checkbox" checked={form.ends_with_chain} onChange={set('ends_with_chain')} />
        Keep going after that until our chain ends (dies or reaches 100k)
      </label>

      <label className="block">
        <span className={LABEL}>Chain Watch event</span>
        <select className={FIELD} value={form.chain_event_id} onChange={set('chain_event_id')}>
          <option value="">None</option>
          {chains.map((c) => (
            <option key={c.id} value={String(c.id)}>
              {c.title} — {formatTct(parseDbTime(c.starts_at)?.getTime() ?? null)}
            </option>
          ))}
        </select>
      </label>

      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {notice && <p className="text-sm text-green-700 dark:text-green-400">{notice}</p>}

      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy} className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium disabled:opacity-50">
          {event ? 'Save' : 'Schedule event'}
        </button>
        {event?.phase === 'live' && (
          <button
            type="button"
            disabled={busy}
            onClick={() => { if (window.confirm(`End ${event.name} now? Members stop landing on it.`)) save({ ended_at: 'now' }) }}
            className="px-4 py-2 rounded-lg border border-red-500 text-red-600 dark:text-red-400 text-sm font-medium disabled:opacity-50"
          >
            End now
          </button>
        )}
      </div>
    </form>
  )
}
