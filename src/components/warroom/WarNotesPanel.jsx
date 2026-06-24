import { useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { availabilityLabel } from '../../utils/rollCall'

// War Leaders only. War type / agreed scores / strategy notes + the embedded
// roll-call results table and a "not yet responded" list. Edited responses
// (revised=true) are highlighted so leaders notice changes.
export default function WarNotesPanel({ currentWar, notes, onSave, saving, saveError, rollCallRows = [], ourMembers = [] }) {
  const [warType, setWarType] = useState(notes?.war_type ?? 'real')
  const [termedScore, setTermedScore] = useState(notes?.termed_score ?? '')
  const [raceTarget, setRaceTarget] = useState(notes?.race_target_score ?? '')
  const [text, setText] = useState(notes?.notes ?? '')
  const [msg, setMsg] = useState(null)

  async function handleSave() {
    setMsg(null)
    await onSave({
      opponent_faction_id: currentWar?.opponentId ?? null,
      war_type: warType,
      termed_score: warType === 'termed' ? (Number(termedScore) || null) : null,
      race_target_score: warType === 'race' ? (Number(raceTarget) || null) : null,
      notes: text || null,
    })
    setMsg('Saved.')
  }

  const respondedIds = new Set(rollCallRows.map(r => Number(r.member_id)))
  const nonResponders = ourMembers.filter(m => !respondedIds.has(Number(m.member_id)))

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
          <button key={t} type="button" onClick={() => setWarType(t)}
            className={`px-2.5 py-1 rounded-full text-xs font-medium capitalize transition-colors ${
              warType === t ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-slate-600'
            }`}>
            {t}
          </button>
        ))}
        {warType === 'termed' && (
          <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400">
            Agreed score
            <input type="number" value={termedScore} onChange={e => setTermedScore(e.target.value)}
              className="input w-24 py-1 text-sm" placeholder="5000" />
          </label>
        )}
        {warType === 'race' && (
          <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400">
            Target score
            <input type="number" value={raceTarget} onChange={e => setRaceTarget(e.target.value)}
              className="input w-24 py-1 text-sm" placeholder="25000" />
          </label>
        )}
      </div>

      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        rows={3}
        placeholder="Strategy / agreed terms / hit-list priorities…"
        className="input w-full text-sm"
      />
      <div className="flex items-center gap-3 mt-2">
        <button onClick={handleSave} disabled={saving || !currentWar}
          className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2">
          {saving && <LoaderCircle className="animate-spin w-4 h-4" />} Save Notes
        </button>
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
        <div className="rounded-lg border border-gray-200 dark:border-slate-600 overflow-hidden overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-gray-50 dark:bg-slate-700/40 text-left text-gray-500 dark:text-gray-400">
                <th className="px-3 py-1.5 font-medium">Member</th>
                <th className="px-3 py-1.5 font-medium">Start</th>
                <th className="px-3 py-1.5 font-medium">Self-hosp</th>
                <th className="px-3 py-1.5 font-medium">Availability</th>
              </tr>
            </thead>
            <tbody>
              {rollCallRows.length === 0 ? (
                <tr><td colSpan={4} className="px-3 py-2 text-gray-500 dark:text-gray-400">No responses yet.</td></tr>
              ) : rollCallRows.map(r => (
                <tr key={r.member_id} className={`border-t border-gray-100 dark:border-slate-700 ${r.revised ? 'bg-amber-50 dark:bg-amber-900/20' : ''}`}>
                  <td className="px-3 py-1.5 text-gray-700 dark:text-gray-300">
                    {r.member_name || r.member_id}
                    {r.revised && <span className="ml-1.5 text-[10px] px-1 py-0.5 rounded bg-amber-200 dark:bg-amber-800 text-amber-800 dark:text-amber-200">edited</span>}
                  </td>
                  <td className="px-3 py-1.5">{r.on_at_start ? <span className="text-green-600 dark:text-green-400">Yes</span> : <span className="text-red-600 dark:text-red-400">No</span>}</td>
                  <td className="px-3 py-1.5 text-gray-600 dark:text-gray-400">{r.on_at_start ? '—' : (r.can_self_hospital ? 'Yes' : (r.needs_merc ? 'No (merc)' : '—'))}</td>
                  <td className="px-3 py-1.5 text-gray-600 dark:text-gray-400">{availabilityLabel(r.availability)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
