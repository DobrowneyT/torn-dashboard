// Why a dibs claim ended (#530).
//
// ⚠️ **One vocabulary, in one place.** Five different code paths tombstone a
// dibs row and each knows something the others do not; if each spelled its own
// reason inline, the report reading them would be guessing at a schema that
// nobody owns. The column is free text precisely so this file can own it
// without a migration per reason.
//
// ⚠️ **These describe the HOLDER'S behaviour, not the outcome.** Whether the
// claim converted is a question for `faction_attacks` — the status sweep that
// releases a claim sees only that the target's hospital status moved, never who
// moved it. Keeping the two apart is the whole point: `window` means "they had
// their head start and did not swing", which stays true whether or not somebody
// else got there first.

export const DIBS_RELEASE_REASONS = {
  /** #107 — target was already in hospital and their `until` jumped. Somebody
   *  hit them again. ⚠️ Says nothing about WHO; that needs the attack join. */
  rehospitalised: 'rehospitalised',
  /** The target stopped being attackable at all (hospital, jail, travel) while
   *  the claim was live, so the claim had no job left. */
  spent: 'spent',
  /** #106 — the target surfaced, the holder got their head start, and the
   *  countdown lapsed with the target still up. ⚠️ THE "did not swing" signal,
   *  and the one the report leans on hardest. */
  window: 'window',
  /** The holder claimed a different target, which releases their previous one
   *  under the single-dibs rule. Repeated often, it reads as target-hopping. */
  superseded: 'superseded',
  /** The holder gave it back deliberately. */
  manual: 'manual',
  /** Somebody with leadership rights released a claim that was not theirs. */
  admin: 'admin',
  /** The War Room board was cleared wholesale (war setup/reset). ⚠️ Not a
   *  judgement about anybody — must never count against a holder. */
  reset: 'reset',
} as const

export type DibsReleaseReason = typeof DIBS_RELEASE_REASONS[keyof typeof DIBS_RELEASE_REASONS]

/** Every reason, for validation and for exhaustiveness tests. */
export const ALL_DIBS_RELEASE_REASONS: DibsReleaseReason[] =
  Object.values(DIBS_RELEASE_REASONS)

/**
 * Reasons that say nothing about how the holder behaved.
 *
 * ⚠️ A report that counts these against a member is accusing them of something
 * the data does not support. `reset` is the board being wiped; `spent` is the
 * target going down, which is frequently somebody else's doing or the target's
 * own (a self-hospitalisation to dodge). Neither is a failure to convert.
 */
export const BLAMELESS_DIBS_REASONS: ReadonlySet<string> = new Set([
  DIBS_RELEASE_REASONS.reset,
  DIBS_RELEASE_REASONS.spent,
  DIBS_RELEASE_REASONS.rehospitalised,
])

/** A stored value we recognise. ⚠️ NULL (pre-0072) is not a reason — it is the
 *  absence of one, and must read as "unknown" rather than as any default. */
export function isDibsReleaseReason(v: unknown): v is DibsReleaseReason {
  return typeof v === 'string' && (ALL_DIBS_RELEASE_REASONS as string[]).includes(v)
}
