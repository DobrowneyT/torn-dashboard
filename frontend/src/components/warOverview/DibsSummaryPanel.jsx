import SortableTh, { useTableSort } from '../SortableTh.jsx'
import { InfoDot } from '../InfoTooltip'
import { fmtAgo } from '../../utils/time'

/**
 * Who called what in one war, and what came of it (#530).
 *
 * ⚠️ **Every number here has a member's name next to it**, so the panel is
 * built to be argued with rather than trusted. Three things follow from that:
 *
 *  1. **The columns add up.** Claims = Converted + Tried + No swing + Taken
 *     from + Outside + Other, exactly, for every row. A leaderboard whose
 *     total does not reconcile is one nobody can check.
 *  2. **The blameless column is visible, not hidden.** `Outside` is the target
 *     going down with no attack from our faction — another faction, or the
 *     target **self-hospitalising to dodge**, which looks identical to a steal
 *     in the data. Folding it into a failure column would accuse people of
 *     something the data does not support.
 *  3. **Every column says what it means**, on the header, including what it
 *     cannot tell you.
 *
 * ⚠️ `Took from others` is a DIFFERENT AXIS from `Taken from`, not its mirror.
 * One is the holder losing a target, the other is this member finishing
 * somebody else's. A member can lead both columns in the same war, and the
 * "who steals targets" question is the second one.
 */

// ⚠️ Every column declares `kind`. `compareValues` falls through to TEXT when
// it does not, which sorts 1, 10, 11, 2 and renders perfectly while doing it
// (#872 — the Hall of Fame shipped exactly that). `sortColumnKinds` enforces it.
const COLUMNS = [
  { key: 'member', kind: 'text', accessor: (r) => r.member_name || `id ${r.member_id}` },
  { key: 'claims', kind: 'number', accessor: (r) => r.claims },
  { key: 'converted', kind: 'number', accessor: (r) => r.converted },
  { key: 'attempted', kind: 'number', accessor: (r) => r.attempted },
  { key: 'no_swing', kind: 'number', accessor: (r) => r.no_swing },
  { key: 'taken_from', kind: 'number', accessor: (r) => r.taken_from },
  { key: 'outside', kind: 'number', accessor: (r) => r.outside },
  { key: 'other', kind: 'number', accessor: (r) => otherCount(r) },
  { key: 'green', kind: 'number', accessor: (r) => greenCount(r) },
  { key: 'took_from_others', kind: 'number', accessor: (r) => r.took_from_others },
]

/**
 * The buckets that are neither a conversion nor a failure to convert.
 *
 * ⚠️ Collapsed for width, never dropped — without it the row stops adding up to
 * `claims`, and the first thing anybody does with a number about themselves is
 * check the arithmetic. `unknown` is in here too: pre-#530 claims carry no
 * reason at all, and they must land somewhere visible rather than be silently
 * excluded from the total.
 */
export function otherCount(r) {
  return (r.released ?? 0) + (r.hopped ?? 0) + (r.overridden ?? 0)
    + (r.board_reset ?? 0) + (r.still_open ?? 0) + (r.unknown ?? 0)
}

/**
 * Claims on a target who was GREEN — Okay and online — while they were live
 * (#935).
 *
 * ⚠️ Its OWN column rather than folded into `Other`, even though that keeps the
 * table at nine. This is the number a lead points at when somebody says their
 * dibs was taken: a green target is outside the dibs system, so the claim had
 * stopped reserving them. Buried in `Other` it answers nothing, and settling
 * that argument is the reason the data is collected.
 */
export function greenCount(r) {
  return r.green_means_go ?? 0
}

const HELP = {
  claims: 'Targets this member called in this war.',
  converted: 'They called it and landed the finishing hit.',
  attempted: 'They called it and swung, but lost the fight. They turned up.',
  no_swing: 'The target surfaced, they had their head start, and the window '
    + 'lapsed with the target still standing and nobody of ours having hit. '
    + 'This is the "did not follow through" column.',
  taken_from: 'A teammate landed the finishing hit on a target this member had '
    + 'called. ⚠️ Only counts once the claim had been live long enough to reach '
    + 'other screens — somebody who clicked attack in the same instant raced, '
    + 'and is not counted here.',
  outside: 'The target went down with NO attack from our faction: another '
    + 'faction got them, or they hospitalised themselves to dodge. ⚠️ Not a '
    + 'failure, and not a steal — the two are indistinguishable in the data, so '
    + 'neither is claimed.',
  other: 'Released deliberately, swapped for another target, released by a '
    + 'lead, cleared with the board at war setup, still held when the war '
    + 'ended, or — for claims from before this was recorded — simply unknown.',
  green: 'The target was Okay AND online while this claim was live — either '
    + 'when it was taken, or by the time they came out of hospital. ⚠️ A green '
    + 'player is outside the dibs system: they are at their keyboard and can '
    + 'fly out or hospital themselves, so hitting them fast is encouraged. '
    + 'Nobody can steal a green target, so these claims count against no one '
    + 'on either side — and this is the column to point at when somebody says '
    + 'their dibs was taken.',
  took_from_others: 'Finishing hits this member landed on somebody ELSE\'s '
    + 'called target. ⚠️ A different question from "Taken from", not its '
    + 'mirror: this is the one that answers who takes other people\'s targets.',
}

const Num = ({ v, tone = '' }) => (
  <td className={`px-3 py-1.5 text-right tabular-nums ${tone}`}>
    {v ? v.toLocaleString() : <span className="text-gray-300 dark:text-gray-600">0</span>}
  </td>
)

export default function DibsSummaryPanel({ members = [], state = null, loading = false }) {
  const { sorted, sortCol, sortDir, onSort } = useTableSort(members, COLUMNS, {
    initialCol: 'claims', initialDir: 'desc', tieBreak: 'member',
  })

  const th = (col, children, help) => (
    <SortableTh
      col={col} sortCol={sortCol} sortDir={sortDir} onSort={onSort}
      label={typeof children === 'string' ? children : col}
      className={col === 'member' ? 'text-left' : 'text-right'}
      info={help}
    >
      {children}
    </SortableTh>
  )

  return (
    <div className="mt-4 rounded-lg border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-900/50">
      <div className="flex items-baseline justify-between gap-3 px-3 py-2 border-b border-gray-200 dark:border-slate-700">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
          Dibs
          <InfoDot>
            Who called targets in this war and what came of each claim. Counted
            once, after the war, from the claims and the attacks that actually
            landed. ⚠️ Every row adds up: Claims = Converted + Tried + No swing
            + Taken from + Outside + Other.
          </InfoDot>
        </h3>
        {state?.computed_at && (
          // ⚠️ Raw timestamptz through fmtAgo, never `new Date()` — pg returns
          // `...+00`, which `new Date` reads as NaN (#140).
          // db-time-safe: fmtAgo parses it via parseDbTime.
          <span className="text-xs text-gray-500 dark:text-gray-400">
            counted {fmtAgo(state.computed_at)}
          </span>
        )}
      </div>

      {loading ? (
        <p className="px-3 py-3 text-sm text-gray-500 dark:text-gray-400 italic">Loading…</p>
      ) : state == null ? (
        /* ⚠️ NOT the same as "no activity", and must not read as it. The count
           waits until the war's attacks have landed — up to half an hour after
           it ends, because attacks are scraped every 30 minutes — and a war
           counted early would record real conversions as "no swing" against
           named members. */
        <p className="px-3 py-3 text-sm text-amber-700 dark:text-amber-300 italic">
          Not counted yet. This happens once the war&rsquo;s attacks have landed,
          which can take a while after it ends — counting early would blame
          people for hits we have not stored.
        </p>
      ) : sorted.length === 0 ? (
        <p className="px-3 py-3 text-sm text-gray-500 dark:text-gray-400 italic">
          Nobody called a target in this war.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-gray-100 dark:bg-slate-700/40 text-gray-500 dark:text-gray-400">
                {th('member', 'Member')}
                {th('claims', 'Claims', HELP.claims)}
                {th('converted', 'Converted', HELP.converted)}
                {th('attempted', 'Tried', HELP.attempted)}
                {th('no_swing', 'No swing', HELP.no_swing)}
                {th('taken_from', 'Taken from', HELP.taken_from)}
                {th('outside', 'Outside', HELP.outside)}
                {th('other', 'Other', HELP.other)}
                {th('green', 'Green', HELP.green)}
                {th('took_from_others', 'Took from others', HELP.took_from_others)}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr
                  key={r.member_id}
                  className="border-t border-gray-200 dark:border-slate-700"
                >
                  <td className="px-3 py-1.5 whitespace-nowrap">
                    <span className="text-gray-900 dark:text-white">
                      {r.member_name || `id ${r.member_id}`}
                    </span>
                    <span className="text-gray-400 dark:text-gray-500"> [{r.member_id}]</span>
                  </td>
                  <Num v={r.claims} tone="font-semibold text-gray-700 dark:text-gray-200" />
                  <Num v={r.converted} tone="text-emerald-600 dark:text-emerald-400" />
                  <Num v={r.attempted} tone="text-gray-600 dark:text-gray-300" />
                  <Num v={r.no_swing} tone="text-amber-600 dark:text-amber-400" />
                  <Num v={r.taken_from} tone="text-red-600 dark:text-red-400" />
                  {/* ⚠️ Deliberately NOT toned as a problem — nobody's fault. */}
                  <Num v={r.outside} tone="text-gray-500 dark:text-gray-400" />
                  <Num v={otherCount(r)} tone="text-gray-500 dark:text-gray-400" />
                  {/* ⚠️ Toned as information, not as a problem — a green claim
                      is nobody's fault and often nobody's mistake either. */}
                  <Num v={greenCount(r)} tone="text-sky-600 dark:text-sky-400" />
                  <Num v={r.took_from_others} tone="text-orange-600 dark:text-orange-400" />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {state?.grace_seconds != null && sorted.length > 0 && (
        // ⚠️ The tunable that produced these numbers, shown with them. Two wars
        // counted under different grace windows are not comparable, and a figure
        // about a named member should say what rule produced it.
        <p className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400 border-t border-gray-200 dark:border-slate-700">
          A teammate&rsquo;s hit counts as taking a target only after a claim has
          been live {state.grace_seconds}s — anything faster is treated as a race,
          not a steal.
        </p>
      )}
    </div>
  )
}
