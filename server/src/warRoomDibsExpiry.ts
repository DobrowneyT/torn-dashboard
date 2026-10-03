// Dibs auto-expiry (#106 + #107). The ticker watches each live-dibbed
// target's hospital status across ticks and releases claims the holder isn't
// converting. Kept beside the ticker (not inside syncWarRoomMemberStates) so
// the shared member-sync stays clean and its broadcast payload unpolluted —
// this reads only the handful of dibbed targets, before and after the sync.
import type pg from 'pg'

/** Hospital status as stored in war_room_state_v2.state->'status'. */
interface TargetStatus {
  state?: string
  until?: number | string | null
}

/** Default #106 window: release ~30s after the target is first seen out. */
export const DIBS_EXPIRY_SECONDS = 30

function until(s: TargetStatus | null | undefined): number | null {
  const n = Number(s?.until)
  return Number.isFinite(n) ? n : null
}

/**
 * Snapshot the currently-stored hospital status of every live-dibbed target.
 * Call this BEFORE the tick's member sync — it is the "previous observation"
 * the post-sync sweep diffs against.
 */
export async function snapshotDibbedStatus(db: pg.Pool): Promise<Map<number, TargetStatus | null>> {
  const res = await db.query(
    `SELECT d.target_id, s.state->'status' AS status
     FROM war_room_dibs_v2 d
     LEFT JOIN war_room_state_v2 s ON s.member_id = d.target_id
     WHERE d.deleted_at IS NULL`
  )
  const prev = new Map<number, TargetStatus | null>()
  for (const r of res.rows) prev.set(Number(r.target_id), (r.status as TargetStatus) ?? null)
  return prev
}

/**
 * Apply the auto-expiry rules against the freshly-synced state and return the
 * dibs rows tombstoned this tick (for a dibs-channel broadcast).
 *
 *  #107 — target still in hospital but its until jumped up → drop now.
 *  Okay→Hospital — the target went down; the claim is spent → drop now.
 *         ⚠️ Reverses the original "a converted claim is kept" rule — see the
 *         note at the branch. Without it a successful hit became a permanent
 *         reservation, because the re-hospitalisation disarmed the countdown
 *         and nothing else ever released the claim.
 *  #106 — target left hospital (Hospital→Okay) → schedule a release
 *         `expirySeconds` out; a later tick's sweep drops it if still held.
 *  #376 — target is no longer Okay → disarm any scheduled release. The
 *         countdown only ever means "alive and unconverted"; going back down
 *         ends that, and the next time they surface they get a fresh window.
 */
export async function sweepDibsExpiry(
  db: pg.Pool,
  prevStatus: Map<number, TargetStatus | null>,
  expirySeconds = DIBS_EXPIRY_SECONDS
): Promise<any[]> {
  // ⚠️ 0 means auto-drop is OFF: claims stand until released or the target is
  // hospitalised. Returning early rather than treating 0 as "expire instantly"
  // — which is what a naive clamp to the floor would have produced, and would
  // have dropped every dib the moment it was taken.
  if (Number(expirySeconds) <= 0) return []

  const live = await db.query(
    `SELECT d.id, d.target_id, d.auto_expire_at, s.state->'status' AS status
     FROM war_room_dibs_v2 d
     LEFT JOIN war_room_state_v2 s ON s.member_id = d.target_id
     WHERE d.deleted_at IS NULL`
  )

  const dropNow: number[] = []
  const schedule: number[] = []
  const disarm: number[] = []
  for (const row of live.rows) {
    const prev = prevStatus.get(Number(row.target_id)) ?? null
    const next = (row.status as TargetStatus) ?? null
    const wasHospital = prev?.state === 'Hospital'
    const wasOkay = prev?.state === 'Okay'

    // #376 — the target is no longer alive, so any countdown against this
    // claim has lost its premise and must be disarmed.
    //
    // Both countdowns mean the same thing: "the target is up and the holder
    // has not converted; free the claim in N seconds." Neither survives the
    // target going back down. The deadline used to be set once and never
    // cleared, which turned it into a landmine: it lapsed silently while the
    // target was in hospital, and the sweep then dropped the claim the instant
    // they came out again — no window at all, which is exactly what a farm-
    // mode holder reported. Farm mode runs head-on into it, because the loop
    // IS hospital → out → hit → hospital → out.
    if (next?.state !== 'Okay' && row.auto_expire_at != null) disarm.push(row.id)

    if (wasHospital && next?.state === 'Hospital') {
      const pu = until(prev)
      const nu = until(next)
      if (pu !== null && nu !== null && nu > pu) dropNow.push(row.id) // #107
    } else if (wasOkay && next?.state === 'Hospital') {
      // ⚠️ A CLAIM IS SPENT THE MOMENT THE TARGET GOES DOWN (MonChoon,
      // 2026-10-03, mid-war). This reverses the original #159 rule, which
      // deliberately let a holder who converted KEEP the claim so they could
      // farm the same target. In a live war that turned every successful hit
      // into a permanent reservation:
      //
      //   out of hospital → #106 arms 30s → holder hits → back to hospital
      //   → #376 disarms the countdown → claim held → repeat forever
      //
      // Observed on forge during a war: 20 of 22 live claims sat on
      // hospitalised targets, most with the HOLDER'S OWN NAME in "Attacked
      // by", one held for 33 minutes — blocking everybody else from a target
      // the holder had already taken.
      //
      // ⚠️ This is also the case #107 could never catch. #107 only fires on
      // Hospital→Hospital, and a target who is hit after surfacing passes
      // through Okay, so `wasHospital` is false and the until-increase check
      // is skipped entirely.
      //
      // It does not matter whether the holder landed the hit or somebody else
      // did: either way the target is down and the claim has done its job. A
      // farmer who wants the next cycle re-claims, which is the point — it
      // puts them back in the queue instead of ahead of it.
      dropNow.push(row.id)
    } else if (wasHospital && next?.state === 'Okay' && row.auto_expire_at == null) {
      schedule.push(row.id) // #106
    }
  }

  // Disarm before the tombstone sweep runs, so a deadline that lapsed while
  // the target was down cannot be acted on in the same tick it is cleared.
  if (disarm.length > 0) {
    await db.query(
      `UPDATE war_room_dibs_v2 SET auto_expire_at = NULL, updated_at = now() WHERE id = ANY($1)`,
      [disarm]
    )
  }

  if (schedule.length > 0) {
    await db.query(
      `UPDATE war_room_dibs_v2 SET auto_expire_at = now() + make_interval(secs => $2), updated_at = now()
       WHERE id = ANY($1)`,
      [schedule, expirySeconds]
    )
  }

  // Tombstone the immediate #107 drops plus any expiry window that has lapsed
  // WHILE THE TARGET IS STILL ALIVE. The alive gate matters for the #159
  // claim-timeout: a holder who actually killed the target inside the window
  // (target now in hospital) keeps the dib — the countdown only frees claims
  // that were never converted. #106's hospital-exit window lapses on an Okay
  // target too, so this gate is a no-op there.
  const expired = await db.query(
    `UPDATE war_room_dibs_v2 d SET deleted_at = now(), updated_at = now()
     WHERE d.deleted_at IS NULL
       AND (
         d.id = ANY($1)
         OR (
           d.auto_expire_at IS NOT NULL AND d.auto_expire_at <= now()
           AND EXISTS (
             SELECT 1 FROM war_room_state_v2 s
             WHERE s.member_id = d.target_id
               AND s.state->'status'->>'state' = 'Okay'
           )
         )
       )
     RETURNING d.*`,
    [dropNow]
  )
  return expired.rows
}
