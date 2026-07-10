// Faction Settings (slice #74): leadership self-serve — role assignments,
// faction identity/branding, and the whole-document policy settings
// (tier/CPR requirements, payout tickets, war-room defaults). API mode only;
// the Supabase stack keeps its config.js-driven behavior until cutover.
import { useEffect, useState, useCallback } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { API_MODE, apiGet, apiPost, apiPut, apiDelete } from '../utils/apiClient'
import { CheckCircle2, AlertTriangle, Trash2, Loader2 } from 'lucide-react'

const ROLE_OPTIONS = ['admin', 'leadership', 'warlead', 'ocmanager', 'visitor']

const SETTINGS_DOCS = [
  { key: 'tier_requirements', label: 'Tier Requirements', hint: 'Per-tier CPR checks the tier assigner and OC pages use.' },
  { key: 'cpr_requirements', label: 'CPR Requirements', hint: 'Per-crime/position minimum CPR shown on the OC pages.' },
  { key: 'payout_tickets', label: 'Payout Tickets', hint: 'Tickets per tier for the OC payout split.' },
  { key: 'war_room_defaults', label: 'War Room Defaults', hint: 'Default poll cadences / revive service for new war sessions.' },
]

function SectionCard({ title, children }) {
  return (
    <div className="bg-white dark:bg-slate-800 rounded-lg shadow p-4 sm:p-6 space-y-4">
      <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{title}</h3>
      {children}
    </div>
  )
}

function Feedback({ state }) {
  if (!state) return null
  const ok = state.kind === 'ok'
  return (
    <span className={`inline-flex items-center gap-1 text-sm ${ok ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
      {ok ? <CheckCircle2 className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
      {state.msg}
    </span>
  )
}

function RolesSection({ readOnly }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [newId, setNewId] = useState('')
  const [newRole, setNewRole] = useState('warlead')
  const [feedback, setFeedback] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiGet('/api/admin/roles')
      setRows(data.roles || [])
    } catch (err) {
      setFeedback({ kind: 'err', msg: err.message })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function grant() {
    setFeedback(null)
    try {
      await apiPost('/api/admin/roles', { torn_user_id: Number(newId), role: newRole })
      setNewId('')
      setFeedback({ kind: 'ok', msg: 'Role granted — takes effect on their next login.' })
      await load()
    } catch (err) {
      setFeedback({ kind: 'err', msg: err.payload?.error || err.message })
    }
  }

  async function revoke(userId, role) {
    setFeedback(null)
    try {
      await apiDelete(`/api/admin/roles/${userId}/${role}`)
      setFeedback({ kind: 'ok', msg: 'Role revoked — gone on their next login.' })
      await load()
    } catch (err) {
      setFeedback({ kind: 'err', msg: err.payload?.error || err.message })
    }
  }

  return (
    <SectionCard title="Role Assignments">
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Grants take effect on the member's next login. A user can hold several roles.
      </p>
      {loading ? (
        <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-slate-700">
                <th className="py-2 pr-4">Torn ID</th>
                <th className="py-2 pr-4">Name</th>
                <th className="py-2 pr-4">Role</th>
                <th className="py-2 pr-4">Granted by</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.torn_user_id}-${r.role}`} className="border-b border-gray-100 dark:border-slate-700/50">
                  <td className="py-2 pr-4 text-gray-900 dark:text-white">{r.torn_user_id}</td>
                  <td className="py-2 pr-4 text-gray-700 dark:text-gray-300">{r.member_name || '—'}</td>
                  <td className="py-2 pr-4"><span className="capitalize text-gray-900 dark:text-white">{r.role}</span></td>
                  <td className="py-2 pr-4 text-gray-500 dark:text-gray-400">{r.granted_by || '—'}</td>
                  <td className="py-2 text-right">
                    {!readOnly && (
                      <button onClick={() => revoke(r.torn_user_id, r.role)}
                        className="text-red-500 hover:text-red-700 dark:hover:text-red-400" title="Revoke">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan="5" className="py-3 text-gray-500 dark:text-gray-400">No role assignments yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {!readOnly && (
        <div className="flex flex-wrap items-center gap-2">
          <input value={newId} onChange={(e) => setNewId(e.target.value)} placeholder="Torn user ID"
            className="px-3 py-2 rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-sm text-gray-900 dark:text-white w-36" />
          <select value={newRole} onChange={(e) => setNewRole(e.target.value)}
            className="px-3 py-2 rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-sm text-gray-900 dark:text-white">
            {ROLE_OPTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <button onClick={grant} disabled={!/^\d+$/.test(newId)}
            className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium">
            Grant Role
          </button>
          <Feedback state={feedback} />
        </div>
      )}
    </SectionCard>
  )
}

function IdentitySection({ readOnly }) {
  const [displayName, setDisplayName] = useState('')
  const [branding, setBranding] = useState({})
  const [feedback, setFeedback] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    apiGet('/api/bootstrap')
      .then((boot) => {
        setDisplayName(boot.faction?.display_name || '')
        setBranding(boot.faction?.branding || {})
      })
      .catch((err) => setFeedback({ kind: 'err', msg: err.message }))
      .finally(() => setLoading(false))
  }, [])

  async function save() {
    setFeedback(null)
    try {
      await apiPut('/api/admin/config', { display_name: displayName, branding })
      setFeedback({ kind: 'ok', msg: 'Saved — reload to see it applied.' })
    } catch (err) {
      setFeedback({ kind: 'err', msg: err.payload?.error || err.message })
    }
  }

  const brandingField = (key, label, placeholder) => (
    <label className="block text-sm">
      <span className="text-gray-700 dark:text-gray-300">{label}</span>
      <input value={branding[key] || ''} placeholder={placeholder} disabled={readOnly}
        onChange={(e) => setBranding((b) => ({ ...b, [key]: e.target.value }))}
        className="mt-1 w-full px-3 py-2 rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-900 dark:text-white" />
    </label>
  )

  if (loading) return <SectionCard title="Faction Identity"><Loader2 className="w-5 h-5 animate-spin text-gray-400" /></SectionCard>

  return (
    <SectionCard title="Faction Identity">
      <label className="block text-sm">
        <span className="text-gray-700 dark:text-gray-300">Display name</span>
        <input value={displayName} disabled={readOnly} onChange={(e) => setDisplayName(e.target.value)}
          className="mt-1 w-full px-3 py-2 rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-900 dark:text-white" />
      </label>
      <div className="grid sm:grid-cols-2 gap-3">
        {brandingField('hero_image', 'Hero image URL', '/img/hero.png')}
        {brandingField('favicon', 'Favicon URL', '/img/favicon.ico')}
        {brandingField('accent', 'Accent color', '#3b82f6')}
        {brandingField('logo', 'Logo URL', '/img/logo.png')}
      </div>
      {!readOnly && (
        <div className="flex items-center gap-3">
          <button onClick={save} className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium">
            Save Identity
          </button>
          <Feedback state={feedback} />
        </div>
      )}
    </SectionCard>
  )
}

function PolicyDocEditor({ doc, initial, readOnly }) {
  const [text, setText] = useState(() => JSON.stringify(initial ?? {}, null, 2))
  const [feedback, setFeedback] = useState(null)
  const [parseError, setParseError] = useState(null)

  function onChange(v) {
    setText(v)
    try {
      JSON.parse(v)
      setParseError(null)
    } catch {
      setParseError('Not valid JSON')
    }
  }

  async function save() {
    setFeedback(null)
    try {
      await apiPut(`/api/admin/settings/${doc.key}`, { value: JSON.parse(text) })
      setFeedback({ kind: 'ok', msg: 'Saved — OC pages pick it up on next load.' })
    } catch (err) {
      setFeedback({ kind: 'err', msg: err.payload?.error || err.message })
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <div>
          <span className="font-medium text-gray-900 dark:text-white">{doc.label}</span>
          <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">{doc.hint}</span>
        </div>
        <Feedback state={feedback} />
      </div>
      <textarea value={text} onChange={(e) => onChange(e.target.value)} rows={8} disabled={readOnly}
        spellCheck={false}
        className="w-full font-mono text-xs px-3 py-2 rounded border border-gray-300 dark:border-slate-600 bg-gray-50 dark:bg-slate-900 text-gray-900 dark:text-gray-100" />
      {!readOnly && (
        <div className="flex items-center gap-3">
          <button onClick={save} disabled={!!parseError}
            className="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm">
            Save {doc.label}
          </button>
          {parseError && <span className="text-sm text-red-500">{parseError}</span>}
        </div>
      )}
    </div>
  )
}

function PolicySection({ readOnly }) {
  const [docs, setDocs] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    apiGet('/api/admin/settings')
      .then((data) => {
        const byKey = Object.fromEntries((data.settings || []).map((s) => [s.key, s.value]))
        setDocs(byKey)
      })
      .catch((err) => setError(err.message))
  }, [])

  if (error) return <SectionCard title="Policy Documents"><Feedback state={{ kind: 'err', msg: error }} /></SectionCard>
  if (!docs) return <SectionCard title="Policy Documents"><Loader2 className="w-5 h-5 animate-spin text-gray-400" /></SectionCard>

  return (
    <SectionCard title="Policy Documents">
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Whole-document JSON settings. Edits apply on the next page load — no redeploy.
      </p>
      <div className="space-y-6">
        {SETTINGS_DOCS.map((doc) => (
          <PolicyDocEditor key={doc.key} doc={doc} initial={docs[doc.key]} readOnly={readOnly} />
        ))}
      </div>
    </SectionCard>
  )
}

export default function FactionSettingsView() {
  const { isVisitor } = useAuth()
  const readOnly = !!isVisitor

  if (!API_MODE) {
    return (
      <div className="text-gray-600 dark:text-gray-400 text-sm">
        Faction settings are managed through the new API stack — not available on this deployment.
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <RolesSection readOnly={readOnly} />
      <IdentitySection readOnly={readOnly} />
      <PolicySection readOnly={readOnly} />
    </div>
  )
}
