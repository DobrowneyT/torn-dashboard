/**
 * Pick which crimes the simulator compares, and in what order (#445).
 *
 * MonChoon: *"a popout modal that contains all of the crimes and organized them
 * by type [Elaborate, Advanced, Intermediate, etc.] Then, allow me to select the
 * crimes in order that I want to display... it enumerates them as I am checking
 * them off."*
 *
 * ⚠️ The enumeration is not decoration. Selection order IS display order, so the
 * badge on each ticked crime is showing the user the thing they are choosing.
 * Nothing here re-sorts the selection.
 */
import { useEffect, useMemo, useState } from 'react'
import { X, Check } from 'lucide-react'
import {
  groupByCategory, toggleSelection, selectionIndex, selectionScopeCost,
  toggleCategory, categoryFullySelected,
} from '../../utils/ocCrimeSelection'
import InfoTooltip from '../InfoTooltip'

export default function CrimePickerModal({ scenarios, selected, onApply, onClose }) {
  // Edited locally and applied on close, so an accidental untick is
  // recoverable with Cancel rather than instantly rearranging the page behind
  // the modal.
  const [draft, setDraft] = useState(selected ?? [])

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const groups = useMemo(() => groupByCategory(scenarios), [scenarios])
  const scopeCost = useMemo(() => selectionScopeCost(scenarios, draft), [scenarios, draft])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-slate-800 rounded-lg shadow-xl w-full max-w-3xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Choose crimes to compare"
      >
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-slate-700">
          <div>
            <h3 className="text-lg font-semibold">Choose crimes to compare</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              They appear on the page in the order you tick them.
            </p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100 dark:hover:bg-slate-700" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="overflow-y-auto p-4 space-y-5 flex-1">
          {groups.length === 0 && (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              No crimes mirrored yet — the nightly <code>oc-scenarios-mirror</code> job populates
              this list.
            </p>
          )}

          {groups.map((group) => (
            <div key={group.key}>
              <div className="flex items-baseline gap-2 mb-2">
                <h4 className="text-sm font-semibold">{group.label}</h4>
                {group.scopeCost != null && (
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    {group.scopeCost} scope to spawn
                  </span>
                )}
                <span className="text-xs text-gray-400">{group.crimes.length}</span>
                {/* ⚠️ #730: the joint solve is the only view that tells the
                    truth about a whole category, and reaching it meant ticking
                    five crimes by hand. At a uniform 75 Forge's five Advanced
                    crimes want 198 seats against a 94-member roster — that is
                    the number this button exists to make reachable. */}
                <button
                  type="button"
                  onClick={() => setDraft((d) => toggleCategory(d, group.crimes.map((c) => c.name)))}
                  className="ml-auto text-xs underline text-blue-600 dark:text-blue-400"
                >
                  {categoryFullySelected(draft, group.crimes.map((c) => c.name))
                    ? `Clear ${group.label}`
                    : `Select all ${group.label}`}
                </button>
              </div>
              <div className="grid gap-1 sm:grid-cols-2">
                {group.crimes.map((crime) => {
                  const index = selectionIndex(draft, crime.name)
                  return (
                    <button
                      key={crime.name}
                      onClick={() => setDraft((d) => toggleSelection(d, crime.name))}
                      className={`flex items-center gap-2 px-2 py-1.5 rounded text-left text-sm border transition-colors ${
                        index
                          ? 'border-blue-400 bg-blue-50 dark:bg-blue-900/30 dark:border-blue-600'
                          : 'border-transparent hover:bg-gray-50 dark:hover:bg-slate-700/50'
                      }`}
                      aria-pressed={!!index}
                    >
                      {/* The enumeration: position in the selection, not a tick,
                          because the number is the information. */}
                      <span className={`w-5 h-5 shrink-0 rounded flex items-center justify-center text-[11px] font-semibold ${
                        index
                          ? 'bg-blue-600 text-white'
                          : 'border border-gray-300 dark:border-slate-600'
                      }`}>
                        {index ?? ''}
                      </span>
                      <span className="truncate">{crime.name}</span>
                      {/* wrap: this sits inside the crime-row button, so the
                          trigger cannot be a button of its own, and a tap has
                          to keep selecting the crime. */}
                      {crime.is_complete === false && (
                        <InfoTooltip wrap className="ml-auto shrink-0" label={
                          <span className="text-[10px] text-amber-600 dark:text-amber-400">wip</span>
                        }>
                          The upstream probability model for this crime is still in
                          progress.
                        </InfoTooltip>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between gap-3 p-4 border-t border-gray-200 dark:border-slate-700">
          <div className="text-xs text-gray-500 dark:text-gray-400">
            {draft.length} selected
            {/* Null means one selected crime has an unknown category, so the
                total would be quietly short — say nothing rather than mislead. */}
            {scopeCost != null && draft.length > 0 && (
              <> · {scopeCost} scope to spawn one of each</>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setDraft([])}
              disabled={draft.length === 0}
              className="px-3 py-1.5 text-sm rounded border border-gray-300 dark:border-slate-600 disabled:opacity-40"
            >
              Clear
            </button>
            <button onClick={onClose} className="px-3 py-1.5 text-sm rounded border border-gray-300 dark:border-slate-600">
              Cancel
            </button>
            <button
              onClick={() => { onApply(draft); onClose() }}
              className="btn-primary px-3 py-1.5 text-sm flex items-center gap-1"
            >
              <Check className="w-4 h-4" /> Show these
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
