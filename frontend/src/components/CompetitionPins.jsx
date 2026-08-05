// Dashboard cards for pinned competitions (#188). Renders one compact card per
// pinned competition — a leaderboard shows its top few plus the viewing member's
// own position (#242), a lottery shows the qualified count plus the member's own
// score + qualified status. Links through to the Members → Competitions tab.
// Renders nothing when nothing is pinned.
import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { apiGet } from '../utils/apiClient'
import { Trophy } from 'lucide-react'
import { ownRowMode, lotteryOwnStatus } from '../utils/competitionPins'

export default function CompetitionPins() {
  const [pins, setPins] = useState([])

  useEffect(() => {
    apiGet('/api/competitions/pinned')
      .then(({ competitions }) => setPins(competitions || []))
      .catch(() => setPins([]))
  }, [])

  if (pins.length === 0) return null

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 mb-6">
      {pins.map((c) => (
        <Link
          key={c.id}
          to="/members/competitions"
          className="card hover:ring-2 hover:ring-blue-500/40 transition-shadow block"
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-2">
              <Trophy className="w-4 h-4 text-amber-500" /> {c.name}
            </span>
            {c.type === 'lottery' && (
              <span className="px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300 text-[10px] font-semibold">lottery</span>
            )}
          </div>

          {c.type === 'lottery' ? <LotteryBody c={c} /> : <LeaderboardBody c={c} />}
        </Link>
      ))}
    </div>
  )
}

// Leaderboard card: the top rows, with the viewer's own row highlighted in place
// when they're inside the top, or appended as a "you" row when they're outside.
function LeaderboardBody({ c }) {
  const top = c.top || []
  const me = c.me || null
  const mode = ownRowMode(top, me)

  if (top.length === 0) {
    return <ol className="text-sm space-y-0.5"><li className="text-xs text-gray-400">No data yet in this window.</li></ol>
  }
  return (
    <ol className="text-sm space-y-0.5">
      {top.map((r) => {
        const mine = mode === 'highlight' && me && r.rank === me.rank
        return (
          <li key={r.member_id} className={`flex justify-between ${mine ? 'font-semibold text-blue-700 dark:text-blue-300' : ''}`}>
            <span className={`truncate ${mine ? '' : 'text-gray-700 dark:text-gray-300'}`}>{r.rank}. {r.member_name}{mine ? ' (you)' : ''}</span>
            <span className={mine ? '' : 'font-medium text-gray-900 dark:text-white'}>{Number(r.value).toLocaleString()}</span>
          </li>
        )
      })}
      {mode === 'append' && (
        <li className="flex justify-between border-t border-gray-200 dark:border-slate-700 mt-1 pt-1 font-semibold text-blue-700 dark:text-blue-300">
          <span className="truncate">you: #{me.rank}</span>
          <span>{Number(me.value).toLocaleString()}</span>
        </li>
      )}
      {mode === 'none' && (
        <li className="text-xs text-gray-400 border-t border-gray-200 dark:border-slate-700 mt-1 pt-1">you: no data yet</li>
      )}
    </ol>
  )
}

// Lottery card: the qualified count, plus the viewer's own score + qualified /
// not-yet status against the threshold.
function LotteryBody({ c }) {
  const status = lotteryOwnStatus(c.me || null, c)
  return (
    <div className="text-sm text-gray-600 dark:text-gray-300">
      <div>
        <span className="text-2xl font-bold text-gray-900 dark:text-white">{c.qualified_count}</span> qualified
        <span className="text-gray-400"> ({c.threshold_comparator === 'lte' ? '≤' : '≥'} {Number(c.threshold_value).toLocaleString()})</span>
      </div>
      <div className={`text-xs mt-1 pt-1 border-t border-gray-200 dark:border-slate-700 ${
        status.qualified === true ? 'text-green-600 dark:text-green-400 font-semibold'
        : status.qualified === false ? 'text-gray-500 dark:text-gray-400'
        : 'text-gray-400'}`}>
        you: {status.text}
      </div>
    </div>
  )
}
