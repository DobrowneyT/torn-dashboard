import { Swords, Clock } from 'lucide-react'
import { config as appConfig } from '../../config'
import { formatTct, formatCountdown, warTypeBadge, availabilityLabel } from '../../utils/rollCall'

// Compact "this week's war" summary shown to everyone in the War Room (and
// reused inside the roll-call overlay header). `mine` is the viewer's roll-call
// row (or null). `responded`/`total` drive the roll-call counts.
export default function WarSummaryCard({ currentWar, notes, responded = 0, total = 0, mine }) {
  if (!currentWar) return null
  const badge = warTypeBadge(notes)
  const missing = Math.max(0, total - responded)
  const oppUrl = `https://www.torn.com/factions.php?step=profile&ID=${currentWar.opponentId}`

  return (
    <div className="card mt-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
            <Swords className="w-4 h-4 text-red-500 shrink-0" />
            <span className="truncate">
              {appConfig.faction.tag} vs{' '}
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

      {notes?.notes && (
        <p className="mt-2 text-xs text-gray-600 dark:text-gray-400 whitespace-pre-wrap line-clamp-3">
          {notes.notes}
        </p>
      )}

      <div className="mt-2 flex items-center justify-between text-xs">
        <span className="text-gray-500 dark:text-gray-400">
          Roll call: <span className="font-semibold text-gray-700 dark:text-gray-300">{responded} in</span>
          {' · '}
          <span className={missing > 0 ? 'text-red-600 dark:text-red-400 font-semibold' : ''}>{missing} missing</span>
        </span>
        <span className="text-gray-500 dark:text-gray-400">
          {mine
            ? <>you: <span className="text-green-600 dark:text-green-400 font-medium">✓ {mine.on_at_start ? 'on time' : availabilityLabel(mine.availability)}</span></>
            : <span className="text-red-600 dark:text-red-400 font-medium">you haven’t responded</span>}
        </span>
      </div>
    </div>
  )
}
