/**
 * Previous matchups against the faction we are fighting (#398).
 *
 * Two questions, both answered from data we already store:
 *   1. How did we do against them before, and what did we write about it?
 *   2. Who on their roster is new since last time?
 *
 * ⚠️ The honesty constraint that shapes the whole module. Torn's ranked-war
 * report is a snapshot of the roster AS TORN RECORDED IT FOR THAT WAR — measured
 * on faction_forge, `rows_held` runs 77 to 100 against a 100-slot faction. So
 * someone who joined mid-war, or left before the report was cut, is simply
 * absent from it. The diff is therefore "on their war roster last time", NOT
 * "in their faction last time", and every label this module produces says so.
 * On a panel whose job is telling a war lead who is new, that is a real
 * difference and not a pedantic one.
 */

/** Ids compare as strings throughout: Torn ids arrive as both. */
const key = (id) => String(id ?? '')

/**
 * Won / Lost / Won (forfeit) for one war, from our point of view.
 *
 * Returns 'unknown' rather than guessing when no winner is recorded. A war that
 * ended without a winner id is a data gap, and rendering it as a loss would
 * quietly worsen our own record.
 */
export function warResult(war, ourFactionId) {
  const winner = war?.winner_faction_id
  if (winner === null || winner === undefined || winner === '') return 'unknown'
  const won = key(winner) === key(ourFactionId)
  if (war?.forfeit) return won ? 'won-forfeit' : 'lost-forfeit'
  return won ? 'won' : 'lost'
}

export const RESULT_LABELS = {
  won: 'Won',
  lost: 'Lost',
  'won-forfeit': 'Won (forfeit)',
  'lost-forfeit': 'Lost (forfeit)',
  unknown: '—',
}

/**
 * Our aggregate record against this faction.
 *
 * Wars with an unknown result are counted separately rather than being dropped,
 * so "2-1" and "2-1 (plus one we cannot read)" are distinguishable.
 */
export function headToHead(wars, ourFactionId) {
  let won = 0
  let lost = 0
  let unknown = 0
  for (const war of wars ?? []) {
    const r = warResult(war, ourFactionId)
    if (r === 'unknown') unknown++
    else if (r.startsWith('won')) won++
    else lost++
  }
  return { won, lost, unknown, total: (wars ?? []).length }
}

/**
 * Diff their CURRENT roster against their roster in the most recent previous war.
 *
 * Three groups, plus level movement for the members present in both. Sorted by
 * name inside each group — a war lead reads this looking for specific people,
 * and score order would move them between visits.
 *
 * Returns null when there is nothing to compare against, which is different from
 * an empty diff: a faction we have never fought yields no diff at all, whereas
 * one whose roster is unchanged yields three groups with `newMembers` empty.
 */
export function rosterDiff(currentRoster, lastRoster) {
  if (!lastRoster || lastRoster.length === 0) return null

  const before = new Map()
  for (const row of lastRoster) before.set(key(row.member_id), row)

  const newMembers = []
  const returning = []
  const seen = new Set()

  for (const row of currentRoster ?? []) {
    const id = key(row.member_id)
    seen.add(id)
    const previous = before.get(id)
    if (!previous) {
      newMembers.push({ id, name: row.member_name, level: row.level ?? null })
      continue
    }
    const wasLevel = previous.level ?? null
    const nowLevel = row.level ?? null
    returning.push({
      id,
      name: row.member_name,
      level: nowLevel,
      previousLevel: wasLevel,
      // Null, not 0, when either level is missing — a member whose level we
      // cannot read has not "gained 0 levels".
      levelGain: wasLevel !== null && nowLevel !== null ? nowLevel - wasLevel : null,
    })
  }

  const departed = []
  for (const [id, row] of before) {
    if (seen.has(id)) continue
    departed.push({ id, name: row.member_name, level: row.level ?? null })
  }

  const byName = (a, b) => (a.name || '').localeCompare(b.name || '')
  return {
    newMembers: newMembers.sort(byName),
    returning: returning.sort(byName),
    departed: departed.sort(byName),
    previousSize: lastRoster.length,
    currentSize: (currentRoster ?? []).length,
  }
}

/**
 * Our own top scorers in a past war against them.
 *
 * Contributions arrive score-ordered from the server; this only trims and
 * guards. Kept as a function so the cap lives with the other display decisions
 * rather than inline in JSX.
 */
export function topContributors(contributions, limit = 5) {
  return (contributions ?? []).slice(0, limit)
}

/**
 * Roll-call turnout for a past war, as a fraction we can state plainly.
 *
 * Returns null when nobody answered — no roll call was taken that war, and
 * "0% turnout" would blame the faction for a feature that did not run yet.
 */
export function rollCallTurnout(rollCall) {
  const rows = rollCall ?? []
  if (rows.length === 0) return null
  const on = rows.filter((r) => r.on_at_start).length
  return { on, total: rows.length, fraction: on / rows.length }
}
