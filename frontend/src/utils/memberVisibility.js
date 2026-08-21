/**
 * Who belongs on a roster the faction actually acts on.
 *
 * Torn preserves the account of a player who has died — status `Fallen`,
 * described as "Resting in Peace". The account stays on the faction roster
 * indefinitely, which is also how a faction comes to hold more than 100
 * members. They cannot act, so counting them skews roll-call turnout, activity
 * totals and every roster view, on our own side as much as the enemy's.
 *
 * This is a DISPLAY filter, not a deletion: the row stays in
 * war_room_state_v2, the delta keeps flowing, and audit or history queries
 * still see the original snapshot. The roster equivalent server-side is the
 * `members.is_fallen` column.
 */
export const FALLEN = 'Fallen'

/** True for a member who should appear on rosters, counts and roll call. */
export function isActiveMember(member) {
  return statusStateOf(member) !== FALLEN
}

/** Drop the fallen from a list of member rows. */
export function withoutFallen(members) {
  return (members ?? []).filter(isActiveMember)
}

/**
 * The status string, wherever this shape carries it. War-room rows are
 * flattened to `status_state`; raw rows keep the nested `state.status.state`.
 */
function statusStateOf(member) {
  if (!member) return null
  return member.status_state ?? member.state?.status?.state ?? member.state ?? null
}
