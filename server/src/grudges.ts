// The Book of Grudges (#889) — core rules, free of HTTP framing.
//
// Proposed by MonChoon 2026-10-04. The premise is that a target earns its
// place by having wronged somebody, so a grudge without a stated reason is not
// a grudge and is refused at every layer: here, in the route, and by a CHECK
// constraint on the column.
//
// ⚠️ Deliberately NOT coupled to the War Room. The reuse MonChoon authorised
// is of LEAF MODULES — `fairFight.js`, `warRoomFarmSort.js`, the spy-provider
// half of `spyFetch.ts` — never its tables, pollers or views. Nothing in this
// file reads `war_room_state_v2`, and a War Room migration must never be able
// to break a grudge.

/** A profile link, a bare id, or something that is neither. */
export function parseTargetId(input: unknown): string | null {
  const raw = String(input ?? '').trim()
  if (!raw) return null
  // A bare id is the common case when somebody retypes rather than pastes.
  if (/^\d+$/.test(raw)) return raw
  // ⚠️ XID is case-insensitive in the wild and the link may carry other params
  // before or after it, so this is not anchored to the end of the string.
  const xid = raw.match(/[?&]XID=(\d+)/i)
  if (xid) return xid[1]
  // profiles.php/1234 and /profiles/1234 both appear in pasted links.
  const path = raw.match(/profiles(?:\.php)?\/(\d+)/i)
  if (path) return path[1]
  return null
}

/**
 * Is this target one leadership has to rule on before it goes public?
 *
 * ⚠️ Compares against a CONFIGURED list, not against our own faction id. The
 * ask was "if a member adds a target and they are from our faction (or faction
 * family) it goes into a state where it needs to be approved" plus "in the
 * settings we should be able to add / remove factions we want to call alarms
 * on" — so the family, allies and anyone else leadership names all go through
 * the same gate, and none of it is hardcoded.
 *
 * ⚠️ Ids are compared as STRINGS. Torn ids arrive as numbers from the API and
 * as text from the database, and a mixed-type lookup silently matches nothing.
 */
export function isWatchedFaction(factionId: unknown, watched: unknown[]): boolean {
  if (factionId === null || factionId === undefined || factionId === '') return false
  const id = String(factionId)
  return (watched ?? []).some((w) => w !== null && w !== undefined && String(w) === id)
}

export type TargetState = 'active' | 'pending_approval' | 'rejected'

/** The state a newly added target lands in. */
export function initialState(factionId: unknown, watched: unknown[]): TargetState {
  return isWatchedFaction(factionId, watched) ? 'pending_approval' : 'active'
}

/**
 * Who may see a target.
 *
 * ⚠️ A pending target is NOT on the public list. That is the whole point of
 * the state — surfacing it to everyone while leadership decides would be the
 * exact outcome the approval gate exists to prevent. Its author still sees it,
 * so their submission does not appear to have vanished.
 */
export function canSeeTarget(
  target: { state: string; added_by?: string | null },
  viewer: { memberId: string; isLeadership: boolean }
): boolean {
  if (target.state === 'active') return true
  if (target.state === 'rejected') return viewer.isLeadership
  return viewer.isLeadership || String(target.added_by ?? '') === String(viewer.memberId)
}

/**
 * Who may edit or remove one grudge entry.
 *
 * "admins / leadership should be able to remove anyone from the list as well
 * as the user who added that player to the list (or edit it as they see fit)."
 */
export function canModifyEntry(
  entry: { member_id: string },
  viewer: { memberId: string; isLeadership: boolean }
): boolean {
  return viewer.isLeadership || String(entry.member_id) === String(viewer.memberId)
}

/** A reason that is only whitespace is no reason at all. */
export function normaliseReason(input: unknown): string | null {
  const text = String(input ?? '').trim()
  return text === '' ? null : text
}

/**
 * Targets grouped for the batched status refresh.
 *
 * ⚠️ `/faction/{id}/members` returns every member's status in ONE call, so a
 * faction holding several targets costs one call rather than several. But a
 * faction holding exactly ONE target costs the same single call either way and
 * returns far more payload, so it is routed to the individual lookup instead.
 * Grouping unconditionally would be strictly worse for the common case of a
 * one-off target in a faction nobody else has annoyed.
 *
 * ⚠️ Unfactioned targets can never be batched — there is no call that returns
 * "these twelve unrelated players". They are individual by necessity.
 */
export function planStatusRefresh(
  targets: Array<{ target_id: string; faction_id: string | null }>
): { factions: string[]; individuals: string[] } {
  const byFaction = new Map<string, string[]>()
  const individuals: string[] = []
  for (const t of targets ?? []) {
    const fid = t.faction_id == null || t.faction_id === '' ? null : String(t.faction_id)
    if (fid === null) {
      individuals.push(String(t.target_id))
      continue
    }
    const bucket = byFaction.get(fid) ?? []
    bucket.push(String(t.target_id))
    byFaction.set(fid, bucket)
  }
  const factions: string[] = []
  for (const [fid, ids] of byFaction) {
    if (ids.length >= 2) factions.push(fid)
    else individuals.push(...ids)
  }
  return { factions, individuals }
}

/**
 * Targets that a faction sweep did not account for.
 *
 * ⚠️ Absence from their own faction's member list means they LEFT it, which is
 * the only signal Torn gives us. They need an individual `/user/{id}/profile`
 * to re-home them — note `profile`, not `basic`: `/user/{id}/basic` carries no
 * faction at all (`id, name, level, gender, status`), which makes it the
 * obvious and wrong choice here.
 */
export function departedFromFaction(
  expectedIds: string[],
  seenIds: unknown[]
): string[] {
  const seen = new Set((seenIds ?? []).map((v) => String(v)))
  return (expectedIds ?? []).map(String).filter((id) => !seen.has(id))
}
