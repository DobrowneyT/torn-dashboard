// Assist-request auto-expiry (#523, reshaped by #617). Mirrors
// warRoomDibsExpiry.ts's "snapshot before the tick's member sync, sweep after"
// seam deliberately, because an assist marker means the same thing a dib's
// countdown does: "this is only meaningful while the fight is still on."
//
// ⚠️ It no longer mirrors dibs' table SHAPE. Since #617 counts live on the
// target with a `*_raised_at` per kind, so expiry resets a count to zero
// rather than tombstoning a row, and it runs per kind rather than per row.
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
     FROM war_room_assist_counts_v2 a
     LEFT JOIN war_room_state_v2 s ON s.member_id = a.target_id
     WHERE a.help_wanted > 0 OR a.smoke_wanted > 0 OR a.tear_wanted > 0`
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
 *  Short timeout — a kind's `*_raised_at` (stamped at every raise) falls
 *  outside the window → clear that kind, whatever the target's status.
 */
export async function sweepAssistsExpiry(
  db: pg.Pool,
  prevStatus: Map<number, TargetStatus | null>
): Promise<any[]> {
  const live = await db.query(
    `SELECT a.target_id, s.state->'status' AS status
     FROM war_room_assist_counts_v2 a
     LEFT JOIN war_room_state_v2 s ON s.member_id = a.target_id
     WHERE a.help_wanted > 0 OR a.smoke_wanted > 0 OR a.tear_wanted > 0`
  )

  const fightEnded: number[] = []
  for (const row of live.rows) {
    const prev = prevStatus.get(Number(row.target_id)) ?? null
    const next = (row.status as TargetStatus) ?? null
    if (attackable(prev) && !attackable(next)) fightEnded.push(Number(row.target_id))
  }

  // ⚠️ The window is a faction setting, read here rather than passed in, so the
  // sweep and the raise cannot disagree about it. 0 means "never auto-expire".
  const cfg = await db.query('SELECT assist_expiry_seconds AS secs FROM war_room_config_v2 WHERE id = 1')
  const raw = Number(cfg.rows[0]?.secs)
  const expirySecs = Number.isFinite(raw) ? raw : ASSIST_EXPIRY_SECONDS

  // ⚠️ #617: expiry is per KIND, on its own `*_raised_at`. A smoke asked for
  // four minutes ago and a tear asked for just now must not age out together,
  // which a single row-level deadline could not express.
  //
  // ⚠️ An expiring kind is CLEARED, not decremented. A count raised twice
  // shares one timestamp, so decaying it a unit at a time would drip on a clock
  // matching neither raise — and a stale count is worse than a lost one,
  // because it sends people to a fight that is already over.
  //
  // A fight ending drops every kind at once: hospital, jail and travelling all
  // put the target out of reach just as completely, whatever was asked for.
  //
  // ⚠️ The WHERE matches only rows that will actually CHANGE. Matching every
  // live row and filtering afterwards would broadcast a no-op for every
  // assisted target on every tick — at 1 Hz, to every connected socket.
  const lapsed = (kind: string) =>
    `($2::int > 0 AND a.${kind}_wanted > 0 AND a.${kind}_raised_at IS NOT NULL
      AND a.${kind}_raised_at <= now() - make_interval(secs => $2::int))`
  const ended = `($1::bigint[] @> ARRAY[a.target_id])`
  const clears = (kind: string) => `CASE WHEN ${ended} OR ${lapsed(kind)} THEN 0 ELSE a.${kind}_wanted END`

  const expired = await db.query(
    `UPDATE war_room_assist_counts_v2 a SET
       help_wanted  = ${clears('help')},
       smoke_wanted = ${clears('smoke')},
       tear_wanted  = ${clears('tear')},
       -- Contributors matter only while a help count is outstanding; clearing
       -- them with it keeps a stale id from blocking a later, genuine answer.
       help_raised_by = CASE WHEN ${ended} OR ${lapsed('help')} THEN '{}'::bigint[]
                            ELSE a.help_raised_by END,
       updated_at = now()
     WHERE (${ended} AND (a.help_wanted > 0 OR a.smoke_wanted > 0 OR a.tear_wanted > 0))
        OR ${lapsed('help')} OR ${lapsed('smoke')} OR ${lapsed('tear')}
     RETURNING a.*`,
    [fightEnded, expirySecs]
  )
  return expired.rows
}
