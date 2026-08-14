/**
 * Dashboard "Upcoming" card (#395).
 *
 * ⚠️ Renders **nothing** when there is nothing on. Not an empty state, not a
 * "no events this week" placeholder — nothing. An empty card sitting on the
 * dashboard every day is how people learn to stop reading that part of the
 * screen, and then it fails on the one day it has something to say.
 *
 * Same reasoning for failure: if the fetch dies, the card disappears rather
 * than parking an error on everyone's dashboard. The Calendar tab is where you
 * go to find out why.
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { CalendarDays } from 'lucide-react'
import { apiGet } from '../utils/apiClient'
import { aggregate, upcoming, EVENT_KINDS } from '../utils/calendarSources'

const HORIZON_DAYS = 7
const DAY_MS = 86_400_000

const TONE = {
  red: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  purple: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300',
  green: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  amber: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  blue: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  slate: 'bg-slate-200 text-slate-800 dark:bg-slate-700 dark:text-slate-200',
  pink: 'bg-pink-100 text-pink-800 dark:bg-pink-900/40 dark:text-pink-300',
}

/** "Today", "Tomorrow", then the weekday — all in TCT, like the rest of Torn. */
export function whenLabel(event, now = new Date()) {
  const start = event.startsAt
  if (event.startsAt <= now && (event.endsAt ? event.endsAt >= now : event.open)) return 'Now'

  const dayDelta = Math.floor(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()) / DAY_MS)
    - Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / DAY_MS)

  const day = dayDelta === 0 ? 'Today'
    : dayDelta === 1 ? 'Tomorrow'
    : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][start.getUTCDay()]

  if (event.allDay) return day
  const hh = String(start.getUTCHours()).padStart(2, '0')
  const mm = String(start.getUTCMinutes()).padStart(2, '0')
  return `${day} ${hh}:${mm} TCT`
}

export default function UpcomingEvents() {
  const [events, setEvents] = useState([])

  useEffect(() => {
    let cancelled = false
    const now = new Date() // db-time-safe
    const to = new Date(now.getTime() + HORIZON_DAYS * DAY_MS) // db-time-safe
    apiGet(`/api/calendar?from=${now.toISOString()}&to=${to.toISOString()}`)
      .then((payload) => {
        if (cancelled) return
        setEvents(upcoming(aggregate(payload, { from: now, to }), { now, days: HORIZON_DAYS, limit: 5 }))
      })
      // Silent: the card's absence is the failure mode, by design.
      .catch(() => { if (!cancelled) setEvents([]) })
    return () => { cancelled = true }
  }, [])

  if (events.length === 0) return null

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-semibold flex items-center gap-1.5">
          <CalendarDays className="w-4 h-4 text-gray-400" /> Upcoming
        </h3>
        <Link to="/members/calendar" className="text-xs text-blue-600 dark:text-blue-400 hover:underline">
          Calendar
        </Link>
      </div>
      <ul className="divide-y divide-gray-100 dark:divide-slate-700/60">
        {events.map((e) => {
          const body = (
            <>
              <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${TONE[EVENT_KINDS[e.kind]?.tone ?? 'slate']}`}>
                {EVENT_KINDS[e.kind]?.label ?? e.kind}
              </span>
              <span className="text-sm truncate flex-1 min-w-0">{e.title}</span>
              <span className="text-xs text-gray-500 dark:text-gray-400 shrink-0">{whenLabel(e)}</span>
            </>
          )
          return (
            <li key={e.id} className="py-1.5">
              {e.href ? (
                <Link to={e.href} className="flex items-center gap-2 hover:opacity-80">{body}</Link>
              ) : (
                <div className="flex items-center gap-2">{body}</div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
