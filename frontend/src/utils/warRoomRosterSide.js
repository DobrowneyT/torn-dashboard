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
 * The side actually in effect, given what the viewer is allowed to see.
 *
 * A viewer can lose the war-lead role while the board is open (a session
 * refresh re-reads roles), which would otherwise strand them on a roster they
 * may no longer view. Resolving the side through this on every render means
 * the table falls back to the enemy the moment the permission goes away.
 */
export function effectiveRosterSide(side, permissions) {
  if (side === US && !canViewOurRoster(permissions)) return THEM
  return isRosterSide(side) ? side : THEM
}

/**
 * Can this viewer switch to our own roster at all? (#336)
 *
 * The our-side sheet carries live energy and drug cooldowns, which say when a
 * teammate is playing and whether they are mid-overdose. That is war-planning
 * data for leads, not something every member should hold about every other
 * member — so the toggle is gated, and the server withholds the data itself
 * (LEAD_ONLY_CHANNELS in warRoom.ts) rather than trusting this check.
 *
 * Mirrors canEditMemberNotes: war leads, leadership and admins, never visitors.
 */
export function canViewOurRoster({ isWarLead, isLeadership, isAdmin, isVisitor } = {}) {
  return Boolean((isWarLead || isLeadership || isAdmin) && !isVisitor)
}

/**
 * Which optional columns this side shows.
 *
 * Dibs and Attack are meaningless against our own faction — you cannot claim or
 * hit a team-mate — so they are hidden rather than greyed out: a narrower table
 * beats a row of dead controls mid-war.
 *
 * Energy and the three cooldowns are the reverse: only meaningful for us, and
 * only obtainable per-member with that member's own key (#336).
 */
export function rosterColumns(side) {
  const us = side === US
  return {
    dibs: !us, action: !us,
    energy: us, drugCd: us, medicalCd: us, boosterCd: us,
  }
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
