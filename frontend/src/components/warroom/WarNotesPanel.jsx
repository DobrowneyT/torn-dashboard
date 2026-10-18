import { useState, useEffect, useMemo } from 'react'
import { LoaderCircle, Lock, ChevronUp, ChevronDown, ChevronRight, ClipboardList, X, Plus, Copy, Check } from 'lucide-react'
import RollCallResultsTable from './RollCallResultsTable'
import WarNotesArchive from './WarNotesArchive'
import OpponentHistoryPanel from './OpponentHistoryPanel'
import { notePointsFromText, notePointsToText, rollCallTally } from '../../utils/rollCall'
import { splitChaseLists, formatChaseList } from '../../utils/rollCallChase'
import { withBattleStats } from '../../utils/warRoomBattleStats'
import { fmtAgo } from '../../utils/time'
import InfoTooltip from '../InfoTooltip'

// War Leaders only. War type / agreed scores / strategy notes + the embedded
// roll-call results table and a "not yet responded" list. Edited responses
// (revised=true) are highlighted so leaders notice changes.
// readOnly: rendered for visitors — all fields disabled, Save hidden.
export default function WarNotesPanel({ currentWar, notes, privateNotes = '', onSave, saving, saveError, rollCallRows = [], ourMembers = [], ourBattleStats = {}, enemyMembers = [], ourFactionId = null, readOnly = false }) {
  // Collapsed by default: the tally is the headline, the table is the detail.
  const [rollCallOpen, setRollCallOpen] = useState(false)
  const [warType, setWarType] = useState(notes?.war_type ?? 'real')
  const [termedUs, setTermedUs] = useState(notes?.termed_score_us ?? '')
  const [termedThem, setTermedThem] = useState(notes?.termed_score_them ?? '')
  const [raceTarget, setRaceTarget] = useState(notes?.race_target_score ?? '')
  // Public note is edited as a list of short points (#141) and stored as
  // newline-delimited text. A legacy free-text note splits into its lines;
  // always keep at least one (empty) row to type into.
  const [points, setPoints] = useState(() => {
    const p = notePointsFromText(notes?.notes_public)
    return p.length ? p : ['']
  })
  const [privText, setPrivText] = useState(privateNotes ?? '')
  const [msg, setMsg] = useState(null)

  // Live collaboration: the parent refreshes `notes`/`privateNotes` every few
  // seconds while the panel is open. Track unsaved local edits (`dirty`) and
  // which server version the editor is based on (`baseUpdatedAt`), so a
  // background refresh can adopt other leads' changes without clobbering
  // in-progress typing — and surface a banner when it can't safely merge.
  const [dirty, setDirty] = useState(false)
  const [baseUpdatedAt, setBaseUpdatedAt] = useState(notes?.updated_at ?? null)
  const [externalUpdate, setExternalUpdate] = useState(null)
  const touch = () => setDirty(true)

  function seedFrom(n, priv) {
    setWarType(n?.war_type ?? 'real')
    setTermedUs(n?.termed_score_us ?? '')
    setTermedThem(n?.termed_score_them ?? '')
    setRaceTarget(n?.race_target_score ?? '')
    const p = notePointsFromText(n?.notes_public)
    setPoints(p.length ? p : [''])
    setPrivText(priv ?? '')
    setBaseUpdatedAt(n?.updated_at ?? null)
    setExternalUpdate(null)
    setDirty(false)
  }

  const updatePoint = (i, v) => { touch(); setPoints(ps => ps.map((p, j) => (j === i ? v : p))) }
  const addPoint = () => { touch(); setPoints(ps => [...ps, '']) }
  const removePoint = (i) => { touch(); setPoints(ps => (ps.length > 1 ? ps.filter((_, j) => j !== i) : [''])) }
  const movePoint = (i, dir) => { touch(); setPoints(ps => {
    const j = i + dir
    if (j < 0 || j >= ps.length) return ps
    const next = ps.slice()
    ;[next[i], next[j]] = [next[j], next[i]]
    return next
  }) }

  async function handleSave() {
    setMsg(null)
    // Optimistically clear dirty so our own save (which bumps updated_at via the
    // parent refresh) is adopted rather than flagged as an external edit. On
    // failure (e.g. a 409 conflict) we restore it so the edits stay protected.
    setDirty(false)
    const ok = await onSave({
      opponent_faction_id: currentWar?.opponentId ?? null,
      war_type: warType,
      termed_score_us:   warType === 'termed' ? (Number(termedUs) || null) : null,
      termed_score_them: warType === 'termed' ? (Number(termedThem) || null) : null,
      race_target_score: warType === 'race' ? (Number(raceTarget) || null) : null,
      notes_public: notePointsToText(points) || null,
      notes_private: privText || null,
      // Lock against the version the editor is based on — if another lead saved
      // in the meantime the server returns a conflict instead of overwriting.
      expected_updated_at: baseUpdatedAt,
    })
    if (ok !== false) setMsg('Saved.')
    else setDirty(true)
  }

  // Adopt server-side changes while nobody's mid-edit (collaborative live view);
  // when the local editor is dirty and the server moved on, flag it instead of
  // clobbering — the lead loads the latest explicitly.
  useEffect(() => {
    if (!dirty) {
      seedFrom(notes, privateNotes)
    } else if ((notes?.updated_at ?? null) !== baseUpdatedAt) {
      setExternalUpdate({ by: notes?.updated_by_name || 'another lead' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes?.updated_at, privateNotes, dirty])

  const tally = rollCallTally(rollCallRows)
  const respondedIds = new Set(rollCallRows.map(r => Number(r.member_id)))
  // Two chase lists for the buttons below (MonChoon, 2026-10-03). Battle stats
  // are merged in here rather than expected on `ourMembers`: the roster the War
  // Room passes down is the raw poll result, and only the roster TABLE runs it
  // through `withBattleStats`. Without this every line would read "???".
  const chase = useMemo(
    () => splitChaseLists(withBattleStats(ourMembers, ourBattleStats), rollCallRows),
    [ourMembers, ourBattleStats, rollCallRows]
  )
  const [copied, setCopied] = useState(null)

  async function copyChase(kind) {
    const entries = kind === 'maybe' ? chase.maybe : chase.missing
    const title = kind === 'maybe' ? 'Maybe (not on at start, can self-hosp)' : 'Missing'
    try {
      await navigator.clipboard.writeText(formatChaseList(entries, { title }))
      setCopied(kind)
      setTimeout(() => setCopied(null), 2000)
    } catch {
      // ⚠️ Clipboard access can be refused (insecure context, denied
      // permission). Silence would look like the button is broken, so say so
      // where the label is.
      setCopied('error')
      setTimeout(() => setCopied(null), 3000)
    }
  }

  const nonResponders = ourMembers
    .filter(m => !respondedIds.has(Number(m.member_id)))
    .sort((a, b) => (a.member_name || '').localeCompare(b.member_name || '', undefined, { sensitivity: 'base' }))

  return (
    <div className="mt-4 pt-4 border-t border-gray-200 dark:border-slate-700">
      <div className="flex items-center justify-between mb-3 gap-2">
        <h4 className="text-sm font-semibold text-gray-800 dark:text-gray-200 flex items-center gap-1.5">
          War Notes &amp; Roll Call
          <InfoTooltip
            decoration="no-underline"
            className="inline-flex items-center gap-1 text-[10px] font-normal text-green-600 dark:text-green-400"
            label={<><span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" /> live</>}
          >
            Live — edits by other war leads refresh automatically.
          </InfoTooltip>
        </h4>
        {notes?.updated_at && (
          <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0">
            updated {fmtAgo(notes.updated_at)}{notes.updated_by_name ? ` by ${notes.updated_by_name}` : ''}
          </span>
        )}
      </div>

      {externalUpdate && !readOnly && (
        <div className="mb-3 flex items-center justify-between gap-2 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-3 py-2">
          <span className="text-xs text-amber-800 dark:text-amber-200">
            <strong>{externalUpdate.by}</strong> edited these notes while you were typing.
          </span>
          <button
            type="button"
            onClick={() => seedFrom(notes, privateNotes)}
            className="text-xs font-semibold text-amber-800 dark:text-amber-200 hover:underline whitespace-nowrap"
          >
            Load their version (discards your unsaved edits)
          </button>
        </div>
      )}

      {!currentWar && (
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
          No matched war detected yet. Notes can be saved once a war is set up.
        </p>
      )}
      {currentWar?.endAt ? (
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
          This war has ended. You can still correct its type and notes; changing the type updates the member reports already posted.
        </p>
      ) : null}

      {/* War type + scores */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <span className="text-xs font-medium text-gray-500 dark:text-gray-400 mr-1">Type:</span>
        {['real', 'termed', 'race'].map(t => (
          <button key={t} type="button" disabled={readOnly} onClick={() => { touch(); setWarType(t) }}
            className={`px-2.5 py-1 rounded-full text-xs font-medium capitalize transition-colors ${
              warType === t ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-slate-600'
            }`}>
            {t}
          </button>
        ))}
        {warType === 'termed' && (
          <>
            <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400">
              Us
              <input type="number" value={termedUs} disabled={readOnly} onChange={e => { touch(); setTermedUs(e.target.value) }}
                className="input w-24 py-1 text-sm" placeholder="15500" />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400">
              Them
              <input type="number" value={termedThem} disabled={readOnly} onChange={e => { touch(); setTermedThem(e.target.value) }}
                className="input w-24 py-1 text-sm" placeholder="7200" />
            </label>
          </>
        )}
        {warType === 'race' && (
          <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400">
            Target score
            <input type="number" value={raceTarget} disabled={readOnly} onChange={e => { touch(); setRaceTarget(e.target.value) }}
              className="input w-24 py-1 text-sm" placeholder="25000" />
          </label>
        )}
      </div>

      {/* Public + private notes, side by side. Public shows in the war summary
          to all members; private is leads-only (e.g. negotiation details). */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Public points (visible to all members)</label>
          <div className="space-y-1.5">
            {points.map((p, i) => (
              <div key={i} className="flex items-center gap-1">
                <span className="text-gray-400 text-xs w-3 text-center">•</span>
                <input
                  type="text"
                  value={p}
                  disabled={readOnly}
                  onChange={e => updatePoint(i, e.target.value)}
                  placeholder="One short, important point…"
                  className="input flex-1 py-1 text-sm"
                />
                {!readOnly && (
                  <div className="flex items-center shrink-0">
                    <button type="button" onClick={() => movePoint(i, -1)} disabled={i === 0}
                      className="p-1 text-gray-400 hover:text-blue-600 disabled:opacity-30 disabled:cursor-not-allowed" aria-label="Move up">
                      <ChevronUp className="w-4 h-4" />
                    </button>
                    <button type="button" onClick={() => movePoint(i, 1)} disabled={i === points.length - 1}
                      className="p-1 text-gray-400 hover:text-blue-600 disabled:opacity-30 disabled:cursor-not-allowed" aria-label="Move down">
                      <ChevronDown className="w-4 h-4" />
                    </button>
                    <button type="button" onClick={() => removePoint(i)}
                      className="p-1 text-gray-400 hover:text-red-500" aria-label="Remove point">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
          {!readOnly && (
            <button type="button" onClick={addPoint}
              className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline">
              <Plus className="w-3.5 h-3.5" /> Add point
            </button>
          )}
        </div>
        <div>
          <label className="flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-400 mb-1">
            <Lock className="w-3 h-3" /> Leads-only note (not shown to members)
          </label>
          <textarea
            value={privText}
            disabled={readOnly}
            onChange={e => { touch(); setPrivText(e.target.value) }}
            rows={3}
            placeholder="Negotiation details, terms not yet public…"
            className="input w-full text-sm"
          />
        </div>
      </div>
      <div className="flex items-center gap-3 mt-2">
        {readOnly && (
          <span className="text-xs text-gray-500 dark:text-gray-400 italic">Visitor mode — notes are read-only.</span>
        )}
        {!readOnly && <button onClick={handleSave} disabled={saving || !currentWar}
          className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2">
          {saving && <LoaderCircle className="animate-spin w-4 h-4" />} Save Notes
        </button>}
        {msg && <span className="text-xs text-green-600 dark:text-green-400">{msg}</span>}
        {saveError && <span className="text-xs text-red-500 dark:text-red-400">{saveError}</span>}
      </div>

      {/* Roll-call results — collapsed to a tally, matching Past Wars below.
          The full table is a row per respondent and pushed the archive off
          screen on a 90-member faction; the headline numbers are what a lead
          actually reads, and the names are one click away when they matter. */}
      <div className="mt-4">
        <button
          onClick={() => setRollCallOpen(o => !o)}
          className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-200 hover:text-blue-600 dark:hover:text-blue-400"
          aria-expanded={rollCallOpen}
        >
          <ClipboardList className="w-4 h-4" />
          <span>
            Roll Call
            <span className="ml-2 font-normal text-gray-600 dark:text-gray-400">
              <span className="text-green-600 dark:text-green-400 font-medium">{tally.yes}</span> Yes
              {' · '}
              <span className="text-red-600 dark:text-red-400 font-medium">{tally.no}</span> No
              {nonResponders.length > 0 && ` (${nonResponders.length} missing)`}
            </span>
          </span>
          <ChevronRight className={`w-4 h-4 transition-transform ${rollCallOpen ? 'rotate-90' : ''}`} />
        </button>

        {rollCallOpen && (
          <div className="mt-2">
            {/* ⚠️ Two buttons, two lists, deliberately not one. "No to the
                start" is not the same question as "not coming": somebody who
                said no to the start but yes to self-hospitalising needs a ping
                five minutes before the war, and somebody who said no to both
                needs replacing. A single list of every "no" mixes the people
                worth chasing in with the people worth writing off. */}
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => copyChase('missing')}
                disabled={chase.missing.length === 0}
                className="inline-flex items-center gap-1.5 rounded border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:hover:bg-transparent dark:border-slate-600 dark:text-gray-200 dark:hover:bg-slate-700"
                title="Copy everyone not turning up: no response, not available, or needs a merc"
              >
                {copied === 'missing' ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
                Copy missing ({chase.missing.length})
              </button>
              <button
                type="button"
                onClick={() => copyChase('maybe')}
                disabled={chase.maybe.length === 0}
                className="inline-flex items-center gap-1.5 rounded border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:hover:bg-transparent dark:border-slate-600 dark:text-gray-200 dark:hover:bg-slate-700"
                title="Copy the maybes: said no to the start but can self-hospitalise, so worth checking just before the war"
              >
                {copied === 'maybe' ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
                Copy maybes ({chase.maybe.length})
              </button>
              <InfoTooltip label={<span className="text-xs text-gray-400 dark:text-gray-500">what's the difference?</span>}>
                <div><b>Missing</b> — no response, said they are not available, or need a merc. They are not getting themselves in.</div>
                <div className="mt-1.5"><b>Maybes</b> — said no to the start but <i>can</i> self-hospitalise. Check them 5–10 minutes before the war; if they have not hospitalised yet, chase them.</div>
                <div className="mt-1.5">Both copy as name, ID, battle stats and a profile link — one per line, strongest first.</div>
              </InfoTooltip>
              {copied === 'error' && (
                <span className="text-xs text-red-600 dark:text-red-400">Could not reach the clipboard — copy from the table instead.</span>
              )}
            </div>
            <RollCallResultsTable rows={rollCallRows} />
            {nonResponders.length > 0 && (
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                <span className="font-medium text-gray-600 dark:text-gray-300">Not yet responded:</span>{' '}
                {nonResponders.map(m => m.member_name || m.member_id).join(', ')}
              </p>
            )}
          </div>
        )}
      </div>

      {/* What happened last time we fought this faction (#398). Pre-war reading,
          so it sits here with the notes rather than in the roster table. */}
      <OpponentHistoryPanel
        currentWar={currentWar}
        ourFactionId={ourFactionId}
        enemyMembers={enemyMembers}
      />

      {/* Leads-only archive of past wars' notes & negotiations (#145). */}
      <WarNotesArchive currentWarId={currentWar?.id} />
    </div>
  )
}
