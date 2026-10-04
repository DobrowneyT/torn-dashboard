// Claiming a target on the Book of Grudges (#892).
//
// ⚠️ **The rules below are lifted from `warRoomDibsExpiry.ts`, which earned
// each of them in a live war.** The code is NOT shared: war dibs are
// war-scoped state with their own job and broadcast, and the two must not be
// able to break each other. Shared reasoning, separate implementation.
//
// ⚠️ The single most important rule, and the least obvious: **a missing status
// reading must never release anything.** In the War Room the guard is
// `typeof next?.state === 'string'`, and it is load-bearing — one failed sweep
// would otherwise free every claim at once, mid-chain, with no explanation.

/** A status reading as stored on a target. */
export interface Status {
  state?: string | null
  until?: number | string | null
}

/** How long a holder keeps a claim after their target comes out of hospital. */
export const CLAIM_HEADSTART_SECONDS = 30

export type ReleaseReason = 'spent' | 'window' | 'manual' | 'taken_over'

export interface ClaimDecision {
  /** Release now, with a recorded reason. */
  release: ReleaseReason | null
  /** Arm the head-start countdown (the target just came out). */
  arm: boolean
}

const untilOf = (s: Status | null | undefined): number | null => {
  const n = Number(s?.until)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * What should happen to one live claim, given what changed.
 *
 * `prev` is what the claim last saw; `next` is the fresh reading.
 */
export function decideClaim(
  prev: Status | null | undefined,
  next: Status | null | undefined,
  opts: { armed: boolean; expiresAt?: number | null; nowMs?: number } = { armed: false }
): ClaimDecision {
  const now = opts.nowMs ?? Date.now()

  // ⚠️ NO READING, NO DECISION. A sweep that failed, a target Torn would not
  // answer for, a brand-new claim with nothing to compare — none of these are
  // evidence that anything happened. Releasing here is how one bad minute
  // frees every claim on the board at once.
  if (typeof next?.state !== 'string') return { release: null, arm: false }

  const prevState = typeof prev?.state === 'string' ? prev.state : null
  const wasHospital = prevState === 'Hospital'
  const wasOkay = prevState === 'Okay'

  // ⚠️ Hospital → still Hospital, but the timer JUMPED UP. Somebody else hit
  // them, so the holder's reservation is already spent (#107).
  if (wasHospital && next.state === 'Hospital') {
    const before = untilOf(prev)
    const after = untilOf(next)
    if (before !== null && after !== null && after > before) {
      return { release: 'spent', arm: false }
    }
    return { release: null, arm: false }
  }

  // ⚠️ Okay → anything else. The target stopped being attackable: somebody got
  // there, or they jailed or flew. Either way the claim is spent.
  //
  // This REVERSES the original "a converted claim is kept" rule. Without it a
  // successful hit became a permanent reservation, because re-hospitalisation
  // disarmed the countdown and nothing else ever released the claim.
  if (wasOkay && next.state !== 'Okay') return { release: 'spent', arm: false }

  // ⚠️ Hospital → Okay is the reservation PAYING OFF, so the claim is kept and
  // a short head start is armed instead. Releasing here would hand the target
  // to whoever happened to be looking at the moment the holder's wait ended.
  if (wasHospital && next.state === 'Okay' && !opts.armed) {
    return { release: null, arm: true }
  }

  // The head start has run out and they never took it.
  if (opts.armed && opts.expiresAt != null && now >= opts.expiresAt) {
    return { release: 'window', arm: false }
  }

  return { release: null, arm: false }
}

/** Can this member drop this claim? */
export function canRelease(
  claim: { member_id: string },
  viewer: { memberId: string; isLeadership: boolean }
): boolean {
  // ⚠️ Leadership can free a claim somebody forgot about. During a chain a
  // stuck reservation on a good target costs the whole faction, and waiting
  // for the holder to come back online is not an option.
  return viewer.isLeadership || String(claim.member_id) === String(viewer.memberId)
}
