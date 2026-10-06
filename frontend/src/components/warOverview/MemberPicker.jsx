import { ACTIVITY } from '../../utils/warOverviewMembers'

/**
 * The War Overview's Member dropdown.
 *
 * ⚠️ **Two groups, not one flat list.** Members with no events come from
 * TODAY'S roster matched against a war that may be months old, so the honest
 * claim is "no events in this war" and not "was here and did nothing" —
 * `members` records no join date, so the stronger claim is not available. Mixing
 * them in with everyone else would state it anyway, by implication.
 *
 * ⚠️ **"revives only" is marked.** None of the three panels plots revives
 * performed, so a medic who spent the war reviving teammates renders as three
 * empty charts; without the label the dropdown would have been widened to
 * include them and they would still look idle.
 *
 * ⚠️ Its own file so it can be tested without mounting the view, which carries
 * Plotly and four network reads. The picker is the part with rules in it.
 */
export default function MemberPicker({ members = [], selectedId, onSelect }) {
  const active = members.filter(m => m.activity !== ACTIVITY.none)
  const idle   = members.filter(m => m.activity === ACTIVITY.none)

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
        {active.length > 0 && (
          <optgroup label="In the war data">
            {active.map(m => (
              <option key={m.id} value={m.id}>
                {m.name} [{m.id}]{m.activity === ACTIVITY.revivedOnly ? ' — revives only' : ''}
              </option>
            ))}
          </optgroup>
        )}
        {idle.length > 0 && (
          <optgroup label="No events in this war">
            {idle.map(m => (
              <option key={m.id} value={m.id}>{m.name} [{m.id}]</option>
            ))}
          </optgroup>
        )}
      </select>
    </div>
  )
}
