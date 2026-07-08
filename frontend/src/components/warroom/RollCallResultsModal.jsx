import { X } from 'lucide-react'
import RollCallResultsTable from './RollCallResultsTable'

// Popup launched from the summary card's roll-call counts.
//   mode 'responded' → who filled it out + their responses (sorted by name)
//   mode 'missing'   → who hasn't responded yet (sorted by name)
export default function RollCallResultsModal({ mode, rollCallRows = [], ourMembers = [], onClose }) {
  const respondedIds = new Set(rollCallRows.map(r => Number(r.member_id)))
  const missing = ourMembers
    .filter(m => !respondedIds.has(Number(m.member_id)))
    .sort((a, b) => (a.member_name || '').localeCompare(b.member_name || '', undefined, { sensitivity: 'base' }))

  const isMissing = mode === 'missing'
  const title = isMissing
    ? `Not yet responded (${missing.length})`
    : `Responded (${rollCallRows.length})`

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-white dark:bg-slate-800 rounded-lg shadow-xl max-w-lg w-full mx-4 max-h-[85vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
            <button onClick={onClose} className="p-1 rounded hover:bg-gray-100 dark:hover:bg-slate-700 text-gray-500 dark:text-gray-400">
              <X className="w-5 h-5" />
            </button>
          </div>

          {isMissing ? (
            missing.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">Everyone has responded. 🎉</p>
            ) : (
              <ul className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-sm text-gray-700 dark:text-gray-300">
                {missing.map(m => (
                  <li key={m.member_id} className="truncate">{m.member_name || m.member_id}</li>
                ))}
              </ul>
            )
          ) : (
            <RollCallResultsTable rows={rollCallRows} />
          )}
        </div>
      </div>
    </div>
  )
}
