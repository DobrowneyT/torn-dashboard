import { useState } from 'react'

/**
 * The four numbers that decide what a chain watch pays (#773 follow-up).
 *
 * ⚠️ **Every figure on the sheet is DERIVED from these**, never stamped onto a
 * sign-up when it was claimed — that is the whole design of `chainPayout.js`.
 * So changing a value here corrects hours already served, which is the point:
 * the spreadsheet this replaced froze its bonus into a column position and paid
 * 59 slots where 31 were marked.
 *
 * ⚠️ **Leadership only**, enforced on the server. `PATCH /api/chain-events/:id`
 * is already `LEAD`-gated and validates every field below; this form adds no
 * new authority and must not look like it does.
 */

/** `[5, 6]` ⇄ `"5, 6"`. */
const parseHours = (text) =>
  String(text ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)
    .map(Number)

export default function PayoutSettings({ event, onSave, onClose }) {
  const [perSlot, setPerSlot] = useState(String(event?.payout_per_slot ?? ''))
  const [hours, setHours] = useState((event?.bonus_hours ?? []).join(', '))
  const [mult, setMult] = useState(String(event?.bonus_multiplier ?? 2))
  const [applies, setApplies] = useState(event?.bonus_applies_to ?? 'tickets')
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)

  const hourList = parseHours(hours)

  /**
   * ⚠️ Validated here AND on the server, deliberately. The server is the
   * boundary; this is so a leader finds out before they press save rather than
   * reading a 400 — and the two must agree, which is why the bounds are
   * copied from the route verbatim: hours 0..23, integers.
   */
  const problem =
    !(Number(perSlot) >= 0) ? 'Payout per slot must be a number, zero or more.'
      : !(Number(mult) >= 1) ? 'The bonus multiplier must be at least 1 — below that a bonus hour would pay LESS.'
        : hourList.some((h) => !Number.isInteger(h) || h < 0 || h > 23)
          ? 'Bonus hours are TCT hours, 0 to 23, comma separated.'
          : null

  async function save() {
    if (problem) { setError(problem); return }
    setSaving(true)
    setError(null)
    try {
      await onSave({
        payout_per_slot: Number(perSlot),
        bonus_hours: hourList,
        bonus_multiplier: Number(mult),
        bonus_applies_to: applies,
      })
      onClose?.()
    } catch (e) {
      // ⚠️ Shown, not swallowed. A save that silently failed leaves the sheet
      // showing numbers nobody agreed to.
      setError(e?.message || 'Could not save — the sheet is unchanged.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="card space-y-3" data-testid="payout-settings-form">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="font-medium">Payout per slot</span>
          <input
            type="number" min="0" step="1" value={perSlot} data-testid="per-slot"
            onChange={(e) => setPerSlot(e.target.value)}
            className="w-full rounded border border-gray-300 px-2 py-1 dark:border-slate-600 dark:bg-slate-800"
          />
          <span className="block text-xs text-gray-500 dark:text-gray-400">
            Every row recalculates — including hours already served.
          </span>
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">Bonus hours (TCT)</span>
          <input
            type="text" value={hours} placeholder="5, 6" data-testid="bonus-hours"
            onChange={(e) => setHours(e.target.value)}
            className="w-full rounded border border-gray-300 px-2 py-1 dark:border-slate-600 dark:bg-slate-800"
          />
          <span className="block text-xs text-gray-500 dark:text-gray-400">
            {hourList.length === 0 ? 'No bonus hours.' : `${hourList.length} hour${hourList.length === 1 ? '' : 's'} pay the multiplier.`}
          </span>
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">Bonus multiplier</span>
          <input
            type="number" min="1" step="0.5" value={mult} data-testid="bonus-multiplier"
            onChange={(e) => setMult(e.target.value)}
            className="w-full rounded border border-gray-300 px-2 py-1 dark:border-slate-600 dark:bg-slate-800"
          />
        </label>

        <label className="space-y-1 text-sm">
          <span className="font-medium">Bonus applies to</span>
          <select
            value={applies} data-testid="bonus-applies-to"
            onChange={(e) => setApplies(e.target.value)}
            className="w-full rounded border border-gray-300 px-2 py-1 dark:border-slate-600 dark:bg-slate-800"
          >
            <option value="tickets">Raffle tickets</option>
            <option value="payout">Payout</option>
            <option value="both">Both</option>
          </select>
        </label>
      </div>

      {(error || problem) && (
        <p className="text-sm text-red-600 dark:text-red-400" data-testid="settings-error">
          {error || problem}
        </p>
      )}

      <div className="flex gap-2">
        <button type="button" className="btn-primary px-3 py-1.5 text-sm"
          disabled={saving || !!problem} onClick={save} data-testid="save-settings">
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn-secondary px-3 py-1.5 text-sm"
          disabled={saving} onClick={onClose}>Cancel</button>
      </div>
    </div>
  )
}
