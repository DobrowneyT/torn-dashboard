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
import { isMaxFF } from './fairFight'

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
    // Fair Fight is enemy-only by nature (#422): it answers "what would I earn
    // hitting this person", which is meaningless against our own roster.
    ff: !us,
    energy: us, drugCd: us, medicalCd: us, boosterCd: us,
    // Revive chance is our-roster only and not by choice (#358): Torn reports a
    // success chance only on revives our own faction received, so there is no
    // enemy equivalent to show.
    reviveChance: us,
  }
}

/**
 * Sort columns that exist only on our own roster (#351).
 *
 * Energy and the cooldowns are sortable, but they are also the columns that
 * disappear on the enemy side — and `sortCol` is persisted across reloads. A
 * lead who sorts by energy, toggles back to the opponent and reloads would
 * otherwise be left sorting a column that isn't rendered: every row compares
 * equal, the order looks arbitrary, and no header carries the arrow.
 */
const OUR_ROSTER_SORT_COLS = new Set([
  'energy', 'cooldown_drug', 'cooldown_medical', 'cooldown_booster',
  'revive_chance',
])

/**
 * Sort columns that exist only on the ENEMY roster (#422).
 *
 * The mirror of the set above, and needed for the same reason: `sortCol` is
 * persisted, so a lead who sorts by FF and then toggles to our own roster would
 * be sorting a column that isn't rendered — every row compares equal and no
 * header carries the arrow.
 */
const ENEMY_ROSTER_SORT_COLS = new Set(['ff'])

/** Default to fall back to when the chosen sort column isn't on this side. */
export const DEFAULT_SORT_COL = 'timer'

/** The sort column actually in effect for a side. */
export function effectiveSortCol(sortCol, side, fallback = DEFAULT_SORT_COL) {
  if (side !== US && OUR_ROSTER_SORT_COLS.has(sortCol)) return fallback
  if (side === US && ENEMY_ROSTER_SORT_COLS.has(sortCol)) return fallback
  return sortCol
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
 * It was flatly unavailable on our own roster until #353: spies are fetched for
 * the ENEMY only, so `bsp_total` was null for every one of our members and an
 * active min/max would silently empty the table the moment anyone toggled over.
 *
 * Our members now carry their own battle stats (#348), but only once the daily
 * sweep has actually run — before that, or if the fetch failed, we hold nothing
 * and the original trap is still open. So the answer is conditional rather than
 * a flat yes: usable on our side exactly when we have stats for someone.
 */
export function isStatsFilterAvailable(side, ourBattleStatsCount = 0) {
  return side !== US || ourBattleStatsCount > 0
}

/**
 * Does this member survive the battle-stats min/max filter?
 *
 * In FARM MODE a green attack button always survives (#366). Those are the only
 * people who can be hit this second, so if a push starts they are precisely what
 * a lead needs on screen — and a min/max left over from farming would quietly
 * remove exactly them. A filter that hides the thing you must react to is worse
 * than no filter.
 *
 * Outside farm mode the filter is a deliberate targeting tool and is left to do
 * what it says.
 *
 * Reads the total under either row-shape name (#479) so the mobile overlay can
 * share this rather than reimplementing it — which it did, without the farm
 * exemption, so green targets vanished from the phone exactly when they
 * mattered most.
 */
export function passesStatsFilter(member, { min = null, max = null, farmMode = false, isGreen = false } = {}) {
  if (farmMode && isGreen) return true
  const total = member?.bsp_total ?? member?.bsp
  if (min !== null && !(total !== null && total !== undefined && total >= min)) return false
  if (max !== null && !(total !== null && total !== undefined && total <= max)) return false
  return true
}

/**
 * Does this member survive the "3x FF" filter?
 *
 * In FARM MODE a green attack button always survives, exactly as it does for
 * the stats filter (#481) — *"We want people to see those targets so they know
 * if a push is coming"* (MonChoon). Someone online and out of hospital is the
 * enemy's readiness showing, and a filter that hides what you have to react to
 * is worse than no filter.
 *
 * The two filters deliberately share the same rule and the same condition.
 * MonChoon first scoped this one as unconditional and then settled on matching
 * the stats filter: outside farm mode a filter is a deliberate targeting tool
 * and should do what it says, and having the two behave differently would make
 * the board's contents depend on which filter you happened to reach for.
 */
export function passesFfFilter(ff, { enabled = false, farmMode = false, isGreen = false } = {}) {
  if (!enabled) return true
  if (farmMode && isGreen) return true
  return isMaxFF(ff)
}

/** Cycle target for the toggle button. */
export function otherSide(side) {
  return side === US ? THEM : US
}

/**
 * What the board should say it is doing (#345).
 *
 * `enabled` is now the ONLY gate on polling. #342 added this helper because a
 * second gate existed — an auto-managed session refused to poll outside its
 * war's start/end window — so an enabled room could sit frozen for days behind
 * a green LIVE badge. That gate is gone: leadership decides when the room
 * runs, and the cadence settings decide what it polls.
 *
 * What remains worth distinguishing is a room that is on but has had its
 * roster poll switched off (cadence 0). Showing plain "LIVE" over a roster
 * nobody is refreshing would repeat the original lie in a smaller way.
 */
export function pollingState({ enabled, rosterIntervalMs } = {}) {
  if (!enabled) return { state: 'off', polling: false, rosterPolling: false }
  // Unset is not off: Number(null) is 0, so a missing value must not read as
  // "roster polling disabled" — that would blank the board on upgrade, before
  // the column has been populated.
  const rosterOff = rosterIntervalMs != null
    && rosterIntervalMs !== ''
    && Number(rosterIntervalMs) === 0
  return {
    state: rosterOff ? 'roster-paused' : 'live',
    polling: true,
    rosterPolling: !rosterOff,
  }
}
