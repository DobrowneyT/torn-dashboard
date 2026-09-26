/**
 * Did the watcher actually watch? (#774.)
 *
 * ⚠️ **Nothing here decides anything.** A flag is a row put in front of a human,
 * and leadership marks it paid or unpaid (#773). MonChoon, 2026-09-22: flag it,
 * do not let the app choose.
 *
 * ⚠️ **Zero attacks is not a flag, and building it that way would be the whole
 * mistake.** A watcher who made no hits during a healthy chain did the job —
 * others were hitting and nothing needed doing. Flagging on attacks would fire
 * across most of a *successful* event, leadership would face hundreds of amber
 * rows, and after the fortieth they would click through without reading. A flag
 * that fires for everything launders inattention as review. The signal is
 * **activity**, not attacks.
 *
 * ⚠️ And this detects **absence, not attention**. Somebody logged in, doing
 * crimes and ignoring the chain entirely, passes. Say so wherever the flag is
 * explained, because eventually someone asks why it did not fire.
 */

/** Longest gap in a member's own actions that still counts as "around". */
export const ACTIVITY_GAP_MS = 20 * 60_000

/**
 * A chain timer below this had the watcher's attention or wanted it.
 *
 * Torn hands us `timeout` directly — seconds until the chain drops — so "how
 * close did it come" needs no inference at all.
 */
export const AT_RISK_SECONDS = 120

export type WatchFlag = 'absent' | 'absent-at-risk' | 'abroad' | null

export interface HourEvidence {
  /** Epoch ms of the top of the hour the slot covers. */
  hourStart: number
  /** The member's own `last_action` epochs, from samples inside the hour. */
  lastActions: number[]
  /** Samples of `status.state` inside the hour, oldest first. */
  states: string[]
  /** Lowest observed seconds-to-drop inside the hour; null when unsampled. */
  minTimeoutSeconds: number | null
  /** Whether any sample landed inside the hour at all. */
  sampled: boolean
}

const HOUR_MS = 3600_000

/** Was the member doing anything during the hour? */
export function wasActive(ev: HourEvidence): boolean {
  const end = ev.hourStart + HOUR_MS
  return ev.lastActions.some((t) => t >= ev.hourStart - ACTIVITY_GAP_MS && t < end)
}

/** Overseas or in the air for the WHOLE hour we sampled. */
export function wasAway(ev: HourEvidence): boolean {
  if (ev.states.length === 0) return false
  return ev.states.every((s) => s === 'Traveling' || s === 'Abroad')
}

/**
 * The flag for one served slot.
 *
 * ⚠️ Two severities, and they are not netted into one. *Absent* is usually paid
 * without much thought; *absent while the chain was at risk* is the row worth a
 * minute. If both look identical in the table, leadership treats them
 * identically — which is the same failure as having no flag.
 *
 * ⚠️ `abroad` is the one finding that is not a judgment call: a watcher
 * overseas for the hour could not have hit anything, so the slot was not served
 * (MonChoon, 2026-09-22). It is still labelled rather than quietly zeroed, so
 * the member can see why.
 *
 * ⚠️ An hour we did not sample yields **no flag at all**. "We were not looking"
 * must never render as "they were not there" — that is the #330 mistake, where
 * a guard asked "did this change?" while meaning "were we watching?".
 */
export function flagFor(ev: HourEvidence): WatchFlag {
  if (!ev.sampled) return null
  if (wasAway(ev)) return 'abroad'
  if (wasActive(ev)) return null
  return ev.minTimeoutSeconds != null && ev.minTimeoutSeconds <= AT_RISK_SECONDS
    ? 'absent-at-risk'
    : 'absent'
}

/** One line of plain English per flag, for the panel that shows it. */
export const FLAG_REASON: Record<Exclude<WatchFlag, null>, string> = {
  absent: 'No actions recorded during the hour',
  'absent-at-risk': 'No actions while the chain timer was running low',
  abroad: 'Travelling or overseas for the whole slot — not paid',
}
