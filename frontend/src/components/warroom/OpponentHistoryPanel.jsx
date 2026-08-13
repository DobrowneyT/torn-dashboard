/**
 * What happened last time we fought this faction (#398).
 *
 * Lives in the notes / roll-call area rather than the roster table: this is
 * pre-war planning reading, and the roster is already at eleven columns on our
 * side. It must not compete for space during a chain.
 *
 * ⚠️ The wording throughout is "war roster", never "faction". Torn's ranked-war
 * report held 77–100 rows per war in the real data, so a member who joined
 * mid-war or left before the report was cut is simply absent from it. On a
 * panel whose job is telling a lead who is new, overstating that to "their
 * faction last time" would be a confident, checkable lie.
 */
import { useEffect, useState } from 'react'
import { ChevronRight, LoaderCircle, Swords, UserPlus, UserMinus, Users } from 'lucide-react'
import { getOpponentHistory } from '../../utils/warRoomApiV2'
import { formatWarDateRange } from '../../utils/warPayoutCalculations'
import {
  warResult, RESULT_LABELS, headToHead, rosterDiff, topContributors, rollCallTurnout,
} from '../../utils/opponentHistory'

const RESULT_TONE = {
  won: 'text-green-600 dark:text-green-400',
  'won-forfeit': 'text-green-600 dark:text-green-400',
  lost: 'text-red-600 dark:text-red-400',
  'lost-forfeit': 'text-red-600 dark:text-red-400',
  unknown: 'text-gray-400',
}

const INITIAL_WARS_SHOWN = 5

export default function OpponentHistoryPanel({ currentWar, ourFactionId, enemyMembers = [] }) {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState({ loading: false, error: null, data: null })
  const [showAllWars, setShowAllWars] = useState(false)

  const opponentId = currentWar?.opponentId ?? null

  // Fetched on first open, not on mount. The War Room is already polling on a
  // 2 Hz floor during a war; history changes once a war and has no business
  // adding a request to every page load.
  useEffect(() => {
    if (!open || !opponentId || state.data || state.loading) return
    let cancelled = false
    setState((s) => ({ ...s, loading: true, error: null }))
    getOpponentHistory(opponentId)
      .then((res) => { if (!cancelled) setState({ loading: false, error: null, data: res }) })
      .catch((e) => { if (!cancelled) setState({ loading: false, error: e?.message || 'Could not load history', data: null }) })
    return () => { cancelled = true }
  }, [open, opponentId, state.data, state.loading])

  // Refetch when the opponent changes — a new war must not show the last one's
  // history sitting there looking current.
  useEffect(() => {
    setState({ loading: false, error: null, data: null })
    setShowAllWars(false)
  }, [opponentId])

  if (!opponentId) return null

  const wars = state.data?.wars ?? []
  const record = headToHead(wars, ourFactionId)
  const diff = rosterDiff(enemyMembers, state.data?.their_last_roster)
  const shown = showAllWars ? wars : wars.slice(0, INITIAL_WARS_SHOWN)

  return (
    <div className="mt-4 pt-4 border-t border-gray-200 dark:border-slate-700">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 text-left"
        aria-expanded={open}
      >
        <ChevronRight className={`w-4 h-4 transition-transform ${open ? 'rotate-90' : ''}`} />
        <Swords className="w-4 h-4 text-gray-400" />
        <span className="font-semibold">
          Previous matchups{currentWar?.opponentName ? ` vs ${currentWar.opponentName}` : ''}
        </span>
        {state.data && (
          <span className="ml-auto text-xs text-gray-500 dark:text-gray-400 tabular-nums">
            {record.total === 0
              ? 'first time'
              : `${record.won}–${record.lost}${record.unknown ? ` (+${record.unknown} unknown)` : ''}`}
          </span>
        )}
      </button>

      {open && (
        <div className="mt-3 space-y-4 text-sm">
          {state.loading && (
            <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400 text-xs">
              <LoaderCircle className="w-4 h-4 animate-spin" /> Loading history…
            </div>
          )}
          {state.error && (
            <div className="text-xs text-red-600 dark:text-red-400">{state.error}</div>
          )}

          {state.data && wars.length === 0 && (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              We have no record of fighting {currentWar?.opponentName || 'this faction'} before.
            </p>
          )}

          {shown.length > 0 && (
            <div className="space-y-2">
              {shown.map((war) => (
                <PastWar key={war.war_id} war={war} ourFactionId={ourFactionId} />
              ))}
              {wars.length > INITIAL_WARS_SHOWN && (
                <button
                  onClick={() => setShowAllWars(!showAllWars)}
                  className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                >
                  {showAllWars
                    ? 'Show fewer'
                    : `Show all ${wars.length} matchups`}
                </button>
              )}
            </div>
          )}

          {diff && <RosterDiff diff={diff} />}

          {state.data && wars.length > 0 && !diff && (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              No roster was recorded for the last matchup, so there is nothing to compare their
              current roster against.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function PastWar({ war, ourFactionId }) {
  const result = warResult(war, ourFactionId)
  const top = topContributors(war.our_contributions)
  const turnout = rollCallTurnout(war.roll_call)

  return (
    <div className="rounded border border-gray-200 dark:border-slate-700 p-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-xs text-gray-600 dark:text-gray-400">
          {formatWarDateRange(war.start_at, war.end_at)}
        </span>
        <span className="flex items-center gap-2 text-xs tabular-nums">
          <span>{Number(war.our_score ?? 0).toLocaleString()} – {Number(war.opponent_score ?? 0).toLocaleString()}</span>
          <span className={`font-semibold ${RESULT_TONE[result]}`}>{RESULT_LABELS[result]}</span>
        </span>
      </div>

      {top.length > 0 && (
        <div className="mt-1 text-xs text-gray-500 dark:text-gray-400 truncate">
          Our top scorers: {top.map((c) => `${c.member_name} (${Math.round(Number(c.score ?? 0)).toLocaleString()})`).join(', ')}
        </div>
      )}

      {turnout && (
        <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Roll call: {turnout.on} of {turnout.total} on at the start
        </div>
      )}

      {war.notes_public && (
        <div className="mt-2 text-xs whitespace-pre-wrap text-gray-700 dark:text-gray-300 border-l-2 border-gray-300 dark:border-slate-600 pl-2">
          {war.notes_public}
        </div>
      )}
    </div>
  )
}

function RosterDiff({ diff }) {
  return (
    <div className="pt-3 border-t border-gray-100 dark:border-slate-700">
      <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">
        Roster since the last matchup
      </div>
      {/* Always visible, never a tooltip: it changes what the numbers mean. */}
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
        Compared against their <strong>war roster</strong> from that war ({diff.previousSize} recorded),
        not their full faction — Torn&apos;s report can miss anyone who joined mid-war or left before
        it was cut.
      </p>

      <div className="space-y-2">
        <Group
          Icon={UserPlus}
          tone="text-amber-600 dark:text-amber-400"
          label={`New since last war (${diff.newMembers.length})`}
          members={diff.newMembers}
        />
        <Group
          Icon={UserMinus}
          tone="text-gray-500 dark:text-gray-400"
          label={`Not on the current roster (${diff.departed.length})`}
          members={diff.departed}
        />
        <Group
          Icon={Users}
          tone="text-gray-500 dark:text-gray-400"
          label={`Still here (${diff.returning.length})`}
          members={diff.returning}
          showGain
          collapsed
        />
      </div>
    </div>
  )
}

function Group({ Icon, tone, label, members, showGain = false, collapsed = false }) {
  const [open, setOpen] = useState(!collapsed)
  if (members.length === 0) {
    return (
      <div className={`flex items-center gap-2 text-xs ${tone}`}>
        <Icon className="w-3.5 h-3.5" /> {label}
      </div>
    )
  }
  return (
    <div>
      <button onClick={() => setOpen(!open)} className={`flex items-center gap-2 text-xs ${tone}`}>
        <ChevronRight className={`w-3 h-3 transition-transform ${open ? 'rotate-90' : ''}`} />
        <Icon className="w-3.5 h-3.5" /> {label}
      </button>
      {open && (
        <div className="mt-1 ml-5 flex flex-wrap gap-x-3 gap-y-1">
          {members.map((m) => (
            <span key={m.id} className="text-xs text-gray-600 dark:text-gray-300 whitespace-nowrap">
              {m.name}
              {m.level !== null && <span className="text-gray-400"> L{m.level}</span>}
              {showGain && m.levelGain !== null && m.levelGain !== 0 && (
                <span className="text-blue-600 dark:text-blue-400 tabular-nums">
                  {' '}{m.levelGain > 0 ? '+' : ''}{m.levelGain}
                </span>
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
