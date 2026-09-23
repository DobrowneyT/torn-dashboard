/**
 * When did this member take off? (#774, rule from #330.)
 *
 * Torn gives **no arrival time for a traveller** — `status.until` is null,
 * unlike hospital and jail — so every ETA is counted from a departure we had to
 * witness ourselves. This is the rule for deciding whether we witnessed it.
 *
 * ⚠️ **Chain Watch owns this outright and shares nothing with the War Room.**
 * The War Room arrived at the same rule first, in a very different shape:
 * `war_room_state_v2` latches it inside an `ON CONFLICT … DO UPDATE` `CASE`,
 * against a row rewritten in place and only when something changed.
 * `member_activity_samples` is an append-only series with no row to update —
 * the previous observation is a previous *row* — so the decision happens before
 * the insert. Two implementations of one idea, each owned by the feature it
 * serves; #330 is worth reading for how the rule was learned, and is not a
 * dependency.
 */

/**
 * How recent the previous observation must be for a take-off edge to be
 * believed.
 *
 * ⚠️ Without this check, the first sample after a gap — a restart, a deploy, the
 * job simply not running — reads a member who departed hours ago as having just
 * left, and produces a confidently wrong arrival time. **Wrong is worse than
 * absent here**, because a lead waits on it. That is the #330 lesson exactly.
 */
export const TRAVEL_EDGE_TRUST_MS = 15 * 60_000

export interface TravelObservation {
  /** Torn's `status.state` — 'Traveling', 'Abroad', 'Okay', … */
  state: string | null
  /** When we took this reading. */
  sampledAt: number
  /** The departure already latched against it, if any. */
  departedAt: number | null
}

export const isTravelling = (state: string | null | undefined) => state === 'Traveling'

/** Travelling or already overseas — either way, not able to hit anything. */
export const isAway = (state: string | null | undefined) =>
  state === 'Traveling' || state === 'Abroad'

/**
 * The departure to record against a new observation.
 *
 * - Not travelling now → `null`. Landed, or never left; nothing to count from.
 * - Still travelling → keep whatever we already had, including `null`.
 * - Just took off, and the previous reading was recent → now.
 * - Just took off, but our last look was too long ago → `null`. We did not see
 *   the edge, and inventing one is the failure this guard exists to prevent.
 * - ⚠️ First ever sighting, already travelling → `null`. We did not witness the
 *   departure, so we have nothing to count from.
 */
export function latchDeparture(
  prev: TravelObservation | null,
  next: { state: string | null; sampledAt: number },
  trustMs: number = TRAVEL_EDGE_TRUST_MS,
): number | null {
  if (!isTravelling(next.state)) return null
  if (!prev) return null
  if (isTravelling(prev.state)) return prev.departedAt
  return next.sampledAt - prev.sampledAt <= trustMs ? next.sampledAt : null
}
