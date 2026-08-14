/**
 * Members → Calendar (#395).
 *
 * A month grid over everything the system already knows — ranked wars, war and
 * OC payouts, competitions — plus the two things it cannot know: Torn's own
 * events (no API exists) and real birthdays.
 *
 * Payouts are single-day markers on the day the money moves, and they carry a
 * deep link that opens the very same modal as clicking the row on the payouts
 * page. That link is the point: a date with no way through to the detail is
 * just a reminder that the detail exists somewhere else.
 *
 * ⚠️ Everything is in **TCT (= UTC)**, and the whole grid is built in UTC. A
 * faction spans timezones; rendering a war window in the reader's local time
 * means two people reading the same cell disagree about what day it is, and
 * Torn itself only ever speaks TCT.
 *
 * ⚠️ Only typed-in entries carry edit controls. An aggregated war is a VIEW
 * onto ranked_wars — a delete button there either silently does nothing or
 * deletes the war.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronLeft, ChevronRight, LoaderCircle, Plus, Pencil, Trash2, X, RefreshCw } from 'lucide-react'
import { apiGet, apiPost, apiPut, apiDelete } from '../../utils/apiClient'
import { aggregate, byDay, monthGrid, dayKey, EVENT_KINDS } from '../../utils/calendarSources'
import { useAuth } from '../../contexts/AuthContext'
import BirthdayCard from './BirthdayCard'

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

/** Tailwind cannot see interpolated class names, so tones are spelled out. */
const TONE = {
  red: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  purple: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300',
  green: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  amber: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  blue: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  slate: 'bg-slate-200 text-slate-800 dark:bg-slate-700 dark:text-slate-200',
  pink: 'bg-pink-100 text-pink-800 dark:bg-pink-900/40 dark:text-pink-300',
}

const monthStart = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)) // db-time-safe
const fmtTime = (d) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`

export default function CalendarSection({ isLeadership }) {
  const { user, isVisitor } = useAuth()
  // ⚠️ The `isLeadership` prop is `effectiveIsLeadership`, which deliberately
  // includes visitors so they can SEE leadership surfaces read-only (App.jsx).
  // Writing is a different question: the server refuses a visitor on every one
  // of these routes, so offering the buttons only produces a 403 they cannot
  // act on. Adding entries is leadership/admin, and never a visitor.
  const canEdit = isLeadership && !isVisitor
  const [month, setMonth] = useState(() => monthStart(new Date())) // db-time-safe
  const [payload, setPayload] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [hidden, setHidden] = useState(() => new Set())
  const [selectedDay, setSelectedDay] = useState(null)
  const [editing, setEditing] = useState(null)

  // The grid runs from the Monday before the 1st to the Sunday after the last,
  // so the fetch window has to cover the overflow cells too — otherwise the
  // leading and trailing days are always blank.
  const window = useMemo(() => {
    const cells = monthGrid(month)
    return { from: cells[0].date, to: new Date(cells[41].date.getTime() + 86_399_000) } // db-time-safe
  }, [month])

  const load = useCallback(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    apiGet(`/api/calendar?from=${window.from.toISOString()}&to=${window.to.toISOString()}`)
      .then((res) => { if (!cancelled) setPayload(res) })
      .catch((e) => { if (!cancelled) setError(e?.message || 'Could not load the calendar') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [window.from, window.to])

  useEffect(() => load(), [load])

  const events = useMemo(() => aggregate(payload, window), [payload, window])
  const visible = useMemo(() => events.filter((e) => !hidden.has(e.kind)), [events, hidden])
  const cells = useMemo(() => monthGrid(month), [month])
  const index = useMemo(() => byDay(visible), [visible])
  const todayKey = dayKey(new Date()) // db-time-safe

  const toggleKind = (kind) => setHidden((prev) => {
    const next = new Set(prev)
    next.has(kind) ? next.delete(kind) : next.add(kind)
    return next
  })

  const shift = (delta) => setMonth((m) => new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + delta, 1))) // db-time-safe

  async function saveEvent(form) {
    const body = {
      source: form.source,
      title: form.title,
      note: form.note || null,
      starts_at: form.startsAt,
      ends_at: form.endsAt || null,
      recurrence: form.recurrence,
    }
    if (form.id) await apiPut(`/api/calendar/events/${form.id}`, body)
    else await apiPost('/api/calendar/events', body)
    setEditing(null)
    load()
  }

  async function removeEvent(id) {
    await apiDelete(`/api/calendar/events/${id}`)
    setEditing(null)
    setSelectedDay(null)
    load()
  }

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <button onClick={() => shift(-1)} className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-slate-700" aria-label="Previous month">
              <ChevronLeft className="w-5 h-5" />
            </button>
            <h2 className="text-lg font-semibold w-48 text-center">
              {MONTHS[month.getUTCMonth()]} {month.getUTCFullYear()}
            </h2>
            <button onClick={() => shift(1)} className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-slate-700" aria-label="Next month">
              <ChevronRight className="w-5 h-5" />
            </button>
            <button onClick={() => setMonth(monthStart(new Date()))} className="ml-1 text-xs px-2 py-1 rounded border border-gray-300 dark:border-slate-600 hover:bg-gray-100 dark:hover:bg-slate-700">
              Today
            </button>
            {loading && <LoaderCircle className="w-4 h-4 animate-spin text-gray-400" />}
          </div>

          <div className="flex items-center gap-2">
            <button onClick={load} className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-slate-700" title="Refresh" aria-label="Refresh">
              <RefreshCw className="w-4 h-4" />
            </button>
            {canEdit && (
              <button
                onClick={() => setEditing({ source: 'manual', recurrence: 'none' })}
                className="btn-primary text-sm px-3 py-1.5 flex items-center gap-1.5"
              >
                <Plus className="w-4 h-4" /> Add event
              </button>
            )}
          </div>
        </div>

        {/* Legend doubles as the filter. Kinds are coarser than sources on
            purpose — a reader wants "war stuff", not eight legend entries. */}
        <div className="flex flex-wrap gap-1.5 mt-3">
          {Object.entries(EVENT_KINDS).map(([kind, { label, tone }]) => (
            <button
              key={kind}
              onClick={() => toggleKind(kind)}
              className={`text-[11px] px-2 py-0.5 rounded-full transition-opacity ${TONE[tone]} ${hidden.has(kind) ? 'opacity-30' : ''}`}
            >
              {label}
            </button>
          ))}
          <span className="text-[11px] text-gray-400 self-center ml-1">all times TCT</span>
        </div>

        {error && <div className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</div>}
      </div>

      <div className="card overflow-x-auto">
        <div className="min-w-[42rem]">
          <div className="grid grid-cols-7 border-b border-gray-200 dark:border-slate-700">
            {DOW.map((d) => (
              <div key={d} className="py-1.5 text-center text-xs font-semibold text-gray-500 dark:text-gray-400">{d}</div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {cells.map((cell) => {
              const dayEvents = index.get(cell.key) ?? []
              return (
                <button
                  key={cell.key}
                  onClick={() => dayEvents.length > 0 && setSelectedDay(cell.key)}
                  className={`min-h-[5.5rem] p-1 text-left align-top border-b border-r border-gray-100 dark:border-slate-700/60 ${
                    cell.inMonth ? '' : 'bg-gray-50/60 dark:bg-slate-800/40'
                  } ${dayEvents.length > 0 ? 'hover:bg-gray-100 dark:hover:bg-slate-700/40 cursor-pointer' : 'cursor-default'}`}
                >
                  <div className={`text-xs mb-0.5 ${
                    cell.key === todayKey
                      ? 'inline-flex items-center justify-center w-5 h-5 rounded-full bg-blue-600 text-white font-semibold'
                      : cell.inMonth ? 'text-gray-600 dark:text-gray-300' : 'text-gray-400 dark:text-gray-600'
                  }`}>
                    {cell.date.getUTCDate()}
                  </div>
                  <div className="space-y-0.5">
                    {dayEvents.slice(0, 3).map((e) => (
                      <div
                        key={e.id}
                        className={`truncate text-[10px] leading-tight px-1 py-0.5 rounded ${TONE[EVENT_KINDS[e.kind]?.tone ?? 'slate']}`}
                        title={e.title}
                      >
                        {e.title}
                      </div>
                    ))}
                    {dayEvents.length > 3 && (
                      <div className="text-[10px] text-gray-500 dark:text-gray-400 px-1">+{dayEvents.length - 3} more</div>
                    )}
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {selectedDay && (
        <DayPanel
          dayKey={selectedDay}
          events={index.get(selectedDay) ?? []}
          canEdit={canEdit}
          onClose={() => setSelectedDay(null)}
          onEdit={(e) => setEditing({
            id: e.eventId,
            source: e.source,
            title: e.title,
            note: e.note ?? '',
            // A recurring occurrence edits its underlying row, so the form
            // shows the occurrence's own date rather than the original year.
            startsAt: toLocalInput(e.startsAt),
            endsAt: e.endsAt ? toLocalInput(e.endsAt) : '',
            recurrence: e.recurring ? 'yearly' : 'none',
          })}
          onDelete={removeEvent}
        />
      )}

      {editing && <EventForm initial={editing} onCancel={() => setEditing(null)} onSave={saveEvent} />}

      <BirthdayCard
        mine={(payload?.birthdays ?? []).find((b) => String(b.member_id) === String(user?.id)) ?? null}
        onChanged={load}
      />
    </div>
  )
}

/** A UTC Date → the value a datetime-local input wants, kept in TCT. */
function toLocalInput(d) {
  return d.toISOString().slice(0, 16)
}

function DayPanel({ dayKey: key, events, canEdit, onClose, onEdit, onDelete }) {
  return (
    <div className="card">
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-semibold">{key} <span className="text-xs font-normal text-gray-500">TCT</span></h3>
        <button onClick={onClose} className="p-1 rounded hover:bg-gray-100 dark:hover:bg-slate-700" aria-label="Close">
          <X className="w-4 h-4" />
        </button>
      </div>
      <ul className="divide-y divide-gray-100 dark:divide-slate-700/60">
        {events.map((e) => (
          <li key={e.id} className="py-2 flex items-start gap-2">
            <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 mt-0.5 ${TONE[EVENT_KINDS[e.kind]?.tone ?? 'slate']}`}>
              {EVENT_KINDS[e.kind]?.label ?? e.kind}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">
                {e.href ? <Link to={e.href} className="hover:underline">{e.title}</Link> : e.title}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                {e.allDay ? 'All day' : `${fmtTime(e.startsAt)} TCT`}
                {e.endsAt && ` → ${e.endsAt.toISOString().slice(0, 10)}${e.allDay ? '' : ` ${fmtTime(e.endsAt)}`}`}
                {/* An open war has not ended; saying nothing would read as
                    a one-day event. */}
                {!e.endsAt && e.open && ' → ongoing'}
                {e.recurring && ' · every year'}
              </div>
              {e.note && <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{e.note}</div>}
            </div>
            {/* ⚠️ Only typed-in entries. Nothing derived gets a delete button. */}
            {canEdit && e.editable && (
              <div className="flex gap-1 shrink-0">
                <button onClick={() => onEdit(e)} className="p-1 rounded hover:bg-gray-100 dark:hover:bg-slate-700" aria-label="Edit">
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => onDelete(e.eventId)} className="p-1 rounded hover:bg-red-50 dark:hover:bg-red-900/30 text-red-600" aria-label="Delete">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

function EventForm({ initial, onCancel, onSave }) {
  const [form, setForm] = useState({
    id: initial.id ?? null,
    source: initial.source ?? 'manual',
    title: initial.title ?? '',
    note: initial.note ?? '',
    startsAt: initial.startsAt ?? '',
    endsAt: initial.endsAt ?? '',
    recurrence: initial.recurrence ?? 'none',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  async function submit(e) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      // The inputs are TCT; append Z so the server is not told local time.
      await onSave({ ...form, startsAt: `${form.startsAt}:00Z`, endsAt: form.endsAt ? `${form.endsAt}:00Z` : '' })
    } catch (err) {
      setError(err?.message || 'Could not save')
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="card space-y-3">
      <h3 className="font-semibold">{form.id ? 'Edit entry' : 'New entry'}</h3>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Type</span>
          <select value={form.source} onChange={set('source')} className="input w-full">
            <option value="manual">Faction event (roll call, chain night)</option>
            <option value="torn_event">Torn event (Christmas Town, competitions)</option>
          </select>
        </label>

        <label className="text-sm">
          <span className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Repeats</span>
          <select value={form.recurrence} onChange={set('recurrence')} className="input w-full">
            <option value="none">Once</option>
            <option value="yearly">Every year</option>
          </select>
        </label>

        <label className="text-sm sm:col-span-2">
          <span className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Title</span>
          <input value={form.title} onChange={set('title')} maxLength={120} required className="input w-full" />
        </label>

        <label className="text-sm">
          <span className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Starts (TCT)</span>
          <input type="datetime-local" value={form.startsAt} onChange={set('startsAt')} required className="input w-full" />
        </label>

        <label className="text-sm">
          <span className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Ends (TCT, optional)</span>
          <input type="datetime-local" value={form.endsAt} onChange={set('endsAt')} className="input w-full" />
        </label>

        <label className="text-sm sm:col-span-2">
          <span className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Note (optional)</span>
          <input value={form.note} onChange={set('note')} maxLength={1000} className="input w-full" />
        </label>
      </div>

      {form.recurrence === 'yearly' && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Repeats on the same date each year. Torn shifts its events by a few days, so check the
          date when the event comes round — but it will be on the calendar either way.
        </p>
      )}

      {error && <div className="text-sm text-red-600 dark:text-red-400">{error}</div>}

      <div className="flex gap-2">
        <button type="submit" disabled={saving} className="btn-primary text-sm px-3 py-1.5 disabled:opacity-50">
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={onCancel} className="text-sm px-3 py-1.5 rounded border border-gray-300 dark:border-slate-600">
          Cancel
        </button>
      </div>
    </form>
  )
}
