import { useState } from 'react'
import InfoTooltip from './InfoTooltip'

/**
 * Modal for managing the list of preset revive services that appear in the
 * War Room ConfigPanel dropdown. Each service has a {name, url, source,
 * sourceKey, preset}.
 *
 * `preset` selects the payload shape the Edge Function uses:
 *   - 'json' (default): UHC / WTF / generic JSON-body services. The
 *     sourceKey column controls which JSON key carries the source value.
 *   - 'nuke': form-encoded body with torn_player_id / _name / _country /
 *     app_info. Country is resolved server-side from war_room_state, so
 *     the source/sourceKey columns are ignored (we just send the source
 *     string as `app_info`).
 *
 * Props:
 *  - services: current array of {name, url, source, sourceKey, preset}
 *  - activeName: currently selected service name (so it can't be removed without warning)
 *  - onSave(newServices): persists the new list
 *  - onClose(): close modal without saving
 */

// Per-preset defaults the Add form pre-fills with. URL is intentionally left
// blank for json presets (each faction's UHC/WTF/etc URL differs); Nuke's
// API endpoint is fixed across all users so we can hard-code it.
const PRESETS = {
  json: { label: 'JSON (UHC / WTF / generic)', sourceKey: 'source',         url: '' },
  nuke: { label: 'Nuke (form-encoded)',        sourceKey: '',               url: 'https://nuke.family/api/revive-request' },
}

export default function ReviveServicesModal({ services, activeName, onSave, onClose }) {
  const [list, setList] = useState(Array.isArray(services) ? services : [])
  const [newName, setNewName]     = useState('')
  const [newUrl, setNewUrl]       = useState('')
  const [newSource, setNewSource] = useState('')
  const [newSourceKey, setNewSourceKey] = useState('source')
  const [newPreset, setNewPreset] = useState('json')
  const [saving, setSaving]       = useState(false)
  const [error, setError]         = useState(null)

  function handlePresetPick(preset) {
    setNewPreset(preset)
    const defaults = PRESETS[preset] ?? PRESETS.json
    setNewSourceKey(defaults.sourceKey)
    // Only auto-fill URL when the field is empty so we don't clobber the
    // user's in-progress typing if they swap presets.
    if (!newUrl.trim()) setNewUrl(defaults.url)
  }

  function addService() {
    const name = newName.trim()
    const url  = newUrl.trim()
    const source = newSource.trim()
    const sourceKey = newSourceKey.trim() || 'source'
    const preset = newPreset || 'json'
    if (!name || !url) { setError('Name and URL are required.'); return }
    if (list.some(s => s.name.toLowerCase() === name.toLowerCase())) {
      setError('A service with that name already exists.')
      return
    }
    setList([...list, { name, url, source: source || name, sourceKey, preset }])
    setNewName(''); setNewUrl(''); setNewSource(''); setNewSourceKey('source'); setNewPreset('json'); setError(null)
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
      <div className="card max-w-3xl w-full" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-gray-900 dark:text-white">Manage Revive Services</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-2xl leading-none">×</button>
        </div>

        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          Add the revive factions your team uses (e.g. UHC, Nuke). Each entry needs a display name and the URL the quick-links button should open.
          Pick <strong>JSON</strong> for UHC / WTF / most services, or <strong>Nuke</strong> for Central Hospital (form-encoded; country is resolved automatically).
        </p>

        {/* Existing services */}
        <div className="space-y-2 mb-4 max-h-72 overflow-y-auto">
          {list.length === 0 && (
            <p className="text-sm text-gray-400 dark:text-gray-600 italic py-4 text-center">
              No services configured yet — add one below.
            </p>
          )}
          {list.map((s, idx) => {
            const isActive = activeName && s.name === activeName
            const preset = s.preset ?? 'json'
            const isNuke = preset === 'nuke'
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
                <InfoTooltip wrap label={
                <select
                  value={preset}
                  onChange={e => updateService(idx, 'preset', e.target.value)}
                  aria-label="Payload shape"
                  className="w-24 px-2 py-1 text-sm border border-gray-300 dark:border-slate-600 rounded bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="json">JSON</option>
                  <option value="nuke">Nuke</option>
                </select>
                }>Payload shape — JSON for UHC/WTF/etc, Nuke for Central Hospital.</InfoTooltip>
                <InfoTooltip wrap className="min-w-0" label={
                <input
                  type="text"
                  value={s.source ?? ''}
                  onChange={e => updateService(idx, 'source', e.target.value)}
                  placeholder={isNuke ? 'app_info value' : 'source value'}
                  className="w-40 px-2 py-1 text-sm border border-gray-300 dark:border-slate-600 rounded bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                }>{isNuke
                  ? 'Sent as the app_info field in the Nuke payload.'
                  : 'The identifier sent to the service (e.g. UHC Script, WTF Revive Button Script).'}</InfoTooltip>
                <InfoTooltip wrap className="min-w-0" label={
                <input
                  type="text"
                  value={s.sourceKey ?? 'source'}
                  onChange={e => updateService(idx, 'sourceKey', e.target.value)}
                  placeholder="key"
                  disabled={isNuke}
                  className={`w-28 px-2 py-1 text-sm border border-gray-300 dark:border-slate-600 rounded bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono ${isNuke ? 'opacity-50 cursor-not-allowed' : ''}`}
                />
                }>{isNuke
                  ? 'Not used for Nuke — Nuke has a fixed payload shape.'
                  : "JSON key for the source value — UHC uses 'source', WTF uses 'requestChannel'."}</InfoTooltip>
                {isActive && (
                  <InfoTooltip label="active" className="text-xs text-blue-600 dark:text-blue-400 font-medium shrink-0">
                    Currently selected
                  </InfoTooltip>
                )}
                <button
                  onClick={() => removeService(idx)}
                  className="px-2 py-1 text-xs text-red-600 hover:text-red-700 dark:text-red-400 hover:underline shrink-0"
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
            <select
              value={newPreset}
              onChange={e => handlePresetPick(e.target.value)}
              aria-label="Payload shape"
              className="w-48 px-2 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {Object.entries(PRESETS).map(([key, p]) => (
                <option key={key} value={key}>{p.label}</option>
              ))}
            </select>
            <input
              type="url"
              value={newUrl}
              onChange={e => setNewUrl(e.target.value)}
              placeholder="https://… service endpoint URL"
              className="flex-1 min-w-[12rem] px-3 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <InfoTooltip wrap className="min-w-0" label={
            <input
              type="text"
              value={newSource}
              onChange={e => setNewSource(e.target.value)}
              placeholder={newPreset === 'nuke' ? 'app_info value' : 'source value (e.g. UHC Script)'}
              className="w-44 px-3 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            }>The identifier sent in the POST payload. Defaults to the service name if blank.</InfoTooltip>
            <InfoTooltip wrap className="min-w-0" label={
            <input
              type="text"
              value={newSourceKey}
              onChange={e => setNewSourceKey(e.target.value)}
              placeholder="key"
              disabled={newPreset === 'nuke'}
              className={`w-28 px-3 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono ${newPreset === 'nuke' ? 'opacity-50 cursor-not-allowed' : ''}`}
            />
            }>{newPreset === 'nuke'
              ? 'Not used for Nuke — its payload shape is fixed.'
              : "JSON key for the source value — UHC uses 'source', WTF uses 'requestChannel'."}</InfoTooltip>
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
