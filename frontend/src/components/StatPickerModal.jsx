import { useEffect, useMemo, useState } from 'react'
import { STAT_PATHS_BY_CATEGORY } from '../utils/statPaths'

// Modal for picking which columns to show in the Member Overview.
// Caller supplies the identity columns (since they live next to the view, not
// in STAT_PATHS) — everything else comes from the categorised stat registry.
//
// Props:
//   - open               boolean
//   - onClose            () => void
//   - initialName        string
//   - initialSelection   string[]  // column ids (identity keys + stat keys)
//   - identityColumns    [{ key, label }]
//   - canSaveAsNew       boolean   // "Save as new view"
//   - canUpdate          boolean   // "Update this view" (only true when editing a custom view)
//   - canDelete          boolean
//   - onSaveNew          (name, columns) => Promise<void>
//   - onUpdate           (name, columns) => Promise<void>
//   - onDelete           () => Promise<void>

export default function StatPickerModal({
  open,
  onClose,
  initialName,
  initialSelection,
  identityColumns,
  canSaveAsNew = true,
  canUpdate = false,
  canDelete = false,
  onSaveNew,
  onUpdate,
  onDelete,
}) {
  const [name, setName]           = useState(initialName ?? '')
  const [selection, setSelection] = useState(() => new Set(initialSelection ?? []))
  const [busy, setBusy]           = useState(false)
  const [error, setError]         = useState(null)
  const [search, setSearch]       = useState('')

  useEffect(() => {
    if (!open) return
    setName(initialName ?? '')
    setSelection(new Set(initialSelection ?? []))
    setError(null)
    setSearch('')
  }, [open, initialName, initialSelection])

  const filteredCategories = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return STAT_PATHS_BY_CATEGORY
    return STAT_PATHS_BY_CATEGORY
      .map(cat => ({
        ...cat,
        stats: cat.stats.filter(s => s.label.toLowerCase().includes(needle) || s.key.toLowerCase().includes(needle)),
      }))
      .filter(cat => cat.stats.length > 0)
  }, [search])

  const filteredIdentity = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return identityColumns
    return identityColumns.filter(c => c.label.toLowerCase().includes(needle) || c.key.toLowerCase().includes(needle))
  }, [identityColumns, search])

  if (!open) return null

  const toggle = (key) => {
    setSelection(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const toggleCategory = (categoryStats, allOn) => {
    setSelection(prev => {
      const next = new Set(prev)
      for (const s of categoryStats) {
        if (allOn) next.delete(s.key)
        else next.add(s.key)
      }
      return next
    })
  }

  // Build the ordered column list to persist. We preserve identity order first
  // (in the order defined by `identityColumns`), then stats in registry order.
  // Within both, only keys present in `selection` are emitted.
  const buildColumnList = () => {
    const out = []
    for (const c of identityColumns) if (selection.has(c.key)) out.push(c.key)
    for (const cat of STAT_PATHS_BY_CATEGORY) {
      for (const s of cat.stats) if (selection.has(s.key)) out.push(s.key)
    }
    return out
  }

  const handleSaveNew = async () => {
    if (!name.trim()) { setError('View needs a name.'); return }
    const cols = buildColumnList()
    if (cols.length === 0) { setError('Select at least one column.'); return }
    try {
      setBusy(true); setError(null)
      await onSaveNew(name.trim(), cols)
      onClose()
    } catch (e) { setError(e.message ?? String(e)) }
    finally { setBusy(false) }
  }

  const handleUpdate = async () => {
    if (!name.trim()) { setError('View needs a name.'); return }
    const cols = buildColumnList()
    if (cols.length === 0) { setError('Select at least one column.'); return }
    try {
      setBusy(true); setError(null)
      await onUpdate(name.trim(), cols)
      onClose()
    } catch (e) { setError(e.message ?? String(e)) }
    finally { setBusy(false) }
  }

  const handleDelete = async () => {
    if (!confirm(`Delete the "${initialName}" view? This affects all leadership users.`)) return
    try {
      setBusy(true); setError(null)
      await onDelete()
      onClose()
    } catch (e) { setError(e.message ?? String(e)) }
    finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-4 border-b border-gray-200 dark:border-slate-700 flex items-center gap-3">
          <h2 className="text-lg font-bold text-gray-900 dark:text-white flex-1">
            {canUpdate ? 'Edit view' : 'New view'}
          </h2>
          <span className="text-xs text-gray-400 dark:text-gray-500">
            {selection.size} selected
          </span>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          >
            ✕
          </button>
        </div>

        {/* Name + search */}
        <div className="p-4 border-b border-gray-200 dark:border-slate-700 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 flex-1 min-w-[16rem]">
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Name</span>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. War Activity"
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
        </div>

        {/* Body — scrollable */}
        <div className="overflow-y-auto flex-1 p-4 space-y-5">
          {/* Identity columns */}
          {filteredIdentity.length > 0 && (
            <CategorySection
              label="Identity"
              items={filteredIdentity}
              selection={selection}
              onToggle={toggle}
              onToggleAll={(allOn) => toggleCategory(filteredIdentity, allOn)}
            />
          )}

          {/* Stat categories */}
          {filteredCategories.map(cat => (
            <CategorySection
              key={cat.id}
              label={cat.label}
              items={cat.stats}
              selection={selection}
              onToggle={toggle}
              onToggleAll={(allOn) => toggleCategory(cat.stats, allOn)}
            />
          ))}

          {filteredCategories.length === 0 && filteredIdentity.length === 0 && (
            <p className="text-center text-sm text-gray-400 py-8">No stats match "{search}"</p>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-200 dark:border-slate-700 flex items-center gap-2">
          {error && <span className="text-sm text-red-600 dark:text-red-400 flex-1">{error}</span>}
          {!error && <span className="flex-1" />}
          {canDelete && (
            <button
              onClick={handleDelete}
              disabled={busy}
              className="px-3 py-1.5 text-sm font-medium text-red-600 dark:text-red-400 hover:underline disabled:opacity-50"
            >
              Delete view
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
              {busy ? 'Saving…' : (canUpdate ? 'Save as new' : 'Create view')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function CategorySection({ label, items, selection, onToggle, onToggleAll }) {
  const allOn = items.length > 0 && items.every(s => selection.has(s.key))
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
          {label}
        </h3>
        <button
          onClick={() => onToggleAll(allOn)}
          className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
        >
          {allOn ? 'Clear all' : 'Select all'}
        </button>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-4 gap-y-1.5">
        {items.map(item => (
          <label
            key={item.key}
            className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer hover:text-gray-900 dark:hover:text-white"
          >
            <input
              type="checkbox"
              checked={selection.has(item.key)}
              onChange={() => onToggle(item.key)}
              className="rounded"
            />
            <span className="truncate" title={item.label}>{item.label}</span>
          </label>
        ))}
      </div>
    </div>
  )
}
