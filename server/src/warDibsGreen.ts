// Was a dibs claim ever on a GREEN target, and therefore not a reservation at
// all? (#935)
//
// MonChoon: *"Whenever a player is online and okay they are fair game and not
// beholden to the farming/dibs system its a free for all on them. We dont want
// them to try flying away or making them unavailable in anyway, so its
// encouraged to hit them ASAP."*
//
// ⚠️ **This decides whether somebody gets called a thief**, so it fails toward
// "not a steal". The column it feeds (`took_from_others`) is an accusation with
// a name on it, and the cost of wrongly clearing one hit is far lower than the
// cost of wrongly accusing a member who did exactly what they were told to do.
//
// ⚠️ **Claim-time status alone cannot answer it.** The typical sequence is:
//
//   1. target in hospital, OFFLINE  → somebody claims them (a real reservation)
//   2. target logs in, STILL in hospital → the claim is untouched
//   3. target leaves hospital: Okay + Online → fair game
//   4. a teammate hits them
//
// At claim time they were Hospital + Offline. A design that looked only there
// would call step 4 a steal — which is the exact dispute this exists to settle.
// Hence two observations per claim: how it began, and what happened when the
// target surfaced.

/** Torn's `last_action.status` values. */
export const ONLINE = 'Online'
export const IDLE = 'Idle'
export const OFFLINE = 'Offline'

/**
 * Which `last_action.status` values count as "at the keyboard".
 *
 * ⚠️ **`Idle` is deliberately NOT green**, and this is the tunable to argue
 * about rather than a fact. MonChoon, 2026-10-09: *"For now lets go with Online
 * only, not idle."* An idle player is often still present, so including them
 * would widen the free-for-all — on the live roster at the time this was
 * written that was 8 more members out of 190. Change the set, not the callers.
 */
export const GREEN_ONLINE_STATES: ReadonlySet<string> = new Set([ONLINE])

/** A target is attackable-and-present only in this state. */
export const OKAY = 'Okay'

export const CLAIM_KINDS = {
  /** The target was green while this claim was live, so the claim never
   *  reserved anything. ⚠️ Can never yield a steal, on either axis. */
  greenMeansGo: 'green-means-go',
  /** A genuine hold: the target was unavailable and the claim queued the hit. */
  reservation: 'reservation',
  /** ⚠️ Predates #935's columns. Must read as NEITHER — defaulting it would
   *  silently reclassify every claim in the back-history as one or the other,
   *  and this field decides who gets accused. */
  unknown: 'unknown',
} as const

export type ClaimKind = typeof CLAIM_KINDS[keyof typeof CLAIM_KINDS]

export interface GreenObservations {
  /** `status.state` when the claim was taken. */
  claim_state?: string | null
  /** `last_action.status` when the claim was taken. */
  claim_online?: string | null
  /** Did the target leave hospital while online, during this claim? */
  surfaced_online?: boolean | null
  /** When they left hospital. Evidence for a dispute, not used to decide. */
  surfaced_at?: unknown
}

/** Is this `last_action.status` "at the keyboard"? */
export function isGreenOnline(lastAction: unknown): boolean {
  return typeof lastAction === 'string' && GREEN_ONLINE_STATES.has(lastAction)
}

/** Was the target green at the moment the claim was taken? */
export function claimedGreen(row: GreenObservations): boolean {
  return row?.claim_state === OKAY && isGreenOnline(row?.claim_online)
}

/**
 * What kind of claim this was.
 *
 * ⚠️ `unknown` requires BOTH observations to be absent. A row with
 * `surfaced_online: false` and a recorded claim state is fully observed — the
 * target simply never surfaced online — and must read as a `reservation`, not as
 * unknown. Collapsing those would discard the answer in the common case.
 */
export function claimKind(row: GreenObservations | null | undefined): ClaimKind {
  if (!row) return CLAIM_KINDS.unknown
  const observedClaim = row.claim_state != null || row.claim_online != null
  const observedSurface = row.surfaced_online != null
  if (!observedClaim && !observedSurface) return CLAIM_KINDS.unknown
  if (claimedGreen(row)) return CLAIM_KINDS.greenMeansGo
  if (row.surfaced_online === true) return CLAIM_KINDS.greenMeansGo
  return CLAIM_KINDS.reservation
}

/** Can a hit on this claim's target be a steal at all? */
export function canBeStolen(row: GreenObservations | null | undefined): boolean {
  // ⚠️ `unknown` CAN be stolen, so the back-history keeps behaving as it did
  // before #935 rather than having a month of steals silently cleared. The new
  // rule applies to claims we actually observed.
  return claimKind(row) !== CLAIM_KINDS.greenMeansGo
}

/**
 * The sentence a lead can put in front of somebody who says their dibs was
 * taken (#935).
 *
 * MonChoon: *"sometimes members claim 'my dibs was taken' or 'someone stole my
 * kill' and we need to justify it that they were online so the dibs was no
 * longer relevant. So, if we can track and document that, it would be great."*
 *
 * ⚠️ Returns null when there is nothing defensible to say, rather than a vague
 * reassurance. An argument needs the timestamp or it is just an assertion.
 */
export function explainGreen(
  row: GreenObservations | null | undefined,
  fmtTime: (v: unknown) => string = String
): string | null {
  if (claimKind(row) !== CLAIM_KINDS.greenMeansGo) return null
  if (row?.surfaced_online === true) {
    const when = row.surfaced_at != null ? ` at ${fmtTime(row.surfaced_at)}` : ''
    return `Target came out of hospital${when} while online — green, so the claim no longer applied.`
  }
  return 'Target was already Okay and online when the claim was taken — green, so the claim never reserved them.'
}
