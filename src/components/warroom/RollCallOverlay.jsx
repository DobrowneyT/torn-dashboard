import { useState } from 'react'
import { Swords, LoaderCircle, X } from 'lucide-react'
import { config as appConfig } from '../../config'
import { AVAILABILITY_OPTIONS, formatTct, formatCountdown, warTypeBadge, validateRollCall } from '../../utils/rollCall'

// Blocking pre-war roll-call overlay. Members must submit to reach the War Room;
// leaders get a "Continue (leadership)" bypass so they can still reach settings.
// `existing` pre-fills the form when re-opened for editing.
export default function RollCallOverlay({
  currentWar, notes, existing, onSubmit, onClose, canBypass, editing, submitting, error,
}) {
  // Form state derived from `existing` (edit) or blank (first submit).
  const [onAtStart, setOnAtStart] = useState(
    existing ? (existing.on_at_start ? 'yes' : 'no') : null,
  )
  const [selfHosp, setSelfHosp] = useState(
    existing == null || existing.on_at_start ? null
      : existing.can_self_hospital ? 'yes' : (existing.needs_merc ? 'no_merc' : null),
  )
  const [availability, setAvailability] = useState(
    existing && !existing.on_at_start ? (existing.availability ?? '') : '',
  )
  const [localErr, setLocalErr] = useState(null)

  const notOn = onAtStart === 'no'
  const badge = warTypeBadge(notes)

  function handleSubmit() {
    const answers = {
      on_at_start:       onAtStart === 'yes',
      can_self_hospital: onAtStart === 'yes' ? null : selfHosp === 'yes',
      needs_merc:        onAtStart === 'yes' ? null : selfHosp === 'no_merc',
      availability:      onAtStart === 'yes' ? 'on_time' : (availability || null),
    }
    const v = validateRollCall(answers)
    if (!v.ok) { setLocalErr(v.error); return }
    setLocalErr(null)
    onSubmit(answers)
  }

  const Radio = ({ active, onClick, children }) => (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
        active
          ? 'bg-blue-600 border-blue-600 text-white'
          : 'border-gray-300 dark:border-slate-600 text-gray-600 dark:text-gray-300 hover:border-blue-400'
      }`}
    >
      {children}
    </button>
  )

  return (
    <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl max-w-lg w-full mx-4 max-h-[92vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
              <Swords className="w-5 h-5 text-red-500" />
              War Roll Call{editing ? ' — edit' : ''}
            </h3>
            {/* Close only available when not a hard gate (editing or leader bypass). */}
            {(editing || canBypass) && (
              <button onClick={onClose} className="p-1 rounded hover:bg-gray-100 dark:hover:bg-slate-700 text-gray-500 dark:text-gray-400">
                <X className="w-5 h-5" />
              </button>
            )}
          </div>

          {/* War summary header */}
          <div className="mb-4 p-3 rounded-lg bg-gray-50 dark:bg-slate-700/40 text-sm">
            <div className="font-semibold text-gray-900 dark:text-gray-100">
              {appConfig.faction.tag} vs {currentWar?.opponentName || `Faction ${currentWar?.opponentId}`}
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              Starts {formatTct(currentWar?.startAt)} · {formatCountdown(currentWar?.startAt)}
              {badge ? <span className="ml-2 text-amber-600 dark:text-amber-400 font-medium">● {badge}</span> : null}
            </div>
            {notes?.notes && <p className="text-xs text-gray-600 dark:text-gray-400 mt-1.5 whitespace-pre-wrap">{notes.notes}</p>}
          </div>

          <div className="space-y-4">
            <div>
              <p className="text-sm font-medium text-gray-800 dark:text-gray-200 mb-2">1) I will be on at the start</p>
              <div className="flex gap-2">
                <Radio active={onAtStart === 'yes'} onClick={() => setOnAtStart('yes')}>Yes</Radio>
                <Radio active={onAtStart === 'no'} onClick={() => setOnAtStart('no')}>No</Radio>
              </div>
            </div>

            {notOn && (
              <>
                <div>
                  <p className="text-sm font-medium text-gray-800 dark:text-gray-200 mb-2">2) Can you self-hospital at the start?</p>
                  <div className="flex flex-wrap gap-2">
                    <Radio active={selfHosp === 'yes'} onClick={() => setSelfHosp('yes')}>Yes</Radio>
                    <Radio active={selfHosp === 'no_merc'} onClick={() => setSelfHosp('no_merc')}>No, will need a merc hit</Radio>
                  </div>
                </div>
                <div>
                  <p className="text-sm font-medium text-gray-800 dark:text-gray-200 mb-2">3) When will you be available?</p>
                  <select
                    value={availability}
                    onChange={(e) => setAvailability(e.target.value)}
                    className="input w-full"
                  >
                    <option value="">Select…</option>
                    {AVAILABILITY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
              </>
            )}

            {(localErr || error) && (
              <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-600 dark:text-red-400">
                {localErr || error}
              </div>
            )}

            <button
              onClick={handleSubmit}
              disabled={submitting}
              className="btn-primary w-full disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting
                ? <span className="flex items-center justify-center"><LoaderCircle className="animate-spin h-5 w-5 mr-2" />Submitting…</span>
                : (editing ? 'Save Changes' : 'Submit Roll Call')}
            </button>

            {/* Leadership bypass — only when this is the hard gate (not edit mode). */}
            {canBypass && !editing && (
              <button
                onClick={onClose}
                className="w-full text-center text-xs text-gray-500 dark:text-gray-400 hover:underline"
              >
                Continue to War Room (leadership) ▸
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
