// Who the War Overview's Member dropdown can offer, and what each of them did.
//
// ⚠️ **The list used to be derived from the event data alone**, so a member who
// neither attacked nor was attacked simply had no row to be found in and never
// appeared. That made "not in the list" mean two different things at once —
// *did nothing* and *was not in this war* — and the member view exists
// precisely to tell those apart. MonChoon: *"if a particular member has no
// outgoing or incoming it seems like they don't appear in the list, is that
// true?"* It was.
//
// ⚠️ **The roster ADDS to the list; it never filters it.** A member who fought
// and has since left the faction has no roster row, and dropping them would
// lose real war history. Every id found in the event data survives regardless
// of what the roster says.
//
// ⚠️ **The roster is TODAY'S roster.** `members` records no join date, so for a
// war that ran months ago the zero-activity group is "people here now who have
// no events in it", which is not the same as "people who were in that war and
// did nothing". That is why those entries are grouped and labelled separately
// rather than mixed in — the caller must not present them as confirmed
// non-participants. (`member_faction_stints` could scope this properly; it is
// only observed from #284 onward, so it would not cover older wars either.)

/**
 * What the war data shows for one member.
 *
 * `fought` — appears in at least one of the three plotted panels (outgoing
 *            hits, incoming hits, revives received).
 * `revivedOnly` — revived teammates and nothing else. ⚠️ There is no panel for
 *            revives performed, so selecting one of these renders three empty
 *            charts; the caller has to say so in words.
 * `none`   — on the roster, absent from every event row.
 */
export const ACTIVITY = {
  fought: 'fought',
  revivedOnly: 'revived-only',
  none: 'none',
}

/** Our faction, or theirs? ⚠️ Through `Number()`: faction ids arrive as strings
 *  from some payloads, and a `===` against a number matches none of them. The
 *  server's own revive filters are written the same way. */
const sameFaction = (a, b) => Number(a) === Number(b)

/**
 * Every member of ours the selected war can say anything about.
 *
 * @param {object[]} attacks  faction_attacks rows for the war window
 * @param {object[]} revives  faction_revives rows for the war
 * @param {object[]} roster   /api/members/roster rows (optional)
 * @param {number|string} ourFactionId
 * @returns {{id:number,name:string,outgoing:number,incoming:number,
 *            revivesIn:number,revivesOut:number,events:number,
 *            onRoster:boolean,activity:string}[]} sorted by name
 */
export function buildMemberList({ attacks = [], revives = [], roster = [], ourFactionId }) {
  const byId = new Map()

  // `name: null` is deliberate — an id seen only in a row that carried no name
  // still has to resolve to something, and that is decided once, at the end.
  const touch = (id) => {
    const key = Number(id)
    if (!key) return null
    if (!byId.has(key)) {
      byId.set(key, {
        id: key, name: null, outgoing: 0, incoming: 0,
        revivesIn: 0, revivesOut: 0, onRoster: false,
      })
    }
    return byId.get(key)
  }

  // A name from the war itself wins: it is what they were called at the time,
  // which is what a post-mortem read weeks later should show.
  const nameFromEvent = (entry, name) => {
    if (entry && entry.name == null && name) entry.name = String(name)
  }

  for (const a of attacks) {
    if (sameFaction(a.attacker_faction_id, ourFactionId)) {
      const m = touch(a.attacker_id)
      if (m) { m.outgoing += 1; nameFromEvent(m, a.attacker_name) }
    }
    if (sameFaction(a.defender_faction_id, ourFactionId)) {
      const m = touch(a.defender_id)
      if (m) { m.incoming += 1; nameFromEvent(m, a.defender_name) }
    }
  }

  for (const r of revives) {
    if (sameFaction(r.target_faction_id, ourFactionId)) {
      const m = touch(r.target_id)
      if (m) { m.revivesIn += 1; nameFromEvent(m, r.target_name) }
    }
    // ⚠️ The half that was missing. `reviver_id` has always been on the row.
    if (sameFaction(r.reviver_faction_id, ourFactionId)) {
      const m = touch(r.reviver_id)
      if (m) { m.revivesOut += 1; nameFromEvent(m, r.reviver_name) }
    }
  }

  for (const row of roster) {
    // Past members are in the roster read for history's sake; only the current
    // faction can be said to have "no activity" in a war we are looking at.
    if (row?.is_current === false) continue
    const m = touch(row?.member_id)
    if (!m) continue
    m.onRoster = true
    if (m.name == null && row.member_name) m.name = String(row.member_name)
  }

  return [...byId.values()]
    .map((m) => {
      const events = m.outgoing + m.incoming + m.revivesIn + m.revivesOut
      const plotted = m.outgoing + m.incoming + m.revivesIn
      return {
        ...m,
        name: m.name ?? `id ${m.id}`,
        events,
        activity: plotted > 0 ? ACTIVITY.fought
          : m.revivesOut > 0 ? ACTIVITY.revivedOnly
            : ACTIVITY.none,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}

/**
 * Revives this member performed inside the summary's window.
 *
 * ⚠️ Separate from `buildMemberList`, which counts the whole war: this one has
 * to move with the range slider so the sentence under the summary agrees with
 * the numbers beside it. It is NOT a fourth stat pill — the summary keeps one
 * shape across both views on purpose (see `warOverviewSummary`), and revives
 * performed are plotted nowhere.
 */
export function revivesPerformedInWindow({ revives = [], memberId, fromTs, toTs }) {
  if (!memberId) return 0
  let n = 0
  for (const r of revives) {
    if (Number(r.reviver_id) !== Number(memberId)) continue
    if (r.timestamp < fromTs || r.timestamp > toTs) continue
    n += 1
  }
  return n
}
