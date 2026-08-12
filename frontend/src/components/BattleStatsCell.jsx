import { fmtAgo } from '../utils/time'
import { formatStats } from '../utils/statInput'
import { statsSourceLabel, isExactStatsSource } from '../utils/warRoomBattleStats'

// Shared battle-stats cell (#353, extracted in #355).
//
// Lifted out of WarRoomViewV2 so Member Overview shows the SAME cell rather
// than a lookalike. The exact-vs-estimate distinction is the part that must not
// be restated: an own-key reading is measured, TornStats and BSP are guesses,
// and a page that renders them identically invites a lead to size up a target
// against a number nobody ever measured.
//
// The age now comes from fmtAgo (utils/time), which already handles the bare
// "+00"/"-05" offset Postgres emits and JS Date rejects — the #140 trap that
// made this very cell show a dash next to a real ts_spy_at.

// Hover tooltip on a member's BSP total — shows the per-stat breakdown
// (str/dex/spd/def), total, and "{relative age} ({TS|BSP})" so leadership
// can see at a glance how trustworthy the number is. CSS-only show/hide via
// the `group-hover` Tailwind variant (no JS state, no portal).
//
// Behaviour by row state:
//   - `m.bsp_total == null` → render dim "???", no tooltip.
//   - TornStats source AND ts_spy_at present → age from ts_spy_at, "(TS)".
//   - BSP source (or unknown) → age from bsp_fetched_at, "(BSP)".
//   - Own-key source (#353, our own roster only) → age from bsp_fetched_at,
//     "(OWN)". This one is EXACT rather than an estimate, so it is the only
//     source that gets a solid underline instead of the dotted "this is a
//     guess" treatment.
//   - Breakdown rows render only when the corresponding field is non-null
//     so BSP-only rows (often no per-stat) just show Total + source.
export default function BattleStatsCell({ member: m }) {
  if (m.bsp_total === null || m.bsp_total === undefined) {
    return (
      <span className="font-mono text-xs text-gray-400 dark:text-gray-600 italic">
        ???
      </span>
    )
  }

  const isTs = m.spy_source === 'tornstats'
  const isExact = isExactStatsSource(m.spy_source)
  // ts_spy_at is the real spy capture time; bsp_fetched_at is when we polled.
  // BSP and own-key rows don't have a "real" spy timestamp so we use the fetch
  // time. Use parseDbTime, not new Date(): the API serves Postgres timestamptz
  // text with a bare "+00" offset (db.ts) that JS Date rejects → the age showed
  // a dash even with a real ts_spy_at (#140).
  const sourceLabel = statsSourceLabel(m.spy_source)
  const ageLabel = fmtAgo(isTs && m.ts_spy_at ? m.ts_spy_at : m.bsp_fetched_at)

  const rows = [
    ['STR', m.bsp_str],
    ['DEF', m.bsp_def],
    ['SPD', m.bsp_spd],
    ['DEX', m.bsp_dex],
  ].filter(([, v]) => v !== null && v !== undefined)

  // `relative` is required: the breakdown below is `absolute right-0 top-full`,
  // and without a positioned ancestor it anchors to whatever is positioned
  // further up and lands nowhere near its cell. It is not what made the number
  // overlap the header (#331) — that was the sticky <th> having no z-index,
  // which let every positioned row element paint over it.
  return (
    <span className="relative group inline-block">
      <span
        title={isExact ? 'Exact — read from this member\'s own key' : undefined}
        className={`font-mono text-xs text-gray-800 dark:text-gray-200 font-semibold cursor-help underline underline-offset-2 ${
          isExact
            ? 'decoration-solid decoration-emerald-500/70'
            : 'decoration-dotted decoration-gray-400 dark:decoration-slate-600'
        }`}
      >
        {formatStats(m.bsp_total)}
      </span>
      <span
        role="tooltip"
        className="invisible group-hover:visible opacity-0 group-hover:opacity-100 transition-opacity absolute right-0 top-full mt-1 z-30 min-w-[150px] rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-lg text-left p-2.5 text-[11px]"
      >
        {rows.length > 0 ? (
          <table className="font-mono w-full">
            <tbody>
              {rows.map(([label, v]) => (
                <tr key={label}>
                  <td className="pr-3 text-gray-500 dark:text-gray-400">{label}</td>
                  <td className="text-right text-gray-900 dark:text-gray-100">{formatStats(v)}</td>
                </tr>
              ))}
              <tr className="border-t border-gray-200 dark:border-slate-700">
                <td className="pr-3 pt-1 text-gray-500 dark:text-gray-400 font-semibold">Total</td>
                <td className="text-right pt-1 text-gray-900 dark:text-gray-100 font-semibold">{formatStats(m.bsp_total)}</td>
              </tr>
            </tbody>
          </table>
        ) : (
          <div className="font-mono flex justify-between gap-3">
            <span className="text-gray-500 dark:text-gray-400 font-semibold">Total</span>
            <span className="text-gray-900 dark:text-gray-100 font-semibold">{formatStats(m.bsp_total)}</span>
          </div>
        )}
        <div className="mt-1.5 pt-1.5 border-t border-gray-200 dark:border-slate-700 text-gray-500 dark:text-gray-400 text-[10px] text-right whitespace-nowrap">
          {ageLabel} ({sourceLabel})
        </div>
      </span>
    </span>
  )
}
