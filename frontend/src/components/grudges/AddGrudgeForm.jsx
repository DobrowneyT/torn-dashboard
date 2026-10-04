// Add a grudge (#889, slice 2).
//
// ⚠️ The reason is the feature. A target list where anyone can add anyone is a
// target list; requiring a stated grudge is what makes this the Book of
// Grudges. So the field is required here, in the route, and by a CHECK
// constraint — three layers, because it is the one rule worth over-enforcing.
import { useState } from 'react'
import { BookOpen, LoaderCircle } from 'lucide-react'
import { apiPost } from '../../utils/apiClient'
import { parseTargetId } from '../../utils/grudgeTarget'

export default function AddGrudgeForm({ severities = [], onAdded }) {
  const [target, setTarget] = useState('')
  const [reason, setReason] = useState('')
  const [severity, setSeverity] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(null)

  // Parsed as you type, so a bad link is visible before you write a paragraph
  // of reason and press the button.
  const parsedId = parseTargetId(target)
  const canSubmit = !busy && parsedId !== null && reason.trim() !== ''

  const submit = async (e) => {
    e.preventDefault()
    if (!canSubmit) return
    setBusy(true); setError(null); setDone(null)
    try {
      const res = await apiPost('/api/grudges', {
        target,
        reason,
        severity_id: severity || undefined,
      })
      setTarget(''); setReason(''); setSeverity('')
      // ⚠️ Says which of the two things happened. A target held for approval
      // that reported a flat "added" would look like it had gone live.
      setDone(
        res?.state === 'pending_approval'
          ? 'Added — held for leadership approval, because this target is in a watched faction.'
          : 'Added to the list.'
      )
      onAdded?.(res)
    } catch (err) {
      setError(err?.message || 'Could not add this grudge')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800">
      <h3 className="flex items-center gap-2 font-semibold text-gray-900 dark:text-gray-100">
        <BookOpen className="h-4 w-4" aria-hidden="true" /> Add a grudge
      </h3>

      <div>
        <label htmlFor="grudge-target" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          Target profile link or ID
        </label>
        <input
          id="grudge-target" value={target} onChange={(e) => setTarget(e.target.value)}
          placeholder="https://www.torn.com/profiles.php?XID=2576356"
          className="mt-1 w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-gray-100"
        />
        {/* Only complain once they have actually typed something. */}
        {target.trim() !== '' && parsedId === null && (
          <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
            That is not a Torn profile link or user ID.
          </p>
        )}
        {parsedId !== null && (
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Target ID {parsedId} — their name and faction are looked up automatically.
          </p>
        )}
      </div>

      <div>
        <label htmlFor="grudge-reason" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          What did they do? <span className="text-red-600 dark:text-red-400">*</span>
        </label>
        <textarea
          id="grudge-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3}
          placeholder="Mugged me mid-chain and then mailed me about it"
          className="mt-1 w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-gray-100"
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Required. Everyone in the faction can read this, and it is kept.
        </p>
      </div>

      {/* ⚠️ Rendered ONLY when the faction has configured severities. No
          hardcoded Low/Medium/High — an empty control is honest, three invented
          tiers are not. */}
      {severities.length > 0 && (
        <div>
          <label htmlFor="grudge-severity" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Severity
          </label>
          <select
            id="grudge-severity" value={severity} onChange={(e) => setSeverity(e.target.value)}
            className="mt-1 rounded border border-gray-300 bg-white px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-gray-100"
          >
            <option value="">—</option>
            {severities.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
        </div>
      )}

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {done && <p className="text-sm text-emerald-600 dark:text-emerald-400">{done}</p>}

      <button
        type="submit" disabled={!canSubmit}
        className="inline-flex items-center gap-2 rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />}
        Add to the book
      </button>
    </form>
  )
}
