// The Book of Grudges list (#889, slice 3).
//
// ⚠️ Battle stats, Fair Fight and live status are all EMPTY until slice 4.
// Every one of them needs a Torn call, and every Torn call in this epic waits
// on the API Key Usage disclosure update and the forced re-accept (#894). The
// columns render an em dash with an explanation rather than being hidden, so
// the gap reads as "not switched on yet" instead of "scrape is broken".
//
// ⚠️ Not coupled to the War Room. `fairFight.js` and `warRoomFarmSort.js` are
// import-free leaf modules and will be imported directly when slice 4/5 land;
// nothing here reads war-room state.
import { useMemo, useState } from 'react'
import { Swords, Trash2, Pencil, ShieldAlert, X, Check } from 'lucide-react'
import SortableTh, { useTableSort } from '../SortableTh.jsx'
import { apiDelete, apiPatch } from '../../utils/apiClient'

/** Torn's own attack loader. Opened in a new tab so the list survives. */
const attackUrl = (id) => `https://www.torn.com/loader.php?sid=attack&user2ID=${id}`
const profileUrl = (id) => `https://www.torn.com/profiles.php?XID=${id}`

const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString())

/**
 * ⚠️ EVERY column states its `kind`.
 *
 * `compareValues` falls through to a TEXT comparison when one does not, which
 * is how the Hall of Fame shipped sorting `1, 10, 11 … 2` and
 * `9.77, 9.32, 77.35`. There is now a `sortColumnKinds` guard that fails the
 * build for a column with an accessor and no kind — this list is written to
 * satisfy it rather than to discover it.
 */
const COLUMNS = [
  { key: 'name', accessor: (r) => r.target_name || r.target_id, kind: 'text' },
  { key: 'battle_stats', accessor: (r) => r.battle_stats ?? null, kind: 'number' },
  { key: 'severity', accessor: (r) => r.severityLabel ?? null, kind: 'text' },
  { key: 'status', accessor: (r) => r.status_state ?? null, kind: 'text' },
  // ⚠️ Null sinks in BOTH directions: a target with no recorded hospital time
  // is not "out soonest", they are unknown (#351).
  { key: 'until', accessor: (r) => r.status_until ?? null, kind: 'number' },
  { key: 'added', accessor: (r) => r.added_ms ?? null, kind: 'number' },
]

export default function GrudgeList({
  targets = [], severities = [], viewerId, isLeadership, onChanged,
}) {
  const [hideHospital, setHideHospital] = useState(false)
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const severityLabel = useMemo(() => {
    const byId = new Map(severities.map((s) => [String(s.id), s.label]))
    return (id) => (id == null ? null : byId.get(String(id)) ?? String(id))
  }, [severities])

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return targets
      .map((t) => ({
        ...t,
        // Highest configured severity across this target's grudges drives the
        // column, since one target may carry several.
        severityLabel: t.grudges?.map((g) => severityLabel(g.severity_id)).find(Boolean) ?? null,
      }))
      .filter((t) => {
        // ⚠️ "Hospital" only. Someone abroad or in jail is also unattackable,
        // but the ask was specifically about hospital and conflating them would
        // silently hide targets a member may still want to see.
        if (hideHospital && t.status_state === 'Hospital') return false
        if (!q) return true
        const hay = [
          t.target_name, t.target_id, t.faction_name,
          ...(t.grudges ?? []).map((g) => `${g.reason} ${g.member_name ?? ''}`),
        ].filter(Boolean).join(' ').toLowerCase()
        return hay.includes(q)
      })
  }, [targets, query, hideHospital, severityLabel])

  const { sorted, sortCol, sortDir, onSort } = useTableSort(rows, COLUMNS, {
    initialCol: 'added', initialDir: 'desc', tieBreak: ['name'],
  })

  const saveEdit = async (entryId) => {
    setBusy(true)
    try {
      await apiPatch(`/api/grudges/entries/${entryId}`, { reason: draft })
      setEditing(null); setDraft('')
      onChanged?.()
    } finally { setBusy(false) }
  }

  const removeEntry = async (entryId) => {
    setBusy(true)
    try {
      await apiDelete(`/api/grudges/entries/${entryId}`)
      onChanged?.()
    } finally { setBusy(false) }
  }

  const removeTarget = async (rowId) => {
    setBusy(true)
    try {
      await apiDelete(`/api/grudges/targets/${rowId}`)
      onChanged?.()
    } finally { setBusy(false) }
  }

  const canModify = (g) => isLeadership || String(g.member_id) === String(viewerId)

  if (targets.length === 0) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400">
        The book is empty. Nobody has wronged anybody yet, which seems unlikely.
      </p>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by name, faction or reason"
          aria-label="Filter the list"
          className="min-w-[16rem] flex-1 rounded border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-gray-100"
        />
        <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
          <input type="checkbox" checked={hideHospital} onChange={(e) => setHideHospital(e.target.checked)} />
          Hide anyone in hospital
        </label>
        <span className="text-sm text-gray-500 dark:text-gray-400">
          {sorted.length} of {targets.length}
        </span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-slate-700">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500 dark:bg-slate-800 dark:text-gray-400">
              <SortableTh col="name" sortCol={sortCol} sortDir={sortDir} onSort={onSort} className="px-3 py-2">Target</SortableTh>
              <SortableTh col="battle_stats" sortCol={sortCol} sortDir={sortDir} onSort={onSort} className="px-3 py-2 text-right">Battle stats</SortableTh>
              <SortableTh col="severity" sortCol={sortCol} sortDir={sortDir} onSort={onSort} className="px-3 py-2">Severity</SortableTh>
              <SortableTh col="status" sortCol={sortCol} sortDir={sortDir} onSort={onSort} className="px-3 py-2">Status</SortableTh>
              <th className="px-3 py-2 font-medium">Grudges</th>
              <th className="px-3 py-2 font-medium text-right">Attack</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((t, i) => (
              <tr key={t.id} className={`border-t border-gray-100 align-top dark:border-slate-700 ${i % 2 ? 'bg-gray-50/50 dark:bg-slate-800/40' : ''}`}>
                <td className="px-3 py-2">
                  <a href={profileUrl(t.target_id)} target="_blank" rel="noopener noreferrer"
                     className="font-medium text-blue-600 hover:underline dark:text-blue-400">
                    {t.target_name || t.target_id}
                  </a>
                  {t.faction_name && (
                    <div className="text-xs text-gray-500 dark:text-gray-400">{t.faction_name}</div>
                  )}
                  {t.state === 'pending_approval' && (
                    <div className="mt-1 inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                      <ShieldAlert className="h-3 w-3" aria-hidden="true" /> Awaiting approval
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">
                  {fmt(t.battle_stats)}
                  {t.stats_source && (
                    <div className="text-xs font-sans text-gray-500 dark:text-gray-400">{t.stats_source}</div>
                  )}
                </td>
                <td className="px-3 py-2">{t.severityLabel ?? '—'}</td>
                <td className="px-3 py-2">{t.status_state ?? '—'}</td>
                <td className="px-3 py-2">
                  <ul className="space-y-1">
                    {(t.grudges ?? []).map((g) => (
                      <li key={g.id} className="text-gray-700 dark:text-gray-300">
                        {editing === g.id ? (
                          <span className="flex items-center gap-1">
                            <input
                              value={draft} onChange={(e) => setDraft(e.target.value)}
                              aria-label="Edit reason"
                              className="flex-1 rounded border border-gray-300 px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-900"
                            />
                            <button type="button" onClick={() => saveEdit(g.id)} disabled={busy || draft.trim() === ''} aria-label="Save">
                              <Check className="h-4 w-4 text-emerald-600" />
                            </button>
                            <button type="button" onClick={() => { setEditing(null); setDraft('') }} aria-label="Cancel">
                              <X className="h-4 w-4 text-gray-500" />
                            </button>
                          </span>
                        ) : (
                          <span className="flex items-start gap-1">
                            <span className="flex-1">
                              {g.reason}
                              <span className="text-xs text-gray-500 dark:text-gray-400"> — {g.member_name || g.member_id}</span>
                            </span>
                            {canModify(g) && (
                              <>
                                <button type="button" onClick={() => { setEditing(g.id); setDraft(g.reason) }}
                                        aria-label={`Edit grudge by ${g.member_name || g.member_id}`}>
                                  <Pencil className="h-3.5 w-3.5 text-gray-400 hover:text-gray-600" />
                                </button>
                                <button type="button" onClick={() => removeEntry(g.id)} disabled={busy}
                                        aria-label={`Remove grudge by ${g.member_name || g.member_id}`}>
                                  <Trash2 className="h-3.5 w-3.5 text-gray-400 hover:text-red-600" />
                                </button>
                              </>
                            )}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </td>
                <td className="px-3 py-2 text-right">
                  <a href={attackUrl(t.target_id)} target="_blank" rel="noopener noreferrer"
                     className="inline-flex items-center gap-1 rounded bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700">
                    <Swords className="h-3 w-3" aria-hidden="true" /> Attack
                  </a>
                  {isLeadership && (
                    <button type="button" onClick={() => removeTarget(t.id)} disabled={busy}
                            className="ml-2 text-xs text-gray-400 hover:text-red-600" aria-label={`Remove ${t.target_name || t.target_id} entirely`}>
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-gray-500 dark:text-gray-400">
        Battle stats and live status are not being fetched yet — that needs a change to
        what member API keys are used for, which has to be disclosed and re-accepted first.
      </p>
    </div>
  )
}
