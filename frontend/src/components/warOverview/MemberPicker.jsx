import { ACTIVITY } from '../../utils/warOverviewMembers'

/**
 * The War Overview's Member dropdown.
 *
 * ⚠️ **One alphabetical list, with the quiet names greyed** — not two groups.
 * Grouping was the first attempt and MonChoon rejected it: splitting the list
 * costs you the one thing an alphabetical dropdown is good for, which is going
 * straight to a name you already have in mind without first working out which
 * half it is in.
 *
 * ⚠️ **Colour is not load-bearing.** `option { color }` is honoured by Chrome
 * and Firefox on desktop and ignored outright by native select menus on macOS
 * Safari and on mobile, where the OS draws the list. So each quiet entry also
 * carries a text marker — the grey is the fast signal for people who get it,
 * the words are what everybody gets.
 *
 * The two quiet cases are different and say so:
 *   "no events"    — absent from this war's data entirely. ⚠️ Derived from
 *                    TODAY'S roster against a war that may be months old;
 *                    `members` records no join date, so this means *no events
 *                    in this war* and never *was here and did nothing*.
 *   "revives only" — revived teammates and nothing else. None of the three
 *                    panels plots revives performed, so without this they look
 *                    identical to someone who did nothing at all.
 *
 * ⚠️ Its own file so it can be tested without mounting the view, which carries
 * Plotly and four network reads. The picker is the part with rules in it.
 */

/** The marker after a name, or '' for somebody whose war speaks for itself. */
export function memberMarker(activity) {
  if (activity === ACTIVITY.none) return ' — no events'
  if (activity === ACTIVITY.revivedOnly) return ' — revives only'
  return ''
}

export default function MemberPicker({ members = [], selectedId, onSelect }) {
  const quiet = members.some(m => m.activity !== ACTIVITY.fought)

  return (
    <div>
      <label
        className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1"
        htmlFor="war-overview-member"
      >
        Member
      </label>
      <select
        id="war-overview-member"
        value={selectedId ?? ''}
        onChange={e => onSelect(e.target.value ? Number(e.target.value) : null)}
        className="min-w-[14rem] px-3 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        <option value="">— pick a member —</option>
        {members.map(m => (
          <option
            key={m.id}
            value={m.id}
            // ⚠️ Greys BOTH quiet cases: a revives-only member has nothing on
            // any of the three panels either, so the charts are just as empty.
            className={m.activity === ACTIVITY.fought
              ? undefined
              : 'text-gray-400 dark:text-gray-500'}
          >
            {m.name} [{m.id}]{memberMarker(m.activity)}
          </option>
        ))}
      </select>
      {quiet && (
        <p className="mt-1 text-xs italic text-gray-500 dark:text-gray-400">
          Greyed names have nothing to plot for this war.
        </p>
      )}
    </div>
  )
}
