// Dibs auto-expiry (#106 + #107). The ticker watches each live-dibbed
// target's hospital status across ticks and releases claims the holder isn't
// converting. Kept beside the ticker (not inside syncWarRoomMemberStates) so
// the shared member-sync stays clean and its broadcast payload unpolluted —
// this reads only the handful of dibbed targets, before and after the sync.
import type pg from 'pg'
import { DIBS_RELEASE_REASONS } from './warDibsReasons.js'
import { isGreenOnline } from './warDibsGreen.js'

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
 *  Okay→anything-else — the target stopped being attackable (hospital, jail,
 *         travel); the claim is spent → drop now. ⚠️ Reverses the original
 *         "a converted claim is kept" rule — see the note at the branch.
 *         Without it a successful hit became a permanent reservation, because
 *         the re-hospitalisation disarmed the countdown and nothing else ever
 *         released the claim. Hospital→Okay is deliberately NOT included: that
 *         is the reservation paying off.
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
    // ⚠️ #935 — `last_action` is selected so the surfacing branch below can
    // record whether the target was AT THE KEYBOARD when they came out. That is
    // the moment claim-time status cannot see: a target claimed in hospital
    // while offline can still log in before they surface, and once they are
    // Okay and online they are fair game.
    `SELECT d.id, d.target_id, d.auto_expire_at, d.surfaced_online,
            s.state->'status' AS status,
            s.state->'last_action'->>'status' AS online
     FROM war_room_dibs_v2 d
     LEFT JOIN war_room_state_v2 s ON s.member_id = d.target_id
     WHERE d.deleted_at IS NULL`
  )

  // ⚠️ #107 and "spent" were ONE array before #530. They tombstone identically
  // but mean different things — a target hit again in hospital versus a target
  // that stopped being attackable — and the report needs them apart.
  const dropRehospitalised: number[] = []
  const dropSpent: number[] = []
  const schedule: number[] = []
  const disarm: number[] = []
  // ⚠️ #935 — claims whose target surfaced WHILE ONLINE. Collected separately
  // from `schedule` because the two answer different questions: schedule is
  // "start the countdown", this is "this claim stopped reserving anything".
  const surfacedGreen: number[] = []
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
      if (pu !== null && nu !== null && nu > pu) dropRehospitalised.push(row.id) // #107
    } else if (wasOkay && typeof next?.state === 'string' && next.state !== 'Okay') {
      // ⚠️ A CLAIM IS SPENT THE MOMENT THE TARGET STOPS BEING ATTACKABLE
      // (MonChoon, 2026-10-03, mid-war). Hospital, jail, travel — any of them.
      // The claim's only job is "this target is mine to hit"; the moment they
      // cannot be hit, it has no job, and holding it blocks everyone else.
      //
      // ⚠️ `typeof next?.state === 'string'` is load-bearing: a MISSING state
      // reading must not count as a downstate. Without it a sync hiccup that
      // left rows without a status would tombstone every live claim at once.
      // Unknown is not down.
      //
      // ⚠️ The one transition that must NOT release is Hospital→Okay — that is
      // the reservation paying off, and releasing there would kill the claim at
      // the exact moment it becomes useful. It is excluded by `wasOkay`.
      //
      // This reverses the original #159 rule, which deliberately let a holder
      // who converted KEEP the claim so they could farm the same target. In a
      // live war that turned every successful hit into a permanent
      // reservation:
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
      //
      // ⚠️ This makes #376's disarm below largely unreachable rather than
      // wrong. An armed countdown implies the target was recently Okay, and a
      // recently-Okay target that goes down is now dropped outright, so there
      // is usually no surviving claim left to disarm. It is kept as a cheap
      // guard against any path that still reaches it.
      dropSpent.push(row.id)
    } else if (wasHospital && next?.state === 'Okay' && row.auto_expire_at == null) {
      schedule.push(row.id) // #106
      // ⚠️ #935 — the moment that settles "my dibs was taken". The target just
      // came out of hospital; if they are at the keyboard they are fair game and
      // a teammate hitting them has stolen nothing.
      //
      // ⚠️ Stamped ONCE, on the first surfacing. A farm-mode target cycles
      // hospital → out → hit → hospital, and a later offline surfacing must not
      // erase the fact that they were online for an earlier one.
      if (row.surfaced_online == null && isGreenOnline(row.online)) surfacedGreen.push(row.id)
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

  // ⚠️ Before the tombstone sweep, so a claim released in this same tick still
  // carries the reason it was never really a reservation.
  if (surfacedGreen.length > 0) {
    await db.query(
      `UPDATE war_room_dibs_v2
          SET surfaced_online = true, surfaced_at = now(), updated_at = now()
        WHERE id = ANY($1) AND surfaced_online IS NULL`,
      [surfacedGreen]
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
  //
  // ⚠️ #530 — `release_reason` is stamped in the SAME statement that tombstones
  // the row. A second UPDATE could be interrupted between the two, leaving a
  // released claim with no reason, which the report would then have to treat as
  // pre-0072 history and silently exclude.
  const expired = await db.query(
    `UPDATE war_room_dibs_v2 d SET deleted_at = now(), updated_at = now(),
       release_reason = CASE
         WHEN d.id = ANY($1) THEN '${DIBS_RELEASE_REASONS.rehospitalised}'
         WHEN d.id = ANY($2) THEN '${DIBS_RELEASE_REASONS.spent}'
         ELSE '${DIBS_RELEASE_REASONS.window}'
       END
     WHERE d.deleted_at IS NULL
       AND (
         d.id = ANY($1)
         OR d.id = ANY($2)
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
    [dropRehospitalised, dropSpent]
  )
  return expired.rows
}
