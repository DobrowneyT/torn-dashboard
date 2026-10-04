// The Book of Grudges (#889) — the page that holds the form and the list.
//
// ⚠️ Lives in the Members tab group, beside Chain Watch. The epic said "its own
// page, not a tab inside Halloween", and the reasoning was that the list is
// perpetual while an event page is the one place guaranteed to be cleared when
// the event ends. This group already holds the faction-wide, non-event
// surfaces — Chain Watch, Calendar, Upgrades — so it satisfies that without
// inventing a top-level section for one table.
import { useCallback, useEffect, useState } from 'react'
import { LoaderCircle, ShieldAlert } from 'lucide-react'
import { apiGet, apiPost } from '../../utils/apiClient'
import { useAuth } from '../../contexts/AuthContext'
import AddGrudgeForm from './AddGrudgeForm'
import GrudgeList from './GrudgeList'

export default function GrudgesSection({ isLeadership = false }) {
  const [data, setData] = useState(null)
  const [settings, setSettings] = useState({ severities: [] })
  const [pending, setPending] = useState([])
  const [error, setError] = useState(null)
  // ⚠️ The viewer's OWN battle stats, for the personal FF column. Fetched
  // once, not with the list: it moves twice a week, and the list reloads on
  // every edit. A failure here is not a page failure — FF simply shows a dash,
  // which is the honest outcome for "we cannot work it out".
  const [myBattleStats, setMyBattleStats] = useState(null)

  useEffect(() => {
    let on = true
    apiGet('/api/members/me/battle-stats')
      .then((r) => { if (on) setMyBattleStats(r?.battle_stats ?? null) })
      .catch(() => { if (on) setMyBattleStats(null) })
    return () => { on = false }
  }, [])

  const { user } = useAuth()
  const viewerId = user?.id ?? null

  const load = useCallback(async () => {
    try {
      const [list, cfg] = await Promise.all([
        apiGet('/api/grudges'),
        apiGet('/api/grudges/settings'),
      ])
      setData(list)
      setSettings(cfg)
      if (isLeadership) {
        // ⚠️ Leadership-only, and a failure here must not blank the list —
        // the queue is a side panel, not the page.
        try {
          const q = await apiGet('/api/grudges/pending')
          setPending(q.pending ?? [])
        } catch { setPending([]) }
      }
    } catch (e) {
      setError(e?.message || 'Could not load the Book of Grudges')
    }
  }, [isLeadership])

  useEffect(() => { load() }, [load])

  const rule = async (id, verb) => {
    await apiPost(`/api/grudges/targets/${id}/${verb}`, {})
    await load()
  }

  if (error) return <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
  if (!data) {
    return (
      <p className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
        <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> Opening the book…
      </p>
    )
  }

  return (
    <div className="space-y-6">
      {/* ⚠️ The approval queue sits ABOVE the list for leadership. It is the
          one thing on this page that is waiting on a person, and a notification
          nobody sees is not a notification. */}
      {isLeadership && pending.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-700 dark:bg-amber-900/20">
          <h3 className="flex items-center gap-2 font-semibold text-amber-900 dark:text-amber-200">
            <ShieldAlert className="h-4 w-4" aria-hidden="true" />
            {pending.length} {pending.length === 1 ? 'target needs' : 'targets need'} your approval
          </h3>
          <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">
            These are in a watched faction, so they are not on the list until you say so.
          </p>
          <ul className="mt-3 space-y-2">
            {pending.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-2 text-sm">
                <a href={`https://www.torn.com/profiles.php?XID=${p.target_id}`}
                   target="_blank" rel="noopener noreferrer"
                   className="font-medium text-blue-700 hover:underline dark:text-blue-300">
                  {p.target_name || p.target_id}
                </a>
                <span className="text-amber-800 dark:text-amber-300">
                  added by {p.added_by}
                </span>
                <button type="button" onClick={() => rule(p.id, 'approve')}
                        className="rounded bg-emerald-600 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-700">
                  Approve
                </button>
                <button type="button" onClick={() => rule(p.id, 'reject')}
                        className="rounded bg-gray-600 px-2 py-1 text-xs font-medium text-white hover:bg-gray-700">
                  Reject
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <AddGrudgeForm severities={settings.severities} onAdded={load} />

      <GrudgeList
        targets={data.targets}
        severities={settings.severities}
        viewerId={viewerId}
        isLeadership={isLeadership}
        myBattleStats={myBattleStats}
        onChanged={load}
      />
    </div>
  )
}
