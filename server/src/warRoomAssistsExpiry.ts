// Assist-request auto-expiry (#523). Mirrors warRoomDibsExpiry.ts's sweep
// pattern deliberately — same table shape (auto_expire_at + deleted_at), same
// "snapshot before the tick's member sync, sweep after" seam — because an
// assist marker means the same thing a dib's countdown does: "this is only
// meaningful while the fight is still on."
//
// Simpler than dibs' sweep in one way: there is no arm/disarm dance. A dib's
// countdown only starts once the target surfaces (Hospital→Okay) because
// dibs is about claiming a KILL, which can't happen while they're down. An
// assist request is about the fight itself, live, so its countdown starts the
// moment it's raised — see the INSERT in warRoomWrites.ts.
import type pg from 'pg'

/** Hospital status as stored in war_room_state_v2.state->'status'. */
interface TargetStatus {
  state?: string
  until?: number | string | null
}

/**
 * A raised hand is only useful for the length of the fight it is about.
 *
 * ⚠️ This was 120s, on the reasoning that "Torn fights are seconds, not
 * minutes". That was wrong: a Torn fight runs to FIVE MINUTES, and a captured
 * log shows a real one already 132 seconds old — twelve seconds past the point
 * where the request had silently vanished (#591). The hand went down while the
 * fight was still going, which is the one moment it must not.
 *
 * Now the default rather than the rule: `assist_expiry_seconds` in
 * war_room_config_v2 overrides it, the same way `dibs_expiry_seconds` does for
 * dibs. They are deliberately SEPARATE knobs — a dib's window measures how long
 * a claim survives after the target surfaces, so sharing this value would keep
 * claims blocking other claimers for five minutes.
 */
export const ASSIST_EXPIRY_SECONDS = 300

/**
 * The states in which a target can still be attacked.
 *
 * Anything else means the fight is over: hospital, jail, and travelling all put
 * the target out of reach just as completely. Only Hospital used to count, so a
 * target who jailed or flew out left every assist against them sitting for the
 * full window (#591).
 */
const ATTACKABLE = new Set(['Okay'])

function attackable(status: TargetStatus | null | undefined): boolean {
  // An unknown state is treated as attackable on purpose: the alternative is
  // dropping live requests every time the roster momentarily has no status for
  // someone, and a stale marker costs less than a vanished one mid-fight.
  const state = status?.state
  return state === undefined || state === null || ATTACKABLE.has(state)
}

/**
 * Snapshot the currently-stored hospital status of every live-assisted
 * target. Call this BEFORE the tick's member sync — it is the "previous
 * observation" the post-sync sweep diffs against.
 */
export async function snapshotAssistedStatus(db: pg.Pool): Promise<Map<number, TargetStatus | null>> {
  const res = await db.query(
    `SELECT a.target_id, s.state->'status' AS status
     FROM war_room_assists_v2 a
     LEFT JOIN war_room_state_v2 s ON s.member_id = a.target_id
     WHERE a.deleted_at IS NULL`
  )
  const prev = new Map<number, TargetStatus | null>()
  for (const r of res.rows) prev.set(Number(r.target_id), (r.status as TargetStatus) ?? null)
  return prev
}

/**
 * Apply the auto-expiry rules against the freshly-synced state and return the
 * assist rows tombstoned this tick (for an 'assist'-channel broadcast).
 *
 *  Fight-ended — the target TRANSITIONS out of attackable (was Okay, now
 *  Hospital/Jail/Traveling/Abroad/…) → drop every live assist against them
 *  now. Already being unattackable across two ticks is not a new ending: an
 *  assist raised while the target happens to be mid-hospital-stay keeps its
 *  own timeout instead.
 *
 *  Short timeout — auto_expire_at (armed at creation, always) lapses →
 *  drop, whatever the target's status.
 */
export async function sweepAssistsExpiry(
  db: pg.Pool,
  prevStatus: Map<number, TargetStatus | null>
): Promise<any[]> {
  const live = await db.query(
    `SELECT a.id, a.target_id, s.state->'status' AS status
     FROM war_room_assists_v2 a
     LEFT JOIN war_room_state_v2 s ON s.member_id = a.target_id
     WHERE a.deleted_at IS NULL`
  )

  const fightEnded: number[] = []
  for (const row of live.rows) {
    const prev = prevStatus.get(Number(row.target_id)) ?? null
    const next = (row.status as TargetStatus) ?? null
    if (attackable(prev) && !attackable(next)) fightEnded.push(row.id)
  }

  const expired = await db.query(
    `UPDATE war_room_assists_v2 a SET deleted_at = now(), updated_at = now()
     WHERE a.deleted_at IS NULL
       AND (
         a.id = ANY($1)
         OR (a.auto_expire_at IS NOT NULL AND a.auto_expire_at <= now())
       )
     RETURNING a.*`,
    [fightEnded]
  )
  return expired.rows
}
