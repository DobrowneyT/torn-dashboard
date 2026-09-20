import InfoTooltip from './InfoTooltip'
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

// Tooltip on a member's BSP total — shows the per-stat breakdown
// (str/dex/spd/def), total, and "{relative age} ({TS|BSP})" so leadership
// can see at a glance how trustworthy the number is.
//
// ⚠️ This was CSS-only `group-hover` until #612, which meant it did not exist
// on a phone: there is no hover to trigger it, and nothing on screen said the
// breakdown was there to miss. Leadership sizing up a target on mobile saw a
// bare total with no way to learn whether it was measured or guessed — which is
// the one distinction this cell exists to make. InfoTooltip opens on tap too.
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

  // The panel is painted at fixed viewport coordinates by InfoTooltip, so it no
  // longer needs a positioned ancestor and can no longer be clipped by one. The
  // old `absolute` panel also had to be kept clear of the sticky <th>, which is
  // what made the number overlap the header in #331 (the <th> had no z-index).
  //
  // ⚠️ The underline is NOT decoration here: solid emerald means the reading was
  // measured from the member's own key, dotted means it is an estimate. It goes
  // through `decoration` rather than `className` so it replaces the component's
  // default instead of racing it in the cascade.
  return (
    <InfoTooltip
      label={formatStats(m.bsp_total)}
      decoration={`underline underline-offset-2 ${
        isExact
          ? 'decoration-solid decoration-emerald-500/70'
          : 'decoration-dotted decoration-gray-400 dark:decoration-slate-600'
      }`}
      className="font-mono text-xs text-gray-800 dark:text-gray-200 font-semibold"
    >
      <div className="min-w-[150px]">
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
      </div>
    </InfoTooltip>
  )
}
