// Book of Grudges enrichment (#889, slice 4): who a target is, and where they
// are right now.
//
// ⚠️ **Every call here is purpose-scoped.** `pool.claim({ purpose:
// 'target-lookup' })` — a member who has not accepted the Target Lookups
// disclosure is skipped for these and for nothing else (#894). That is the one
// rule in this file that must not be loosened for convenience.
//
// ⚠️ **`/user/{id}/profile`, never `/user/{id}/basic`.** `basic` carries
// `id, name, level, gender, status` and **no faction at all**, which makes it
// the obvious and wrong choice: without a faction we cannot batch the refresh
// and, worse, cannot tell whether a target belongs to a watched faction.

/** What a target looks like after a profile read. */
export interface ResolvedTarget {
  name: string | null
  level: number | null
  factionId: string | null
  statusState: string | null
  statusUntil: number | null
  statusDescription: string | null
}

const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s === '' ? null : s
}
const num = (v: unknown): number | null => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Read `GET /user/{id}/profile`.
 *
 * ⚠️ `status.until` is a Torn epoch in **seconds** and is stored as given. Not
 * every timestamp is a database timestamp (#140 cuts both ways): converting it
 * as though it were a timestamptz, or running it through `parseDbTime`, would
 * silently produce a date in 1970.
 */
export function readProfile(payload: any): ResolvedTarget | null {
  const p = payload?.profile ?? payload
  if (!p || num(p.id) === null) return null
  return {
    name: str(p.name),
    level: num(p.level),
    // ⚠️ Torn sends 0 for "no faction", not null. Storing 0 would group every
    // unfactioned target under a faction that does not exist, and the batched
    // refresh would then make a call for it.
    factionId: num(p.faction_id) ? String(p.faction_id) : null,
    statusState: str(p.status?.state),
    statusUntil: num(p.status?.until) || null,
    statusDescription: str(p.status?.description),
  }
}

/** Read `GET /faction/{id}/basic` for the display name. */
export function readFactionName(payload: any): string | null {
  return str(payload?.basic?.name ?? payload?.name)
}

/**
 * Read `GET /faction/{id}/members` into id → status.
 *
 * One call covers every target in that faction, which is the whole reason the
 * refresh groups by faction at all.
 */
export function readFactionMembers(payload: any): Map<string, ResolvedTarget> {
  const out = new Map<string, ResolvedTarget>()
  const members = Array.isArray(payload?.members) ? payload.members : []
  for (const m of members) {
    const id = num(m?.id)
    if (id === null) continue
    out.set(String(id), {
      name: str(m.name),
      level: num(m.level),
      // The caller knows which faction it asked about; the member rows do not
      // repeat it.
      factionId: null,
      statusState: str(m.status?.state),
      statusUntil: num(m.status?.until) || null,
      statusDescription: str(m.status?.description),
    })
  }
  return out
}

/** A single field that changed, for the audit trail. */
export interface FieldChange { field: string; from: string | null; to: string | null }

/**
 * What changed about a target that is worth recording.
 *
 * ⚠️ Only **identity** changes are audited — a name or a faction. Status churns
 * every few minutes by design, and writing an audit row per hospital timer
 * would bury the three things the trail exists to answer (who added this, who
 * changed it, who removed it) under thousands of rows nobody asked for.
 *
 * ⚠️ A null incoming value is "Torn did not say", never "it changed to
 * nothing". Recording a rename from a failed read would be a lie in a record
 * whose whole value is that it is not.
 */
export function identityChanges(
  before: { target_name: string | null; faction_id: string | null },
  after: ResolvedTarget
): FieldChange[] {
  const changes: FieldChange[] = []
  if (after.name !== null && after.name !== before.target_name) {
    changes.push({ field: 'target_name', from: before.target_name, to: after.name })
  }
  // ⚠️ Compared as strings. Torn sends a number, the column is text, and a
  // mixed-type compare reports a change on every single refresh.
  const beforeFaction = before.faction_id === null ? null : String(before.faction_id)
  if (after.factionId !== beforeFaction) {
    changes.push({ field: 'faction_id', from: beforeFaction, to: after.factionId })
  }
  return changes
}

/**
 * Does this target need leadership to look at it again?
 *
 * ⚠️ The gate CANNOT be decided once at add time. A target's faction is only
 * known after a lookup, and it can change afterwards — somebody joins the
 * family a month after being added. So the refresh re-evaluates, and an active
 * target that has moved into a watched faction goes back to pending.
 *
 * ⚠️ It only ever moves a target INTO pending, never out. Leadership approving
 * somebody is a decision; silently un-approving them on the next sweep because
 * they left the watched faction would undo it without anybody asking.
 */
export function regateOnFactionChange(
  current: { state: string; faction_id: string | null },
  nextFactionId: string | null,
  isWatched: (factionId: string | null) => boolean
): 'pending_approval' | null {
  if (current.state !== 'active') return null
  if (!isWatched(nextFactionId)) return null
  // Already in a watched faction and already approved — leave the decision be.
  if (isWatched(current.faction_id)) return null
  return 'pending_approval'
}
