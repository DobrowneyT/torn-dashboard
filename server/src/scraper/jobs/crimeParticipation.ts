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

  // Torn's executed statuses (#392). This matched 'Executed' for months — a
  // status Torn does not send — so the resolved branch never ran in production
  // and `completed` was false on every row in every tenant. The tests could not
  // catch it because they drove the tracker with the same invented status.
  //
  // 'Failed' and 'Failure' are both here for the same reason the rest of the
  // codebase carries both: a failed crime still EXECUTED, so its members
  // completed it. 'Executed' stays accepted in case it ever shows up.
  const EXECUTED = new Set(['Successful', 'Failed', 'Failure', 'Executed'])
  const completedFlag = EXECUTED.has(crime.status ?? '')
  const resolved = completedFlag || crime.status === 'Expired'
  const resolveTime = crime.executed_at ?? crime.expired_at ?? null
  // A member who left a crime that is STILL Recruiting/Planning did not leave
  // "at" the crime's expired_at — that field is the crime's future deadline,
  // stamped on every crime from creation, not evidence anything has actually
  // happened yet. Falling back to it unconditionally credited a departed
  // member with banked time running out to a date that hadn't occurred,
  // sometimes days past the payout window's own end. Only a genuinely
  // RESOLVED crime's resolveTime is a real "when this stint ended"; an
  // unresolved one closes at COALESCE(null, now()) below, i.e. "just now".
  const closeTime = resolved ? resolveTime : null

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
    [crimeId, closeTime, occupantIds]
  )
}
