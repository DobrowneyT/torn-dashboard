// Book of Grudges settings (#889, slice 6) — leadership only.
//
// ⚠️ Severities and watched factions were SQL-only until this existed, which
// made the approval gate unusable: it worked perfectly and nobody could tell
// it what to watch.
import { useEffect, useState } from 'react'
import { Plus, Settings2, Trash2, TriangleAlert } from 'lucide-react'
import { apiGet, apiPut } from '../../utils/apiClient'

export default function GrudgeSettings({ severities = [], watchedFactions = [], onSaved }) {
  const [rows, setRows] = useState(severities)
  const [factions, setFactions] = useState(watchedFactions.join(', '))
  const [usage, setUsage] = useState({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(null)

  useEffect(() => { setRows(severities) }, [severities])
  useEffect(() => { setFactions(watchedFactions.join(', ')) }, [watchedFactions])
  useEffect(() => {
    let on = true
    apiGet('/api/grudges/settings/usage')
      .then((r) => { if (on) setUsage(r?.usage ?? {}) })
      .catch(() => { if (on) setUsage({}) })
    return () => { on = false }
  }, [])

  // ⚠️ Which removals will clear a grudge's severity, counted BEFORE saving.
  // Finding out afterwards is how somebody silently wipes a field across the
  // whole board.
  const removedInUse = severities
    .filter((s) => !rows.some((r) => r.id === s.id))
    .map((s) => ({ ...s, n: usage[s.id] ?? 0 }))
    .filter((s) => s.n > 0)

  const save = async () => {
    setBusy(true); setError(null); setDone(null)
    try {
      const res = await apiPut('/api/grudges/settings', {
        severities: rows.map((r) => ({ id: r.id, label: r.label })),
        // Split on anything that is not a digit, so "10739, 8103" and
        // "10739 8103" both work — people will paste either.
        watched_factions: factions.split(/[^0-9]+/).filter(Boolean),
      })
      setDone(
        res.grudges_cleared > 0
          ? `Saved. ${res.grudges_cleared} ${res.grudges_cleared === 1 ? 'grudge' : 'grudges'} had a removed severity cleared.`
          : 'Saved.'
      )
      onSaved?.(res)
    } catch (e) {
      setError(e?.message || 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800">
      <h3 className="flex items-center gap-2 font-semibold text-gray-900 dark:text-gray-100">
        <Settings2 className="h-4 w-4" aria-hidden="true" /> Book settings
      </h3>

      <div>
        <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">Severities</h4>
        <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
          Your faction&rsquo;s own words for how badly somebody wronged you. Leave it empty
          and the severity control simply does not appear.
        </p>
        <ul className="space-y-2">
          {rows.map((r, i) => (
            <li key={r.id ?? `new-${i}`} className="flex items-center gap-2">
              <input
                value={r.label}
                aria-label={`Severity ${i + 1}`}
                onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                className="flex-1 rounded border border-gray-300 px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-gray-100"
              />
              {usage[r.id] > 0 && (
                <span className="text-xs text-gray-500 dark:text-gray-400">{usage[r.id]} in use</span>
              )}
              <button
                type="button" aria-label={`Remove ${r.label || 'severity'}`}
                onClick={() => setRows(rows.filter((_, j) => j !== i))}
              >
                <Trash2 className="h-4 w-4 text-gray-400 hover:text-red-600" />
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={() => setRows([...rows, { label: '' }])}
          className="mt-2 inline-flex items-center gap-1 text-sm text-blue-600 hover:underline dark:text-blue-400"
        >
          <Plus className="h-3.5 w-3.5" /> Add a severity
        </button>
        {/* ⚠️ Renaming is safe and the UI should say so, because it looks like
            it might not be: the id is kept, so every grudge keeps its severity. */}
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          Renaming one is safe &mdash; grudges keep their severity. Removing one clears it
          from any grudge using it.
        </p>
      </div>

      <div>
        <label htmlFor="grudge-watched" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          Watched factions
        </label>
        <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
          Faction IDs. A target in any of these is held for your approval instead of
          going straight onto the list &mdash; your own faction, the family, allies.
        </p>
        <input
          id="grudge-watched" value={factions} onChange={(e) => setFactions(e.target.value)}
          placeholder="10739, 8103"
          className="w-full rounded border border-gray-300 px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-gray-100"
        />
      </div>

      {removedInUse.length > 0 && (
        <div className="flex items-start gap-2 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            Saving will clear the severity from{' '}
            {removedInUse.map((s) => `${s.n} using "${s.label}"`).join(', ')}. The old value
            stays in the history.
          </span>
        </div>
      )}

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {done && <p className="text-sm text-emerald-600 dark:text-emerald-400">{done}</p>}

      <button
        type="button" onClick={save} disabled={busy}
        className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {busy ? 'Saving…' : 'Save settings'}
      </button>
    </div>
  )
}
