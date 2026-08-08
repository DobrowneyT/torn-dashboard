/**
 * War Room roster-side toggle (#335).
 *
 * The room already receives BOTH factions on the same stream — the ticker polls
 * each of them and `useWarRoomSocket` splits the rows by `faction_id` into
 * `members` (the opponent) and `ourMembers`. The rows are identically shaped, so
 * showing our own faction is a matter of choosing which array feeds the table.
 *
 * The decisions live here, as pure functions, so the table stays a renderer and
 * the awkward parts (which columns disappear, which filters stop making sense)
 * are testable without mounting anything.
 */

export const THEM = 'them'
export const US = 'us'

/** Default side. Deliberately NOT persisted — see docs on the toggle in #335. */
export const DEFAULT_ROSTER_SIDE = THEM

export function isRosterSide(value) {
  return value === THEM || value === US
}

/** Whichever roster the table should show. Unknown sides fall back to the enemy. */
export function selectRosterMembers(side, { members = [], ourMembers = [] } = {}) {
  return side === US ? ourMembers : members
}

/**
 * Which optional columns this side shows.
 *
 * Dibs and Attack are meaningless against our own faction — you cannot claim or
 * hit a team-mate — so they are hidden rather than greyed out: a narrower table
 * beats a row of dead controls mid-war.
 *
 * Energy and the booster cooldown are the reverse: only meaningful for us, and
 * only obtainable per-member with that member's own key (#336). They render as
 * placeholders until that lands.
 */
export function rosterColumns(side) {
  const us = side === US
  return { dibs: !us, action: !us, energy: us, boosterCd: us }
}

/** Fixed columns every side shows: name, activity, status, timer, stats, flags. */
const BASE_COLUMN_COUNT = 6

/** Total column count, for the empty-state row's colSpan. */
export function rosterColumnCount(side) {
  const cols = rosterColumns(side)
  return BASE_COLUMN_COUNT + Object.values(cols).filter(Boolean).length
}

/**
 * Is the battle-stats filter usable on this side?
 *
 * No, for us: spies are fetched for the ENEMY only, so `bsp_total` is null for
 * our members. Leaving the filter live would silently empty the table the moment
 * anyone toggled over with a min/max set — the filter has to be suspended, not
 * merely ignored.
 */
export function isStatsFilterAvailable(side) {
  return side !== US
}

/** Cycle target for the toggle button. */
export function otherSide(side) {
  return side === US ? THEM : US
}
