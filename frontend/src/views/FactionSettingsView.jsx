// Faction Settings (slice #74): leadership self-serve — role assignments,
// faction identity/branding, and the whole-document policy settings
// (tier/CPR requirements, payout tickets, war-room defaults). API mode only;
// the Supabase stack keeps its config.js-driven behavior until cutover.
import { useEffect, useState, useCallback, useRef } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useFactionConfig } from '../contexts/FactionConfigContext'
import { apiGet, apiPost, apiPut, apiDelete } from '../utils/apiClient'
import { PAYOUT_MODES, DEFAULT_PAYOUT_MODE } from '../utils/payoutCalculations'
import { CheckCircle2, AlertTriangle, Trash2, Loader2, Image as ImageIcon } from 'lucide-react'

// Read a picked file as a data: URL (base64) for the branding upload endpoint.
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result)
    r.onerror = () => reject(new Error('Could not read the file'))
    r.readAsDataURL(file)
  })
}

// Upload control for a branding image (#173): preview + Upload + a URL fallback.
// On upload the server stores the bytes and repoints branding.<kind>; we mirror
// the returned served path into local state for the preview + Save Identity.
function ImageUploadField({ kind, label, hint, value, onChange, readOnly }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const inputRef = useRef(null)

  async function onFile(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setErr(null); setBusy(true)
    try {
      const dataUrl = await fileToDataUrl(file)
      const res = await apiPut(`/api/admin/branding/${kind}`, { content_type: file.type, data_base64: dataUrl })
      onChange(res.url) // versioned served path, already persisted server-side
    } catch (e2) {
      setErr(e2.payload?.error || e2.message)
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="text-sm text-gray-700 dark:text-gray-300">{label}</div>
      <div className="flex items-center gap-3">
        <div className="w-16 h-16 rounded border border-gray-200 dark:border-slate-600 bg-gray-50 dark:bg-slate-900 flex items-center justify-center overflow-hidden flex-shrink-0">
          {value
            ? <img src={value} alt={label} className="max-w-full max-h-full object-contain" />
            : <ImageIcon className="w-6 h-6 text-gray-300 dark:text-gray-600" />}
        </div>
        {!readOnly && (
          <div>
            <button type="button" onClick={() => inputRef.current?.click()} disabled={busy}
              className="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium disabled:opacity-50">
              {busy ? 'Uploading…' : 'Upload image'}
            </button>
            <input ref={inputRef} type="file" className="hidden" onChange={onFile}
              accept={kind === 'favicon' ? 'image/x-icon,image/png' : 'image/*'} />
            {err && <div className="text-xs text-red-500 mt-1">{err}</div>}
          </div>
        )}
      </div>
      {hint && <div className="text-xs text-gray-400 dark:text-gray-500">{hint}</div>}
      <input value={value || ''} placeholder="…or paste an image URL" disabled={readOnly}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full px-3 py-2 rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-900 dark:text-white text-sm" />
    </div>
  )
}

const ROLE_OPTIONS = ['admin', 'leadership', 'warlead', 'ocmanager', 'visitor']

// Faction default OC payout mode (#136). `tiered` is the only mode that shows
// the tier machinery (Tier Management / Requirements + tier columns).
const PAYOUT_MODE_LABELS = {
  tiered: { label: 'Tiered', hint: 'Per-tier tickets × time weighting. Shows the tier machinery.' },
  'flat-weighted': { label: 'Flat-weighted', hint: 'Everyone one tier; time / sit-out weighting still applies. No tier UI.' },
  equal: { label: 'Equal', hint: 'Even split among everyone who did ≥1 OC. No tier UI.' },
}

// `template` seeds the editor when a document has never been saved, so a leader
// can see the expected schema shape instead of an empty `{}`. The War Room
// Defaults shape mirrors the editable war_room_config_v2 fields (poll cadences,
// dibs auto-drop window, revive service) — a starting point for new war sessions.
const SETTINGS_DOCS = [
  { key: 'tier_requirements', label: 'Tier Requirements', hint: 'Per-tier CPR checks the tier assigner and OC pages use.' },
  { key: 'cpr_requirements', label: 'CPR Requirements', hint: 'Per-crime/position minimum CPR shown on the OC pages.' },
  { key: 'payout_tickets', label: 'Payout Tickets', hint: 'Tickets per tier for the OC payout split.' },
  {
    key: 'war_room_defaults', label: 'War Room Defaults',
    hint: 'Default poll cadences / dibs auto-drop / revive service for new war sessions.',
    template: {
      chain_poll_interval_ours_sec: 5,
      chain_poll_interval_enemy_sec: 30,
      dibs_expiry_seconds: 30,
      tornstats_max_age_days: 0,
      revive_service_name: null,
      revive_service_url: null,
    },
  },
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
  // One row per member (#101): group the per-(user,role) API rows.
  const members = []
  {
    const byId = new Map()
    for (const r of rows) {
      if (!byId.has(r.torn_user_id)) {
        byId.set(r.torn_user_id, { torn_user_id: r.torn_user_id, member_name: r.member_name, grants: [] })
        members.push(byId.get(r.torn_user_id))
      }
      byId.get(r.torn_user_id).grants.push({ role: r.role, granted_by: r.granted_by })
    }
  }
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
                <th className="py-2 pr-4">Roles</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.torn_user_id} className="border-b border-gray-100 dark:border-slate-700/50">
                  <td className="py-2 pr-4 text-gray-900 dark:text-white">{m.torn_user_id}</td>
                  <td className="py-2 pr-4 text-gray-700 dark:text-gray-300">{m.member_name || '—'}</td>
                  <td className="py-2 pr-4">
                    <span className="inline-flex flex-wrap gap-1.5">
                      {m.grants.map((g) => (
                        <span key={g.role} title={g.granted_by ? `granted by ${g.granted_by}` : undefined}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs capitalize bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300">
                          {g.role}
                          {!readOnly && (
                            <button onClick={() => revoke(m.torn_user_id, g.role)} title={`Revoke ${g.role}`}
                              className="text-blue-400 hover:text-red-500 dark:hover:text-red-400 leading-none">
                              ×
                            </button>
                          )}
                        </span>
                      ))}
                    </span>
                  </td>
                </tr>
              ))}
              {members.length === 0 && (
                <tr><td colSpan="3" className="py-3 text-gray-500 dark:text-gray-400">No role assignments yet.</td></tr>
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
        {brandingField('tag', 'Faction tag (short)', 'e.g. ABC')}
        {brandingField('accent', 'Accent color', '#3b82f6')}
      </div>
      <div className="grid sm:grid-cols-3 gap-4">
        <ImageUploadField kind="logo" label="Logo" readOnly={readOnly}
          hint="Shows in the header, left of the title. PNG/GIF/SVG, up to 3 MB (GIFs animate)."
          value={branding.logo || ''} onChange={(v) => setBranding((b) => ({ ...b, logo: v }))} />
        <ImageUploadField kind="favicon" label="Favicon" readOnly={readOnly}
          hint="Browser-tab icon (.ico or .png). Applies on reload."
          value={branding.favicon || ''} onChange={(v) => setBranding((b) => ({ ...b, favicon: v }))} />
        <ImageUploadField kind="hero" label="Hero image" readOnly={readOnly}
          hint="Large banner/splash image (placement TBD). PNG/GIF/SVG, up to 3 MB."
          value={branding.hero || ''} onChange={(v) => setBranding((b) => ({ ...b, hero: v }))} />
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
  // Seed from the saved value; if there is none, fall back to the doc's template
  // shape (or an empty object) so the schema is visible before the first save.
  const seed = initial ?? doc.template ?? {}
  const [text, setText] = useState(() => JSON.stringify(seed, null, 2))
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

function PayoutModeSection({ readOnly }) {
  const { payoutMode, refresh } = useFactionConfig()
  const [mode, setMode] = useState(payoutMode ?? DEFAULT_PAYOUT_MODE)
  const [feedback, setFeedback] = useState(null)
  const [saving, setSaving] = useState(false)

  // Adopt the loaded faction mode once it arrives (context resolves async).
  useEffect(() => {
    if (payoutMode) setMode(payoutMode)
  }, [payoutMode])

  async function save() {
    setFeedback(null)
    setSaving(true)
    try {
      await apiPut('/api/admin/settings/payout_mode', { value: mode })
      await refresh()
      setFeedback({ kind: 'ok', msg: 'Saved — tier UI and payout defaults follow this now.' })
    } catch (err) {
      setFeedback({ kind: 'err', msg: err.payload?.error || err.message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <SectionCard title="OC Payout Mode">
      <p className="text-sm text-gray-500 dark:text-gray-400">
        The faction default for OC payouts. Only <strong>Tiered</strong> shows the tier
        machinery (Tier Management, Tier Requirements, and tier columns); the other modes
        hide it. New payout weeks pre-fill from this default.
      </p>
      <div className="space-y-2">
        {PAYOUT_MODES.map((m) => (
          <label key={m} className="flex items-start gap-3 cursor-pointer">
            <input type="radio" name="payout_mode" value={m} checked={mode === m}
              disabled={readOnly} onChange={() => setMode(m)} className="mt-1" />
            <span>
              <span className="font-medium text-gray-900 dark:text-white">{PAYOUT_MODE_LABELS[m].label}</span>
              <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">{PAYOUT_MODE_LABELS[m].hint}</span>
            </span>
          </label>
        ))}
      </div>
      {!readOnly && (
        <div className="flex items-center gap-3">
          <button onClick={save} disabled={saving}
            className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium">
            Save Payout Mode
          </button>
          <Feedback state={feedback} />
        </div>
      )}
    </SectionCard>
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

  return (
    <div className="space-y-6">
      <RolesSection readOnly={readOnly} />
      <IdentitySection readOnly={readOnly} />
      <PayoutModeSection readOnly={readOnly} />
      <PolicySection readOnly={readOnly} />
    </div>
  )
}
