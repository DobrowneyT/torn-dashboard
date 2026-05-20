import { useState } from 'react'

/**
 * Modal for managing the list of preset revive services that appear in the
 * War Room ConfigPanel dropdown. Each service has a {name, url}.
 *
 * Props:
 *  - services: current array of {name, url}
 *  - activeName: currently selected service name (so it can't be removed without warning)
 *  - onSave(newServices): persists the new list
 *  - onClose(): close modal without saving
 */
export default function ReviveServicesModal({ services, activeName, onSave, onClose }) {
  const [list, setList] = useState(Array.isArray(services) ? services : [])
  const [newName, setNewName]     = useState('')
  const [newUrl, setNewUrl]       = useState('')
  const [newSource, setNewSource] = useState('')
  const [newSourceKey, setNewSourceKey] = useState('source')
  const [saving, setSaving]       = useState(false)
  const [error, setError]         = useState(null)

  function addService() {
    const name = newName.trim()
    const url  = newUrl.trim()
    const source = newSource.trim()
    const sourceKey = newSourceKey.trim() || 'source'
    if (!name || !url) { setError('Name and URL are required.'); return }
    if (list.some(s => s.name.toLowerCase() === name.toLowerCase())) {
      setError('A service with that name already exists.')
      return
    }
    setList([...list, { name, url, source: source || name, sourceKey }])
    setNewName(''); setNewUrl(''); setNewSource(''); setNewSourceKey('source'); setError(null)
  }

  function removeService(idx) {
    setList(list.filter((_, i) => i !== idx))
  }

  function updateService(idx, field, value) {
    setList(list.map((s, i) => i === idx ? { ...s, [field]: value } : s))
  }

  async function handleSave() {
    setSaving(true); setError(null)
    try {
      await onSave(list)
      onClose()
    } catch (e) {
      setError(e.message)
    } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="card max-w-2xl w-full" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-gray-900 dark:text-white">Manage Revive Services</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-2xl leading-none">×</button>
        </div>

        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          Add the revive factions your team uses (e.g. UHC, Nuke). Each entry needs a display name and the URL the quick-links button should open.
        </p>

        {/* Existing services */}
        <div className="space-y-2 mb-4 max-h-64 overflow-y-auto">
          {list.length === 0 && (
            <p className="text-sm text-gray-400 dark:text-gray-600 italic py-4 text-center">
              No services configured yet — add one below.
            </p>
          )}
          {list.map((s, idx) => {
            const isActive = activeName && s.name === activeName
            return (
              <div key={idx} className="flex flex-wrap items-center gap-2 p-2 border border-gray-200 dark:border-slate-700 rounded-lg">
                <input
                  type="text"
                  value={s.name}
                  onChange={e => updateService(idx, 'name', e.target.value)}
                  placeholder="Name"
                  className="w-28 px-2 py-1 text-sm border border-gray-300 dark:border-slate-600 rounded bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <input
                  type="url"
                  value={s.url}
                  onChange={e => updateService(idx, 'url', e.target.value)}
                  placeholder="https://…"
                  className="flex-1 min-w-[12rem] px-2 py-1 text-sm border border-gray-300 dark:border-slate-600 rounded bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <input
                  type="text"
                  value={s.source ?? ''}
                  onChange={e => updateService(idx, 'source', e.target.value)}
                  placeholder="source value"
                  title="The identifier sent to the service (e.g. UHC Script, WTF Revive Button Script)"
                  className="w-40 px-2 py-1 text-sm border border-gray-300 dark:border-slate-600 rounded bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <input
                  type="text"
                  value={s.sourceKey ?? 'source'}
                  onChange={e => updateService(idx, 'sourceKey', e.target.value)}
                  placeholder="key"
                  title="JSON key for the source value — UHC uses 'source', WTF uses 'requestChannel'"
                  className="w-28 px-2 py-1 text-sm border border-gray-300 dark:border-slate-600 rounded bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                />
                {isActive && (
                  <span className="text-xs text-blue-600 dark:text-blue-400 font-medium shrink-0" title="Currently selected">
                    active
                  </span>
                )}
                <button
                  onClick={() => removeService(idx)}
                  className="px-2 py-1 text-xs text-red-600 hover:text-red-700 dark:text-red-400 hover:underline shrink-0"
                  title="Remove"
                >
                  Remove
                </button>
              </div>
            )
          })}
        </div>

        {/* Add new */}
        <div className="border-t border-gray-200 dark:border-slate-700 pt-4">
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Add a service</label>
          <div className="flex flex-wrap gap-2">
            <input
              type="text"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="Name (e.g. UHC)"
              className="w-40 px-3 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <input
              type="url"
              value={newUrl}
              onChange={e => setNewUrl(e.target.value)}
              placeholder="https://… service endpoint URL"
              className="flex-1 min-w-[12rem] px-3 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <input
              type="text"
              value={newSource}
              onChange={e => setNewSource(e.target.value)}
              placeholder="source value (e.g. UHC Script)"
              title="The identifier sent in the POST payload. Defaults to the service name if blank."
              className="w-44 px-3 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <input
              type="text"
              value={newSourceKey}
              onChange={e => setNewSourceKey(e.target.value)}
              placeholder="key"
              title="JSON key for the source value — UHC uses 'source', WTF uses 'requestChannel'"
              className="w-28 px-3 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
            />
            <button
              onClick={addService}
              className="px-3 py-1.5 text-sm bg-gray-200 hover:bg-gray-300 dark:bg-slate-700 dark:hover:bg-slate-600 text-gray-700 dark:text-gray-300 rounded-lg font-medium transition-colors"
            >
              Add
            </button>
          </div>
        </div>

        {error && <p className="mt-3 text-xs text-red-600 dark:text-red-400">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm bg-gray-200 hover:bg-gray-300 dark:bg-slate-700 dark:hover:bg-slate-600 text-gray-700 dark:text-gray-300 rounded-lg font-medium transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg font-medium transition-colors"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
