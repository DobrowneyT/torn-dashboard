// The Book of Grudges (#889) — the page that holds the form and the list.
//
// ⚠️ Lives in the Members tab group, beside Chain Watch. The epic said "its own
// page, not a tab inside Halloween", and the reasoning was that the list is
// perpetual while an event page is the one place guaranteed to be cleared when
// the event ends. This group already holds the faction-wide, non-event
// surfaces — Chain Watch, Calendar, Upgrades — so it satisfies that without
// inventing a top-level section for one table.
import { useCallback, useEffect, useState } from 'react'
import { History, LoaderCircle, RefreshCw, Settings2, ShieldAlert } from 'lucide-react'
import { apiGet, apiPost } from '../../utils/apiClient'
import { useAuth } from '../../contexts/AuthContext'
import AddGrudgeForm from './AddGrudgeForm'
import GrudgeList from './GrudgeList'
import GrudgeSettings from './GrudgeSettings'
import GrudgeHistory from './GrudgeHistory'

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
  const [panel, setPanel] = useState(null)      // 'settings' | 'history' | null
  const [refreshedAt, setRefreshedAt] = useState(null)

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
      setRefreshedAt(Date.now())
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

  /**
   * Keep the board current.
   *
   * ⚠️ This polls OUR OWN API, which is a database read — not Torn. The Torn
   * side is the `grudge-refresh` job every fifteen minutes, and nothing here
   * can make it run faster. So a minute is generous for picking up what that
   * job wrote, and costs the stack almost nothing.
   *
   * ⚠️ The hospital countdowns do NOT depend on this: they tick locally from
   * the stored `until`. This poll is only for state the server has newly
   * learned — somebody discharged early, a target who changed faction.
   */
  useEffect(() => {
    const id = setInterval(() => { load() }, 60_000)
    return () => clearInterval(id)
  }, [load])

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

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button" onClick={load}
          className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-sm text-gray-700 hover:bg-gray-50 dark:border-slate-600 dark:text-gray-300 dark:hover:bg-slate-700"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Refresh
        </button>
        <button
          type="button" onClick={() => setPanel(panel === 'history' ? null : 'history')}
          className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-sm text-gray-700 hover:bg-gray-50 dark:border-slate-600 dark:text-gray-300 dark:hover:bg-slate-700"
        >
          <History className="h-3.5 w-3.5" aria-hidden="true" /> History
        </button>
        {isLeadership && (
          <button
            type="button" onClick={() => setPanel(panel === 'settings' ? null : 'settings')}
            className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-sm text-gray-700 hover:bg-gray-50 dark:border-slate-600 dark:text-gray-300 dark:hover:bg-slate-700"
          >
            <Settings2 className="h-3.5 w-3.5" aria-hidden="true" /> Settings
          </button>
        )}
        {refreshedAt && (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {/* refreshedAt is Date.now() — db-time-safe */}
            Updated {new Date(refreshedAt).toLocaleTimeString()}
          </span>
        )}
      </div>

      {panel === 'settings' && isLeadership && (
        <GrudgeSettings
          severities={settings.severities}
          watchedFactions={settings.watched_factions ?? []}
          onSaved={load}
        />
      )}
      {panel === 'history' && <GrudgeHistory />}

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
