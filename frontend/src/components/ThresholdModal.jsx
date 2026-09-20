import { useEffect, useMemo, useState } from 'react'
import { STAT_PATHS_BY_CATEGORY } from '../utils/statPaths'
import InfoTooltip from './InfoTooltip'

// Modal for editing a named threshold set. A threshold set is a map of
// statKey → minimum daily value. When a set is active in MemberOverview,
// rows whose daily average for that stat falls below the minimum get a red
// row highlight (and the cell itself flagged).
//
// Props:
//   - open               boolean
//   - onClose            () => void
//   - initialName        string
//   - initialThresholds  { statKey: number }
//   - canSaveAsNew       boolean
//   - canUpdate          boolean
//   - canDelete          boolean
//   - onSaveNew          (name, thresholds) => Promise<void>
//   - onUpdate           (name, thresholds) => Promise<void>
//   - onDelete           () => Promise<void>

export default function ThresholdModal({
  open,
  onClose,
  initialName,
  initialThresholds,
  canSaveAsNew = true,
  canUpdate = false,
  canDelete = false,
  onSaveNew,
  onUpdate,
  onDelete,
}) {
  const [name, setName]             = useState(initialName ?? '')
  const [thresholds, setThresholds] = useState(initialThresholds ?? {})
  const [busy, setBusy]             = useState(false)
  const [error, setError]           = useState(null)
  const [search, setSearch]         = useState('')

  useEffect(() => {
    if (!open) return
    setName(initialName ?? '')
    setThresholds({ ...(initialThresholds ?? {}) })
    setError(null)
    setSearch('')
  }, [open, initialName, initialThresholds])

  const filteredCategories = useMemo(() => {
    // Hide stats marked noPerDay — daily-min thresholds don't make sense for ELO etc.
    const statCats = STAT_PATHS_BY_CATEGORY.map(cat => ({
      ...cat,
      stats: cat.stats.filter(s => !s.noPerDay),
    })).filter(cat => cat.stats.length > 0)
    // Membership tenure (#287): a point-in-time minimum, not a daily rate.
    const eligible = [
      { id: 'membership', label: 'Membership', stats: [{ key: 'days_in_faction', label: 'Min Days in Faction', placeholder: 'min days' }] },
      ...statCats,
    ]
    const needle = search.trim().toLowerCase()
    if (!needle) return eligible
    return eligible
      .map(cat => ({
        ...cat,
        stats: cat.stats.filter(s => s.label.toLowerCase().includes(needle) || s.key.toLowerCase().includes(needle)),
      }))
      .filter(cat => cat.stats.length > 0)
  }, [search])

  if (!open) return null

  const handleChange = (key, value) => {
    setThresholds(prev => {
      const next = { ...prev }
      if (value === '' || value == null) delete next[key]
      else {
        const num = Number(value)
        if (Number.isFinite(num)) next[key] = num
      }
      return next
    })
  }

  const clearAll = () => setThresholds({})

  const cleanThresholds = () => {
    const out = {}
    for (const [k, v] of Object.entries(thresholds)) {
      if (v != null && v !== '' && Number.isFinite(Number(v))) out[k] = Number(v)
    }
    return out
  }

  const handleSaveNew = async () => {
    if (!name.trim()) { setError('Threshold set needs a name.'); return }
    const cleaned = cleanThresholds()
    if (Object.keys(cleaned).length === 0) { setError('Set at least one threshold.'); return }
    try {
      setBusy(true); setError(null)
      await onSaveNew(name.trim(), cleaned)
      onClose()
    } catch (e) { setError(e.message ?? String(e)) }
    finally { setBusy(false) }
  }

  const handleUpdate = async () => {
    if (!name.trim()) { setError('Threshold set needs a name.'); return }
    const cleaned = cleanThresholds()
    try {
      setBusy(true); setError(null)
      await onUpdate(name.trim(), cleaned)
      onClose()
    } catch (e) { setError(e.message ?? String(e)) }
    finally { setBusy(false) }
  }

  const handleDelete = async () => {
    if (!confirm(`Delete the "${initialName}" threshold set? This affects all leadership users.`)) return
    try {
      setBusy(true); setError(null)
      await onDelete()
      onClose()
    } catch (e) { setError(e.message ?? String(e)) }
    finally { setBusy(false) }
  }

  const activeCount = Object.values(thresholds).filter(v => v !== '' && v != null && Number.isFinite(Number(v))).length

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="p-4 border-b border-gray-200 dark:border-slate-700 flex items-center gap-3">
          <div className="flex-1">
            <h2 className="text-lg font-bold text-gray-900 dark:text-white">
              {canUpdate ? 'Edit threshold set' : 'New threshold set'}
            </h2>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Minimum daily value per stat. Members under any threshold are highlighted red.
            </p>
          </div>
          <span className="text-xs text-gray-400 dark:text-gray-500">
            {activeCount} active
          </span>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          >
            ✕
          </button>
        </div>

        <div className="p-4 border-b border-gray-200 dark:border-slate-700 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 flex-1 min-w-[16rem]">
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Name</span>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. War Minimums"
              className="flex-1 px-3 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </label>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Filter stats…"
            className="w-56 px-3 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            onClick={clearAll}
            className="text-xs text-red-600 dark:text-red-400 hover:underline"
          >
            Clear all
          </button>
        </div>

        <div className="overflow-y-auto flex-1 p-4 space-y-5">
          {filteredCategories.map(cat => (
            <div key={cat.id}>
              <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
                {cat.label}
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {cat.stats.map(s => (
                  <div key={s.key} className="flex items-center gap-2">
                    <InfoTooltip
                      label={<span className="block truncate">{s.label}</span>}
                      decoration="no-underline"
                      className="flex-1 min-w-0 text-sm text-gray-700 dark:text-gray-300"
                    >{s.label}</InfoTooltip>
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={thresholds[s.key] ?? ''}
                      onChange={e => handleChange(s.key, e.target.value)}
                      placeholder={s.placeholder ?? 'min/day'}
                      className="w-24 px-2 py-1 text-xs border border-gray-300 dark:border-slate-600 rounded bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}
          {filteredCategories.length === 0 && (
            <p className="text-center text-sm text-gray-400 py-8">No stats match "{search}"</p>
          )}
        </div>

        <div className="p-4 border-t border-gray-200 dark:border-slate-700 flex items-center gap-2">
          {error && <span className="text-sm text-red-600 dark:text-red-400 flex-1">{error}</span>}
          {!error && <span className="flex-1" />}
          {canDelete && (
            <button
              onClick={handleDelete}
              disabled={busy}
              className="px-3 py-1.5 text-sm font-medium text-red-600 dark:text-red-400 hover:underline disabled:opacity-50"
            >
              Delete set
            </button>
          )}
          <button
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1.5 text-sm rounded-lg bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-slate-600 disabled:opacity-50"
          >
            Cancel
          </button>
          {canUpdate && (
            <button
              onClick={handleUpdate}
              disabled={busy}
              className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save changes'}
            </button>
          )}
          {canSaveAsNew && (
            <button
              onClick={handleSaveNew}
              disabled={busy}
              className={`px-3 py-1.5 text-sm rounded-lg ${canUpdate ? 'bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-slate-600' : 'bg-blue-600 text-white hover:bg-blue-700'} disabled:opacity-50`}
            >
              {busy ? 'Saving…' : (canUpdate ? 'Save as new' : 'Create set')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
