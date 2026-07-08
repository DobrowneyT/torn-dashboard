import { useState, useEffect } from 'react'
import { LoaderCircle, Lock } from 'lucide-react'
import RollCallResultsTable from './RollCallResultsTable'

// War Leaders only. War type / agreed scores / strategy notes + the embedded
// roll-call results table and a "not yet responded" list. Edited responses
// (revised=true) are highlighted so leaders notice changes.
// readOnly: rendered for visitors — all fields disabled, Save hidden.
export default function WarNotesPanel({ currentWar, notes, privateNotes = '', onSave, saving, saveError, rollCallRows = [], ourMembers = [], readOnly = false }) {
  const [warType, setWarType] = useState(notes?.war_type ?? 'real')
  const [termedUs, setTermedUs] = useState(notes?.termed_score_us ?? '')
  const [termedThem, setTermedThem] = useState(notes?.termed_score_them ?? '')
  const [raceTarget, setRaceTarget] = useState(notes?.race_target_score ?? '')
  const [text, setText] = useState(notes?.notes_public ?? '')
  const [privText, setPrivText] = useState(privateNotes ?? '')
  const [msg, setMsg] = useState(null)

  async function handleSave() {
    setMsg(null)
    const ok = await onSave({
      opponent_faction_id: currentWar?.opponentId ?? null,
      war_type: warType,
      termed_score_us:   warType === 'termed' ? (Number(termedUs) || null) : null,
      termed_score_them: warType === 'termed' ? (Number(termedThem) || null) : null,
      race_target_score: warType === 'race' ? (Number(raceTarget) || null) : null,
      notes_public: text || null,
      notes_private: privText || null,
      expected_updated_at: notes?.updated_at ?? null,
    })
    if (ok !== false) setMsg('Saved.')
  }

  // Private note loads async (via the edge function) — sync it in when it arrives.
  useEffect(() => { setPrivText(privateNotes ?? '') }, [privateNotes])

  const respondedIds = new Set(rollCallRows.map(r => Number(r.member_id)))
  const nonResponders = ourMembers
    .filter(m => !respondedIds.has(Number(m.member_id)))
    .sort((a, b) => (a.member_name || '').localeCompare(b.member_name || '', undefined, { sensitivity: 'base' }))

  return (
    <div className="mt-4 pt-4 border-t border-gray-200 dark:border-slate-700">
      <h4 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-3">War Notes &amp; Roll Call</h4>

      {!currentWar && (
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
          No matched war detected yet. Notes can be saved once a war is set up.
        </p>
      )}

      {/* War type + scores */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <span className="text-xs font-medium text-gray-500 dark:text-gray-400 mr-1">Type:</span>
        {['real', 'termed', 'race'].map(t => (
          <button key={t} type="button" disabled={readOnly} onClick={() => setWarType(t)}
            className={`px-2.5 py-1 rounded-full text-xs font-medium capitalize transition-colors ${
              warType === t ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-slate-600'
            }`}>
            {t}
          </button>
        ))}
        {warType === 'termed' && (
          <>
            <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400">
              Us
              <input type="number" value={termedUs} disabled={readOnly} onChange={e => setTermedUs(e.target.value)}
                className="input w-24 py-1 text-sm" placeholder="15500" />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400">
              Them
              <input type="number" value={termedThem} disabled={readOnly} onChange={e => setTermedThem(e.target.value)}
                className="input w-24 py-1 text-sm" placeholder="7200" />
            </label>
          </>
        )}
        {warType === 'race' && (
          <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400">
            Target score
            <input type="number" value={raceTarget} disabled={readOnly} onChange={e => setRaceTarget(e.target.value)}
              className="input w-24 py-1 text-sm" placeholder="25000" />
          </label>
        )}
      </div>

      {/* Public + private notes, side by side. Public shows in the war summary
          to all members; private is leads-only (e.g. negotiation details). */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Public note (visible to all members)</label>
          <textarea
            value={text}
            disabled={readOnly}
            onChange={e => setText(e.target.value)}
            rows={3}
            placeholder="Strategy / agreed terms / hit-list priorities…"
            className="input w-full text-sm"
          />
        </div>
        <div>
          <label className="flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-400 mb-1">
            <Lock className="w-3 h-3" /> Leads-only note (not shown to members)
          </label>
          <textarea
            value={privText}
            disabled={readOnly}
            onChange={e => setPrivText(e.target.value)}
            rows={3}
            placeholder="Negotiation details, terms not yet public…"
            className="input w-full text-sm"
          />
        </div>
      </div>
      <div className="flex items-center gap-3 mt-2">
        {readOnly && (
          <span className="text-xs text-gray-500 dark:text-gray-400 italic">Visitor mode — notes are read-only.</span>
        )}
        {!readOnly && <button onClick={handleSave} disabled={saving || !currentWar}
          className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2">
          {saving && <LoaderCircle className="animate-spin w-4 h-4" />} Save Notes
        </button>}
        {msg && <span className="text-xs text-green-600 dark:text-green-400">{msg}</span>}
        {saveError && <span className="text-xs text-red-500 dark:text-red-400">{saveError}</span>}
      </div>

      {/* Roll-call results */}
      <div className="mt-4">
        <div className="flex items-center justify-between mb-1.5">
          <h5 className="text-xs font-semibold text-gray-700 dark:text-gray-300">Roll Call Results</h5>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {rollCallRows.length} responded · {nonResponders.length} missing
          </span>
        </div>
        <RollCallResultsTable rows={rollCallRows} />
        {nonResponders.length > 0 && (
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            <span className="font-medium text-gray-600 dark:text-gray-300">Not yet responded:</span>{' '}
            {nonResponders.map(m => m.member_name || m.member_id).join(', ')}
          </p>
        )}
      </div>
    </div>
  )
}
