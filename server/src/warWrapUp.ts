// What to do about a war that has ended (#945).
//
// ⚠️ **The decision is separated from the doing** so it can be tested without
// running four scrapers. The job drives the jobs; this says what state a war is
// in given what is actually present.
//
// ⚠️ **Nothing is queued until every source is confirmed.** MonChoon: *"I don't
// want jt to post scoreless reports because the wrap up never completed it
// should just fail loudly."* A report is a permanent message in a thread with
// one member's name on it, so a missing source is a reason to refuse, never a
// reason to render a zero.

/** Default retry window. ⚠️ A stated tunable — see `retryWindowMinutes`. */
export const DEFAULT_RETRY_WINDOW_MINUTES = 120

/** `faction_settings` key holding `{ retry_window_minutes }`. */
export const WRAP_UP_SETTING = 'war_wrap_up'

/**
 * How long to keep retrying before failing loudly.
 *
 * ⚠️ MonChoon's figure: *"a couple hours is more than plenty."* `wars-sync`
 * runs every three hours, so contributions can legitimately lag a war's end —
 * but the wrap-up also DRIVES wars-sync, so the lag is Torn's availability
 * rather than our cadence.
 *
 * ⚠️ Tunable, not hardcoded. A window that turns out to be too short on a slow
 * day should be changeable without a deploy.
 */
export function retryWindowMinutes(setting: unknown): number {
  const raw = (setting as { retry_window_minutes?: unknown })?.retry_window_minutes
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RETRY_WINDOW_MINUTES
  // ⚠️ Floored at one minute and capped at a week. A zero would fail every war
  // instantly; an unbounded value would leave a war `waiting` for ever, which
  // is the silent failure this whole job exists to avoid.
  return Math.max(1, Math.min(Math.round(n), 7 * 24 * 60))
}

export type WrapUpVerdict =
  | { action: 'queue'; reason: string }
  | { action: 'wait'; reason: string }
  | { action: 'fail'; reason: string }

export interface WrapUpFacts {
  /** Torn says the report will NEVER exist. */
  reportUnavailable: boolean
  /** Rows in `war_member_contributions` for this war. */
  contributionRows: number
  /** Attack rows inside the war window. */
  attackRows: number
  /** Did `dibs-summary` produce a state row for this war? */
  dibsSummarised: boolean
  /** Is the `dibs-summary` job enabled on this tenant? */
  dibsEnabled: boolean
  /** Minutes since we first saw this war ended. */
  minutesWaiting: number
  retryWindowMinutes: number
}

/**
 * Whether this war's sources are all in.
 *
 * ⚠️ **`report_unavailable` fails IMMEDIATELY, before the window is consulted.**
 * Torn is saying *never*, not *not yet*, and burning two hours of retries first
 * only delays the message to the human who has to decide what to do. This is the
 * one case where waiting provably cannot help.
 */
export function assessWrapUp(f: WrapUpFacts): WrapUpVerdict {
  if (f.reportUnavailable) {
    return {
      action: 'fail',
      reason: 'Torn reports this war\'s report is permanently unavailable '
            + '(report_unavailable), so contributions will never arrive. '
            + 'Queued nothing.',
    }
  }

  if (f.contributionRows === 0) {
    if (f.minutesWaiting < f.retryWindowMinutes) {
      return {
        action: 'wait',
        reason: `no war_member_contributions yet (${Math.round(f.minutesWaiting)} of `
              + `${f.retryWindowMinutes} min)`,
      }
    }
    return {
      action: 'fail',
      reason: `no war_member_contributions after ${f.retryWindowMinutes} minutes. `
            + 'Queued nothing rather than posting scoreless reports.',
    }
  }

  // ⚠️ Attacks are checked too, and separately. Contributions come from Torn's
  // war report; the scores in a member's thread come from OUR ledger. A war with
  // contributions but no attack rows would render every member's score as
  // absent while the payout sheet showed figures — two sources disagreeing in
  // public, which is the failure `war-member-score-parity` exists to prevent.
  if (f.attackRows === 0) {
    if (f.minutesWaiting < f.retryWindowMinutes) {
      return { action: 'wait', reason: 'no attack rows in the war window yet' }
    }
    return {
      action: 'fail',
      reason: `no attack rows in the war window after ${f.retryWindowMinutes} minutes. `
            + 'Queued nothing.',
    }
  }

  // ⚠️ **Dibs does NOT block when the job is disabled.** MonChoon, 2026-10-11:
  // *"If dibs summary is disabled we can ship the war reports without it rather
  // than wait."* On four of five tenants the job is off, so blocking on it would
  // mean the wrap-up never completes there — and the report endpoint already
  // reports `state: disabled`, which the formatter renders by omitting the line.
  if (f.dibsEnabled && !f.dibsSummarised) {
    if (f.minutesWaiting < f.retryWindowMinutes) {
      return { action: 'wait', reason: 'dibs summary has not run for this war yet' }
    }
    return {
      action: 'fail',
      reason: `dibs-summary is enabled but produced nothing for this war after `
            + `${f.retryWindowMinutes} minutes. Queued nothing.`,
    }
  }

  return {
    action: 'queue',
    reason: f.dibsEnabled
      ? 'contributions, attacks and dibs all present'
      : 'contributions and attacks present; dibs-summary is disabled on this tenant',
  }
}
