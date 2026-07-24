// Dashboard cards for pinned competitions (#188). Renders one compact card per
// pinned competition — a leaderboard shows its top few, a lottery shows the
// qualified count. Links through to the Members → Competitions tab. Renders
// nothing when nothing is pinned. API-only, so the caller gates on API_MODE.
import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { apiGet } from '../utils/apiClient'
import { Trophy } from 'lucide-react'

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

          {c.type === 'lottery' ? (
            <div className="text-sm text-gray-600 dark:text-gray-300">
              <span className="text-2xl font-bold text-gray-900 dark:text-white">{c.qualified_count}</span> qualified
              <span className="text-gray-400"> ({c.threshold_comparator === 'lte' ? '≤' : '≥'} {c.threshold_value})</span>
            </div>
          ) : (
            <ol className="text-sm space-y-0.5">
              {(c.top || []).map((r) => (
                <li key={r.member_id} className="flex justify-between">
                  <span className="text-gray-700 dark:text-gray-300 truncate">{r.rank}. {r.member_name}</span>
                  <span className="font-medium text-gray-900 dark:text-white">{Number(r.value).toLocaleString()}</span>
                </li>
              ))}
              {(c.top || []).length === 0 && (
                <li className="text-xs text-gray-400">No data yet in this window.</li>
              )}
            </ol>
          )}
        </Link>
      ))}
    </div>
  )
}
