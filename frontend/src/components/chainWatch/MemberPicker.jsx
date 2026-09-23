import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { pickerOptions } from '../../utils/chainWatch'

/**
 * Put a named member into a slot (#772).
 *
 * ⚠️ Its own file, per the v3.97.0 crash: a panel declared inside the view it
 * serves and referenced from that view's callbacks is a temporal-dead-zone
 * throw that builds cleanly and dies on render.
 *
 * ⚠️ Whoever already holds the OTHER slot of this hour stays in the list,
 * disabled with the reason on their row, rather than being quietly dropped. A
 * leader hunting for a name that is simply missing concludes the picker is
 * broken. The database refuses the pairing anyway (#771): two watchers exist so
 * that one of them can fail, and the same person twice is that redundancy gone
 * while the grid still reads as covered.
 */
export default function MemberPicker({ roster, row, slotIndex, onPick, onClose }) {
  const [q, setQ] = useState('')
  const options = useMemo(() => pickerOptions(roster, row, slotIndex), [roster, row, slotIndex])
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return needle
      ? options.filter((o) => o.member_name?.toLowerCase().includes(needle))
      : options
  }, [options, q])

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-20"
      role="dialog" aria-modal="true" aria-label={`Assign a watcher to ${row.tct} TCT`}>
      <div className="card w-full max-w-sm space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-sm">
            {row.slots[slotIndex] ? 'Replace watcher' : 'Assign watcher'}
            <span className="ml-2 font-normal text-gray-400">{row.tct} TCT</span>
          </h3>
          <button type="button" onClick={onClose} aria-label="Close" className="text-gray-400 hover:text-gray-600">
            <X className="w-4 h-4" />
          </button>
        </div>

        <input
          id={`picker-search-${row.hourIso}-${slotIndex}`}
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search the roster"
          className="input w-full"
          aria-label="Search the roster"
        />

        <ul className="max-h-64 overflow-y-auto divide-y divide-gray-100 dark:divide-slate-700">
          {shown.map((o) => (
            <li key={o.member_id}>
              <button
                type="button"
                disabled={!!o.disabledReason}
                onClick={() => onPick(o.member_id)}
                className={`w-full text-left px-2 py-1.5 text-sm flex items-baseline justify-between gap-2 ${
                  o.disabledReason
                    ? 'text-gray-400 dark:text-gray-600 cursor-not-allowed'
                    : 'hover:bg-gray-50 dark:hover:bg-slate-700'
                }`}
              >
                <span>{o.member_name}</span>
                {o.disabledReason && (
                  <span className="text-[11px] italic shrink-0">{o.disabledReason}</span>
                )}
              </button>
            </li>
          ))}
          {shown.length === 0 && (
            <li className="px-2 py-3 text-sm text-gray-400">Nobody on the roster matches.</li>
          )}
        </ul>
      </div>
    </div>
  )
}
