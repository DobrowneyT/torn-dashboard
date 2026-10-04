/**
 * Members → Hall of Fame (#872).
 *
 * Where everyone sits in the faction, and where that sits in Torn.
 *
 * ⚠️ **This is a bragging-rights board, not an assessment.** Singularity
 * [2573844], asked whether it was for screening applicants, spotting anomalies
 * or measuring against other factions: *"no it was more so to promote
 * competition within the faction, bit of bragging rights"*.
 *
 * That rules things out as much as in. No thresholds, no compliance colouring,
 * no amber "inconclusive" states, and deliberately **no reuse of the Member
 * Overview's machinery** — importing its components would drag the assessment
 * framing in with them. A leaderboard that implies judgement stops being fun
 * and starts being a performance review.
 *
 * ⚠️ `battle_stats` is absent because Torn returns it as null for anyone but
 * the requester. A roster-wide battle-stats board cannot be built by anyone,
 * and the server excludes the category rather than send an empty column — a
 * blank would read as a scrape failure.
 */
import { useEffect, useMemo, useState } from 'react'
import { LoaderCircle, Trophy } from 'lucide-react'
import { apiGet } from '../../utils/apiClient'
import InfoTooltip from '../InfoTooltip'
import SortableTh, { useTableSort } from '../SortableTh.jsx'

/** Torn's category keys are snake_case; these are what people call them. */
const LABELS = {
  working_stats: 'Working stats',
  networth: 'Net worth',
  attacks: 'Attacks won',
  defends: 'Defends won',
  busts: 'Busts',
  revives: 'Revives',
  offences: 'Offences',
  level: 'Level',
  rank: 'Rank',
  awards: 'Awards',
  racing_skill: 'Racing skill',
  racing_points: 'Racing points',
  racing_wins: 'Racing wins',
  travel_time: 'Travel time',
}

const label = (c) => LABELS[c] ?? c.replace(/_/g, ' ')

/**
 * Units, where the bare number does not say what it is.
 *
 * ⚠️ Travel time is SECONDS, straight from Torn's own spec rather than
 * inferred: `/swagger/openapi.json` documents the hall-of-fame value as
 * *"Value representing the chosen category. Traveltime is shown in seconds."*
 * Worth stating, because the live figures are all exact multiples of 86,400
 * — whole days — which reads much more like a day count than a second count
 * and would be a very easy thing to label wrongly from the data alone.
 *
 * Only on the column header. The category picker stays unadorned; a unit in a
 * chip is noise when you are choosing a board, not reading one.
 */
const UNITS = { travel_time: 'seconds' }
const unitSuffix = (c) => (UNITS[c] ? ` (${UNITS[c]})` : '')
const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString())

/** "3rd", "48,000th" — an ordinal reads as a position where a bare number does not. */
function ordinal(n) {
  if (n == null) return null
  const v = Number(n)
  if (!Number.isFinite(v)) return null
  const s = ['th', 'st', 'nd', 'rd']
  const m = v % 100
  return `${v.toLocaleString()}${s[(m - 20) % 10] ?? s[m] ?? s[0]}`
}

/**
 * ⚠️ The board arrives already ranked, but it is still a data table and the
 * #840 guard is right to insist. Sorting by global rank answers a different
 * question from sorting by value — "who is highest placed in Torn" rather than
 * "who has the biggest number" — and on a ties-share-a-position board those
 * are not the same order.
 */
// ⚠️ **Every column states its kind.** `compareValues` falls through to TEXT
// when none is given, so a numeric column that omits it sorts lexically and
// says nothing about it: the board came out `1, 10, 11 … 19, 2, 20` and
// `9.77, 9.32, 8.94, 77.35, 7.91`. Nothing about the declaration looked wrong,
// which is the whole problem — the accessor returns a number, the header sorts,
// and the order is quietly meaningless.
const BOARD_COLUMNS = [
  { key: 'factionRank', accessor: r => r.factionRank, kind: 'number' },
  { key: 'memberName', accessor: r => r.memberName, kind: 'text' },
  { key: 'value', accessor: r => r.value, kind: 'number' },
  // ⚠️ Null sinks in BOTH directions: a member Torn gave no global rank for is
  // not "worst placed", they are unplaced (#351).
  { key: 'globalRank', accessor: r => r.globalRank ?? null, kind: 'number' },
]

export default function HofSection() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [category, setCategory] = useState(null)

  useEffect(() => {
    let on = true
    apiGet('/api/members/hof')
      .then(d => { if (on) { setData(d); setCategory(d.categories?.[0]?.category ?? null) } })
      .catch(e => { if (on) setError(e?.message || 'Could not load the Hall of Fame') })
    return () => { on = false }
  }, [])

  const board = useMemo(
    () => data?.categories?.find(c => c.category === category)?.rows ?? [],
    [data, category]
  )
  const { sorted, sortCol, sortDir, onSort } = useTableSort(board, BOARD_COLUMNS, {
    initialCol: 'factionRank', tieBreak: 'memberName',
  })

  if (error) return <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
  if (!data) {
    return (
      <p className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
        <LoaderCircle className="h-4 w-4 animate-spin" /> Loading the Hall of Fame…
      </p>
    )
  }

  // ⚠️ No snapshot yet is a normal state. The sweep runs once a day, so a
  // tenant that joined today genuinely has nothing until tomorrow.
  if (!data.categories?.length) {
    return (
      <div className="card">
        <h3 className="font-semibold">Hall of Fame</h3>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
          No standings yet. These are read from Torn once a day, so the board fills
          in after the next run.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="flex items-center gap-2 font-semibold">
            <Trophy className="h-5 w-5 text-amber-500" />
            Hall of Fame
            <InfoTooltip label={<span className="text-xs font-normal text-gray-400">how to read it</span>}>
              <div>Where each member sits <b>in the faction</b>, with their position in
                <b> all of Torn</b> beside it.</div>
              {/* ⚠️ Named, because its absence is otherwise a mystery that gets
                  reported as a bug. */}
              <div className="mt-1.5">Battle stats are not here: Torn only reports those
                to you about yourself, so no faction-wide battle-stat board is possible.</div>
              <div className="mt-1.5">Members we have no reading for are left out rather
                than ranked last.</div>
            </InfoTooltip>
          </h3>
          <p className="text-xs text-gray-400 dark:text-gray-500">
            {data.memberCount} members · as of {data.snapshotDate}
          </p>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {data.categories.map(c => (
            <button
              key={c.category}
              type="button"
              onClick={() => setCategory(c.category)}
              aria-pressed={category === c.category}
              className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                category === c.category
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-slate-700 dark:text-gray-300 dark:hover:bg-slate-600'
              }`}
            >
              {label(c.category)}
            </button>
          ))}
        </div>
      </div>

      <div className="card p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500 dark:bg-slate-800 dark:text-gray-400">
                <SortableTh col="factionRank" sortCol={sortCol} sortDir={sortDir} onSort={onSort} className="px-3 py-2 w-16">#</SortableTh>
                <SortableTh col="memberName"  sortCol={sortCol} sortDir={sortDir} onSort={onSort} className="px-3 py-2">Member</SortableTh>
                <SortableTh col="value"       sortCol={sortCol} sortDir={sortDir} onSort={onSort} className="px-3 py-2 text-right" label={label(category)}>{label(category)}{unitSuffix(category)}</SortableTh>
                <SortableTh col="globalRank"  sortCol={sortCol} sortDir={sortDir} onSort={onSort} className="px-3 py-2 text-right">In Torn</SortableTh>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, i) => (
                <tr
                  key={r.memberId}
                  className={`border-t border-gray-100 dark:border-slate-700 ${
                    i % 2 ? 'bg-gray-50/50 dark:bg-slate-800/40' : ''
                  }`}
                >
                  {/* Top three get a tint. It is a leaderboard; that is the point. */}
                  <td className={`px-3 py-1.5 font-mono tabular-nums ${
                    r.factionRank <= 3 ? 'font-bold text-amber-600 dark:text-amber-400' : 'text-gray-500'
                  }`}>{r.factionRank}</td>
                  <td className="px-3 py-1.5">
                    <a
                      href={`https://www.torn.com/profiles.php?XID=${r.memberId}`}
                      target="_blank" rel="noopener noreferrer"
                      className="font-medium text-blue-600 hover:underline dark:text-blue-400"
                    >{r.memberName}</a>
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums">{fmt(r.value)}</td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums text-gray-500 dark:text-gray-400">
                    {/* ⚠️ "—" when Torn gave no global rank, never a 0 or a
                        guess. A fabricated position on a board people quote at
                        each other is worse than an honest gap. */}
                    {ordinal(r.globalRank) ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
