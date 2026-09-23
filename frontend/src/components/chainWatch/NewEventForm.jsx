import { useState } from 'react'
import { X } from 'lucide-react'

/**
 * Open a chain watch (#772 follow-up).
 *
 * ⚠️ Its own file, per the v3.97.0 crash — a panel declared inside the view it
 * serves and referenced from that view's callbacks is a temporal-dead-zone
 * throw that builds cleanly and dies on render.
 *
 * ⚠️ **Days, not an end date.** The event opens short and grows one TCT day per
 * click of *Add a day*, because nobody knows how long a 100k chain runs — it
 * depends on how many people are hitting. The 2025 sheet was generated for
 * 25 Oct 10:00 → 1 Nov 16:00 TCT and the chain outran it; sign-ups were
 * extended through 3 Nov by hand.
 *
 * ⚠️ **Everything is TCT**, which is UTC, because that is what Torn shows and
 * what leadership says out loud. The local time of the chosen start is echoed
 * back underneath so nobody opens a window twelve hours off by accident.
 */

/** The next whole TCT hour, as the value a datetime-local input wants. */
function nextHourTct() {
  const ms = Math.ceil(Date.now() / 3600_000) * 3600_000
  return new Date(ms).toISOString().slice(0, 16) // db-time-safe: epoch number.
}

export default function NewEventForm({ onCreate, onClose, busy }) {
  const [title, setTitle] = useState('Halloween 100k Chain')
  const [startsAt, setStartsAt] = useState(nextHourTct)
  const [days, setDays] = useState(3)
  const [slots, setSlots] = useState(2)
  const [bonus, setBonus] = useState('5,6')
  const [payout, setPayout] = useState(1_500_000)

  // db-time-safe: our own "YYYY-MM-DDTHH:mm" from the input, read as TCT (UTC).
  const startMs = Date.parse(`${startsAt}:00Z`)
  const valid = title.trim() && Number.isFinite(startMs) && days >= 1

  const submit = (e) => {
    e.preventDefault()
    if (!valid) return
    onCreate({
      title: title.trim(),
      starts_at: new Date(startMs).toISOString(), // db-time-safe: epoch number.
      days: Number(days),
      slots_per_hour: Number(slots),
      payout_per_slot: Number(payout),
      bonus_hours: bonus.split(',').map((h) => Number(h.trim()))
        .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23),
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-16"
      role="dialog" aria-modal="true" aria-label="Open a chain watch">
      <form onSubmit={submit} className="card w-full max-w-md space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Open a chain watch</h3>
          <button type="button" onClick={onClose} aria-label="Close"
            className="text-gray-400 hover:text-gray-600"><X className="h-4 w-4" /></button>
        </div>

        <label className="block text-sm">
          <span className="text-xs uppercase tracking-wide text-gray-400">Title</span>
          <input id="cw-title" className="input mt-1 w-full" value={title}
            onChange={(e) => setTitle(e.target.value)} />
        </label>

        <label className="block text-sm">
          <span className="text-xs uppercase tracking-wide text-gray-400">Starts (TCT)</span>
          <input id="cw-start" type="datetime-local" className="input mt-1 w-full" value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)} />
          <span className="mt-1 block text-[11px] text-gray-400" data-testid="start-echo">
            {Number.isFinite(startMs)
              // db-time-safe: epoch number, formatted in the viewer's zone.
              ? `${new Date(startMs).toLocaleString()} your time`
              : 'Pick a start time'}
          </span>
        </label>

        <div className="grid grid-cols-3 gap-2 text-sm">
          <label className="block">
            <span className="text-xs uppercase tracking-wide text-gray-400">Days</span>
            <input id="cw-days" type="number" min="1" max="60" className="input mt-1 w-full"
              value={days} onChange={(e) => setDays(e.target.value)} />
          </label>
          <label className="block">
            <span className="text-xs uppercase tracking-wide text-gray-400">Watchers/hr</span>
            <input id="cw-slots" type="number" min="1" max="6" className="input mt-1 w-full"
              value={slots} onChange={(e) => setSlots(e.target.value)} />
          </label>
          <label className="block">
            <span className="text-xs uppercase tracking-wide text-gray-400">Per slot</span>
            <input id="cw-payout" type="number" min="0" step="100000" className="input mt-1 w-full"
              value={payout} onChange={(e) => setPayout(e.target.value)} />
          </label>
        </div>

        <label className="block text-sm">
          <span className="text-xs uppercase tracking-wide text-gray-400">Bonus hours (TCT)</span>
          <input id="cw-bonus" className="input mt-1 w-full" value={bonus}
            onChange={(e) => setBonus(e.target.value)} placeholder="5,6" />
          {/* ⚠️ Hours of the day, never a position in a grid. The spreadsheet
              pinned its bonus to columns H:I — 05:00-07:00 TCT on one block and
              17:00-19:00 on the next — and paid 59 slots where 31 were marked. */}
          <span className="mt-1 block text-[11px] text-gray-400">
            Hours of the day that pay double. Changeable later.
          </span>
        </label>

        {/* ⚠️ Three days by default. The window grows a day at a time as the
            chain proves it has legs, rather than being guessed up front. */}
        <p className="text-[11px] text-gray-400">
          Starts short on purpose — use <strong>Add a day</strong> as the chain runs long.
        </p>

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-secondary text-sm">Cancel</button>
          <button type="submit" disabled={!valid || busy} className="btn-primary text-sm"
            data-testid="create-event">
            {busy ? 'Opening…' : 'Open sign-ups'}
          </button>
        </div>
      </form>
    </div>
  )
}
