// #168 — per-(crime, member) participation log. crime_slots is keyed by
// position and gets refilled, so a member who leaves a crime is overwritten
// there and the time they'd banked is lost. This keeps one segment per
// (crime, member): joined_at (exact, from slot data) → left_at, plus a
// `completed` flag for members present when the crime executed. The crimes-sync
// calls this for each crime it processes, inside its transaction.
import type pg from 'pg'

interface Slot {
  user?: { id?: number | string | null; joined_at?: number | null } | null
}

export interface ParticipationCrime {
  id: number | string
  status?: string
  slots?: Slot[]
  executed_at?: number | null
  expired_at?: number | null
}

/**
 * Reconcile the participation segments for one crime against its current slots.
 *
 * - Each current occupant gets/keeps an OPEN segment (joined_at from the slot).
 *   If the crime has resolved, the segment is closed at the resolve time:
 *   Executed ⇒ `completed = true`; Expired ⇒ `completed = false`.
 * - Any member holding an OPEN segment who is no longer an occupant LEFT the
 *   crime: close it (left_at = resolve time if the crime resolved, else now),
 *   `completed = false`. Members who already left stay closed (left-early).
 */
export async function updateCrimeParticipation(
  dbc: pg.PoolClient,
  crime: ParticipationCrime
): Promise<void> {
  const crimeId = String(crime.id)
  const occupants = (crime.slots ?? [])
    .map((s) => s.user)
    .filter((u): u is { id: number | string; joined_at?: number | null } => !!u && u.id != null)
    .map((u) => ({ id: String(u.id), joined_at: Number(u.joined_at ?? 0) }))
  const occupantIds = occupants.map((o) => o.id)

  const resolved = crime.status === 'Executed' || crime.status === 'Expired'
  const completedFlag = crime.status === 'Executed'
  const resolveTime = crime.executed_at ?? crime.expired_at ?? null

  for (const o of occupants) {
    if (resolved) {
      await dbc.query(
        `INSERT INTO crime_participation_v2 (crime_id, member_id, joined_at, left_at, completed, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (crime_id, member_id) DO UPDATE SET
           joined_at = EXCLUDED.joined_at, left_at = EXCLUDED.left_at,
           completed = EXCLUDED.completed, updated_at = now()`,
        [crimeId, o.id, o.joined_at, resolveTime, completedFlag]
      )
    } else {
      // Open (or re-open, if they rejoined) the segment for a current occupant.
      await dbc.query(
        `INSERT INTO crime_participation_v2 (crime_id, member_id, joined_at, left_at, completed, updated_at)
         VALUES ($1, $2, $3, NULL, false, now())
         ON CONFLICT (crime_id, member_id) DO UPDATE SET
           joined_at = EXCLUDED.joined_at, left_at = NULL, completed = false, updated_at = now()`,
        [crimeId, o.id, o.joined_at]
      )
    }
  }

  // Close open segments for members no longer in the crime (they left early).
  await dbc.query(
    `UPDATE crime_participation_v2
        SET left_at = COALESCE($2, extract(epoch FROM now())::bigint), updated_at = now()
      WHERE crime_id = $1 AND left_at IS NULL AND NOT (member_id = ANY($3))`,
    [crimeId, resolveTime, occupantIds]
  )
}
