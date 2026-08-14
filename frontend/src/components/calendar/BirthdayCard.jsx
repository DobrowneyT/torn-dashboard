/**
 * "Your birthday" — the self-service half of #395's birthday support.
 *
 * Torn holds no date of birth anywhere in its API, so this is the only way one
 * gets onto the calendar. That makes it personal data we chose to collect, and
 * the shape of this form is the mitigation:
 *
 *   • **Day and month only** by default. That is all a faction uses. The year
 *     is a separate, clearly optional field, because someone's age is a
 *     different disclosure from "say happy birthday on the 14th".
 *   • **Remove** actually deletes the row. Withdrawal that only hides is not
 *     withdrawal.
 *   • Nobody is asked. The card sits on the calendar; leaving it alone is a
 *     complete and unremarkable choice.
 */
import { useEffect, useState } from 'react'
import { Cake } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { apiPut, apiDelete } from '../../utils/apiClient'

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

/** Days that exist in a month — 29 February is a real birthday and stays. */
export function daysInMonth(month) {
  return new Date(Date.UTC(2024, Number(month), 0)).getUTCDate() // 2024 is a leap year
}

export default function BirthdayCard({ mine, onChanged }) {
  const { user } = useAuth()
  const [month, setMonth] = useState('')
  const [day, setDay] = useState('')
  const [year, setYear] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    setMonth(mine ? String(mine.birth_month) : '')
    setDay(mine ? String(mine.birth_day) : '')
    setYear(mine?.birth_year ? String(mine.birth_year) : '')
  }, [mine])

  if (!user?.id) return null

  async function save(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await apiPut(`/api/calendar/birthdays/${user.id}`, {
        birth_month: Number(month),
        birth_day: Number(day),
        birth_year: year === '' ? null : Number(year),
      })
      setOpen(false)
      onChanged?.()
    } catch (err) {
      setError(err?.message || 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    setBusy(true)
    setError(null)
    try {
      await apiDelete(`/api/calendar/birthdays/${user.id}`)
      setOpen(false)
      onChanged?.()
    } catch (err) {
      setError(err?.message || 'Could not remove')
    } finally {
      setBusy(false)
    }
  }

  const summary = mine
    ? `${MONTHS[mine.birth_month - 1]} ${mine.birth_day}${mine.birth_year ? `, ${mine.birth_year}` : ''}`
    : null

  return (
    <div className="card">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Cake className="w-4 h-4 text-pink-500 shrink-0" />
          <span className="text-sm truncate">
            {summary
              ? <>Your birthday is on the calendar: <strong>{summary}</strong></>
              : <span className="text-gray-500 dark:text-gray-400">Add your birthday to the faction calendar — entirely optional.</span>}
          </span>
        </div>
        <button
          onClick={() => setOpen((o) => !o)}
          className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-slate-600 hover:bg-gray-100 dark:hover:bg-slate-700 shrink-0"
        >
          {open ? 'Close' : summary ? 'Change' : 'Add'}
        </button>
      </div>

      {open && (
        <form onSubmit={save} className="mt-3 flex flex-wrap items-end gap-2">
          <label className="text-sm">
            <span className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Month</span>
            <select value={month} onChange={(e) => setMonth(e.target.value)} required className="input py-1">
              <option value="">—</option>
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
          </label>

          <label className="text-sm">
            <span className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Day</span>
            <select value={day} onChange={(e) => setDay(e.target.value)} required disabled={!month} className="input py-1">
              <option value="">—</option>
              {Array.from({ length: month ? daysInMonth(month) : 0 }, (_, i) => (
                <option key={i + 1} value={i + 1}>{i + 1}</option>
              ))}
            </select>
          </label>

          <label className="text-sm">
            <span className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Year (optional)</span>
            <input
              type="number" min="1900" max="2100" placeholder="leave blank"
              value={year} onChange={(e) => setYear(e.target.value)} className="input py-1 w-32"
            />
          </label>

          <button type="submit" disabled={busy} className="btn-primary text-sm px-3 py-1.5 disabled:opacity-50">Save</button>
          {mine && (
            <button type="button" onClick={remove} disabled={busy} className="text-sm px-3 py-1.5 rounded border border-red-300 text-red-600 dark:border-red-800 hover:bg-red-50 dark:hover:bg-red-900/20">
              Remove
            </button>
          )}

          <p className="w-full text-xs text-gray-500 dark:text-gray-400">
            Day and month are all the calendar needs. The year is optional and only used to show
            which birthday it is — remove wipes the whole entry.
          </p>
          {error && <div className="w-full text-sm text-red-600 dark:text-red-400">{error}</div>}
        </form>
      )}
    </div>
  )
}
