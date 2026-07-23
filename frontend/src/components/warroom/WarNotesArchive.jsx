import { useState, useEffect } from 'react'
import { History, LoaderCircle, Lock, ChevronRight } from 'lucide-react'
import { apiGet } from '../../utils/apiClient'
import { formatTct, warTypeBadge } from '../../utils/rollCall'

// Leads-only browser for past wars' notes (#145). Rendered inside WarNotesPanel
// (already gated to warlead/leadership/admin), so no extra gate here. Read-only:
// lists every archived war newest-first by start date, each expandable to its
// public note plus the lazy-loaded leads-only private note.
export default function WarNotesArchive({ currentWarId }) {
  const [wars, setWars] = useState(null)      // null = loading, [] = none
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(null)  // war_id
  const [privateNotes, setPrivateNotes] = useState({})  // war_id -> text | 'loading'

  useEffect(() => {
    let on = true
    apiGet('/api/war-room/notes/archive')
      .then(r => { if (on) setWars(r.wars ?? []) })
      .catch(() => { if (on) setWars([]) })
    return () => { on = false }
  }, [])

  // Only genuinely past wars — the current matchup is edited in the panel above.
  const past = (wars ?? []).filter(w => Number(w.war_id) !== Number(currentWarId))

  async function toggle(warId) {
    const next = expanded === warId ? null : warId
    setExpanded(next)
    if (next != null && privateNotes[warId] === undefined) {
      setPrivateNotes(p => ({ ...p, [warId]: 'loading' }))
      try {
        const r = await apiGet(`/api/war-room/notes/${warId}/private`)
        setPrivateNotes(p => ({ ...p, [warId]: r?.notes ?? '' }))
      } catch {
        setPrivateNotes(p => ({ ...p, [warId]: '' }))
      }
    }
  }

  if (wars === null) {
    return (
      <div className="mt-4 pt-4 border-t border-gray-200 dark:border-slate-700 flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
        <LoaderCircle className="w-4 h-4 animate-spin" /> Loading past wars…
      </div>
    )
  }
  if (past.length === 0) return null

  return (
    <div className="mt-4 pt-4 border-t border-gray-200 dark:border-slate-700">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-200 hover:text-blue-600 dark:hover:text-blue-400"
        aria-expanded={open}
      >
        <History className="w-4 h-4" />
        Past Wars ({past.length})
        <ChevronRight className={`w-4 h-4 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>

      {open && (
        <div className="mt-3 space-y-2">
          {past.map(w => {
            const badge = warTypeBadge(w)
            const isOpen = expanded === w.war_id
            const priv = privateNotes[w.war_id]
            return (
              <div key={w.war_id} className="rounded-lg border border-gray-200 dark:border-slate-700">
                <button
                  onClick={() => toggle(w.war_id)}
                  className="w-full flex items-center justify-between gap-2 p-2.5 text-left hover:bg-gray-50 dark:hover:bg-slate-700/50 rounded-lg"
                >
                  <span className="min-w-0">
                    <span className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">
                      {w.opponent_name || (w.opponent_faction_id ? `Faction ${w.opponent_faction_id}` : `War #${w.war_id}`)}
                    </span>
                    <span className="block text-xs text-gray-500 dark:text-gray-400">
                      {w.start_at ? formatTct(Number(w.start_at)) : `War #${w.war_id}`}
                      {badge ? ` · ${badge}` : ''}
                    </span>
                  </span>
                  <ChevronRight className={`w-4 h-4 shrink-0 text-gray-400 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                </button>

                {isOpen && (
                  <div className="px-3 pb-3 space-y-2 text-sm">
                    <div>
                      <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Public note</div>
                      <p className="whitespace-pre-wrap text-gray-800 dark:text-gray-200">
                        {w.notes_public || <span className="italic text-gray-400">— none —</span>}
                      </p>
                    </div>
                    <div>
                      <div className="flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-400 mb-1">
                        <Lock className="w-3 h-3" /> Leads-only note
                      </div>
                      {priv === 'loading'
                        ? <span className="text-xs text-gray-400 inline-flex items-center gap-1"><LoaderCircle className="w-3 h-3 animate-spin" /> loading…</span>
                        : <p className="whitespace-pre-wrap text-gray-800 dark:text-gray-200">
                            {priv || <span className="italic text-gray-400">— none —</span>}
                          </p>}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
