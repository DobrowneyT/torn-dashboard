/**
 * Incident state and flap suppression (#609 slice 4).
 *
 * ⚠️ **This module is the acceptance criterion "one incident produces one
 * Discord message, not one per check cycle".** `evaluateAlerts` runs against a
 * snapshot and has no memory: a tenant that is down stays down, so it yields
 * the same alert every 60 seconds forever. Something has to turn a stream of
 * repeated observations into events, and this is it.
 *
 * Three separate mechanisms, because they solve three different failure modes
 * and a single "cooldown" solves none of them properly:
 *
 * 1. **Confirm before announcing** (`confirmCycles`). A container restarting
 *    during a deploy is unreachable for a few seconds. Announcing on the first
 *    miss means every routine `update.sh` run pages the operator.
 * 2. **Sticky clear** (`clearCycles`). A container in a restart loop answers
 *    every other poll. Resolving on the first success would produce an
 *    up/down/up/down stream — the classic flap, and the loudest possible way to
 *    report a single ongoing incident.
 * 3. **No re-announcement while open.** An incident is announced once when it
 *    opens and once when it clears, full stop. An outage that lasts a week is
 *    still one Discord message; the daily digest carries what is *still* open,
 *    which is the right cadence for "this is not fixed yet".
 *
 * ⚠️ Pure, and the state is passed in and handed back rather than held in a
 * module variable. That is what lets the caller persist it: the admin container
 * gets redeployed, and an in-memory map would re-announce every open incident
 * on every restart — the exact spam this file exists to prevent, triggered by
 * the most routine operation there is.
 */
import type { Alert, Severity } from './alertRules.js'

export interface Incident {
  key: string
  severity: Severity
  title: string
  detail: string
  firstSeenAt: string
  lastSeenAt: string
  /** Cycles this alert has been observed. Reset only when the incident clears. */
  observations: number
  /** Consecutive cycles it has been absent. Reset to 0 on any observation. */
  misses: number
  /** Set when it was announced. NULL means seen but not yet confirmed. */
  openedAt: string | null
}

export interface AlertPolicy {
  confirmCycles: number
  clearCycles: number
}

/**
 * Two cycles each way.
 *
 * At the default 60s poll that is a ~2 minute delay before an outage is
 * announced, which is the right trade: `update.sh` restarts a tenant and polls
 * `/api/health/ready` up to 20 times over 40 seconds, so one cycle of confirm
 * would still catch an ordinary deploy in the act.
 */
export const DEFAULT_POLICY: AlertPolicy = { confirmCycles: 2, clearCycles: 2 }

export interface Reconciliation {
  /** The complete next state — persist this. */
  incidents: Incident[]
  /** Newly confirmed. Announce these. */
  opened: Incident[]
  /** Gone for `clearCycles`. Announce only those that were ever announced. */
  resolved: Incident[]
}

export function reconcile(
  stored: Incident[],
  alerts: Alert[],
  nowIso: string,
  policy: AlertPolicy = DEFAULT_POLICY
): Reconciliation {
  const byKey = new Map(stored.map((i) => [i.key, i]))
  const seen = new Set(alerts.map((a) => a.key))

  const incidents: Incident[] = []
  const opened: Incident[] = []
  const resolved: Incident[] = []

  for (const alert of alerts) {
    const prior = byKey.get(alert.key)
    const next: Incident = prior
      ? {
          ...prior,
          // Refreshed every cycle: an alert's wording carries live numbers (a
          // disk percentage, a backup age) even though its key does not.
          severity: alert.severity,
          title: alert.title,
          detail: alert.detail,
          lastSeenAt: nowIso,
          observations: prior.observations + 1,
          misses: 0,
        }
      : {
          key: alert.key,
          severity: alert.severity,
          title: alert.title,
          detail: alert.detail,
          firstSeenAt: nowIso,
          lastSeenAt: nowIso,
          observations: 1,
          misses: 0,
          openedAt: null,
        }

    // ⚠️ `observations` is a total, not a consecutive run, and that is
    // deliberate. Something present on two of the last three polls is genuinely
    // broken — a container answering every other request is a real incident,
    // not noise — and requiring an unbroken run would leave it permanently
    // unconfirmed and therefore permanently silent. The sticky clear below is
    // what stops that same flapping producing more than one message.
    if (next.openedAt === null && next.observations >= policy.confirmCycles) {
      next.openedAt = nowIso
      opened.push(next)
    }

    incidents.push(next)
  }

  for (const prior of stored) {
    if (seen.has(prior.key)) continue
    const misses = prior.misses + 1
    if (misses >= policy.clearCycles) {
      // ⚠️ Only announce the clearing of something that was announced. An alert
      // that appeared once and vanished before it was ever confirmed produced
      // no "opened" message, so a "resolved" message would be the first the
      // operator heard of it — a recovery notice for an incident that, as far
      // as anyone was told, never happened.
      if (prior.openedAt !== null) resolved.push({ ...prior, misses })
      continue
    }
    incidents.push({ ...prior, misses })
  }

  return { incidents, opened, resolved }
}

/** Announced and not yet cleared — what the digest and the page call "open". */
export function openIncidents(incidents: Incident[]): Incident[] {
  return incidents.filter((i) => i.openedAt !== null)
}
