// Loadout shield (#528 Part 2 follow-up): a small icon on the Name cell,
// hover-only, in the exact CSS-only group-hover style BattleStatsCell already
// uses — same border/shadow/font treatment, so a lead reading the row does
// not have to learn a second tooltip language for battle stats vs gear.
//
// Renders nothing when there is no observation for this member — the flag is
// "we know this", and most of a roster has never been fought yet (#528's own
// sparse-by-nature framing). The Flags-column 🎯 flag (warRoomFlags.js) still
// carries the same information in the scan-the-flags reading of the row;
// this is the same fact placed where a lead is already looking at the name.
import { Shield } from 'lucide-react'
import { loadoutEntries, loadoutFreshness } from '../../utils/warRoomLoadout'
import { fmtAgo } from '../../utils/time'

export default function LoadoutShieldIcon({ loadoutRow }) {
  const entries = loadoutEntries(loadoutRow?.loadout)
  if (entries.length === 0) return null

  // Three bands, not two: gear seen two hours ago is still worth acting on,
  // yesterday's is a hint. A single stale/fresh flag made those look identical.
  const freshness = loadoutFreshness(loadoutRow)
  const who = loadoutRow.observed_by_name ? ` by ${loadoutRow.observed_by_name}` : ''
  const ageLabel = `Observed ${fmtAgo(loadoutRow.observed_at ?? loadoutRow.updated_at)}${who}`
  const SHIELD_TONE = {
    fresh: 'text-emerald-600 dark:text-emerald-400',
    aging: 'text-amber-600 dark:text-amber-400',
    stale: 'text-gray-400 dark:text-gray-600',
  }
  const AGE_NOTE = { fresh: '', aging: ' — over 2h old', stale: ' — over a day old' }

  return (
    <span className="relative group inline-flex shrink-0">
      <Shield size={13} className={`${SHIELD_TONE[freshness]} cursor-help`} />
      <span
        role="tooltip"
        className="invisible group-hover:visible opacity-0 group-hover:opacity-100 transition-opacity absolute left-0 top-full mt-1 z-30 min-w-[160px] rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-lg text-left p-2.5 text-[11px]"
      >
        <table className="font-mono w-full">
          <tbody>
            {entries.map((e) => (
              <tr key={e.slot}>
                <td className="pr-3 text-gray-500 dark:text-gray-400">{e.label}</td>
                <td className="text-right text-gray-900 dark:text-gray-100">{e.name}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-1.5 pt-1.5 border-t border-gray-200 dark:border-slate-700 text-gray-500 dark:text-gray-400 text-[10px] text-right whitespace-nowrap">
          {ageLabel}
          {AGE_NOTE[freshness]}
        </div>
      </span>
    </span>
  )
}
