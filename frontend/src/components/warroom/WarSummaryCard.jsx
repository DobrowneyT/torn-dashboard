import { useState } from 'react'
import { getFactionIdentity } from '../../utils/factionIdentity'
import { Swords, Clock } from 'lucide-react'
import { formatTct, formatCountdown, warTypeBadge, availabilityLabel, notePointsFromText } from '../../utils/rollCall'
import { fmtAgo } from '../../utils/time'
import RollCallResultsModal from './RollCallResultsModal'

// Compact "this week's war" summary shown to everyone in the War Room (and
// reused inside the roll-call overlay header). `mine` is the viewer's roll-call
// row (or null). The "in / missing" counts are clickable → a modal listing who
// responded (with answers) or who hasn't.
export default function WarSummaryCard({ currentWar, notes, rollCallRows = [], ourMembers = [], mine, embedded = false }) {
  const [modalMode, setModalMode] = useState(null)  // 'responded' | 'missing' | null
  if (!currentWar) return null
  const badge = warTypeBadge(notes)
  const responded = rollCallRows.length
  const total = ourMembers.length
  const missing = Math.max(0, total - responded)
  const oppUrl = `https://www.torn.com/factions.php?step=profile&ID=${currentWar.opponentId}`

  // `embedded` renders it as a section inside the top card (with a divider);
  // otherwise it's a standalone card.
  return (
    <div className={embedded ? 'mt-4 pt-4 border-t border-gray-200 dark:border-slate-700' : 'card mt-3'}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
            <Swords className="w-4 h-4 text-red-500 shrink-0" />
            <span className="truncate">
              {getFactionIdentity().tag} vs{' '}
              <a href={oppUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline">
                {currentWar.opponentName || `Faction ${currentWar.opponentId}`}
              </a>
            </span>
            <span className="text-xs font-normal text-gray-400">#{currentWar.id}</span>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 mt-1">
            <Clock className="w-3.5 h-3.5 shrink-0" />
            Starts {formatTct(currentWar.startAt)} · {formatCountdown(currentWar.startAt)}
          </div>
        </div>
        {badge && (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500" /> {badge}
          </span>
        )}
      </div>

      {(() => {
        const bullets = notePointsFromText(notes?.notes_public)
        if (bullets.length === 0) return null
        return (
          <div className="mt-2">
            {/* Every point shown in full (no clipping) — members must not miss
                war instructions; scrolls only past ~10 points (#141). */}
            <ul className="text-xs text-gray-600 dark:text-gray-400 space-y-0.5 max-h-40 overflow-y-auto">
              {bullets.map((b, i) => (
                <li key={i} className="flex gap-1.5">
                  <span className="text-gray-400 shrink-0">•</span>
                  <span className="min-w-0 break-words">{b}</span>
                </li>
              ))}
            </ul>
            {notes?.updated_at && (
              <div className="mt-1 text-[10px] text-gray-400 dark:text-gray-500">updated {fmtAgo(notes.updated_at)}</div>
            )}
          </div>
        )
      })()}

      <div className="mt-2 flex items-center justify-between text-xs">
        <span className="text-gray-500 dark:text-gray-400">
          Roll call:{' '}
          <button
            onClick={() => setModalMode('responded')}
            className="font-semibold text-gray-700 dark:text-gray-300 hover:underline"
          >
            {responded} in
          </button>
          {' · '}
          <button
            onClick={() => setModalMode('missing')}
            className={`hover:underline ${missing > 0 ? 'text-red-600 dark:text-red-400 font-semibold' : ''}`}
          >
            {missing} missing
          </button>
        </span>
        <span className="text-gray-500 dark:text-gray-400">
          {mine
            ? <>you: <span className="text-green-600 dark:text-green-400 font-medium">✓ {mine.on_at_start ? 'on time' : availabilityLabel(mine.availability)}</span></>
            : <span className="text-red-600 dark:text-red-400 font-medium">you haven’t responded</span>}
        </span>
      </div>

      {modalMode && (
        <RollCallResultsModal
          mode={modalMode}
          rollCallRows={rollCallRows}
          ourMembers={ourMembers}
          onClose={() => setModalMode(null)}
        />
      )}
    </div>
  )
}
