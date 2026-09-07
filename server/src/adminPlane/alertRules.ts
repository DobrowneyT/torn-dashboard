/**
 * Turning a fleet status report into alerts (#609 slice 4).
 *
 * ⚠️ **Pure, and deliberately separate from delivery.** Everything here is a
 * function of one `FleetStatus` snapshot: no clock beyond what is passed in, no
 * database, no network. Deciding *what is wrong* and deciding *whom to wake* are
 * different problems, and fusing them is how a monitor ends up untestable —
 * you can only exercise the rules by actually sending a message.
 *
 * ⚠️ **The bar for a rule is "would this have caught something real".** #598 is
 * the cautionary tale this project already lived: surge alerting had to be
 * turned off by default because a termed war pushed to every subscriber on
 * hospital churn, so *"the room cries wolf all week and people mute it, which
 * then costs them the alert in the war where it mattered"*. A fleet monitor
 * with three channels has three times that opportunity. Every rule below maps
 * to something that has gone wrong or would have gone unnoticed.
 */
import type { FleetStatus } from './statusCollector.js'

/**
 * `urgent` interrupts a person (Discord webhook). `notice` waits for the daily
 * digest. The status page shows both, always.
 *
 * ⚠️ The split is by *how fast a human must act*, not by how bad it looks. Disk
 * at 82% is worth knowing and worthless at 3am — nothing you do tonight changes
 * it. Disk at 91% will stop the nightly dumps.
 */
export type Severity = 'urgent' | 'notice'

export interface Alert {
  /**
   * Stable identity across cycles — `type:subject`. This is the whole basis of
   * "one incident, one message": the key is what says *this is the same problem
   * I already told you about*, so it must not embed anything that varies
   * between polls (a latency, a percentage, a timestamp).
   */
  key: string
  severity: Severity
  title: string
  detail: string
}

export interface AlertThresholds {
  /** Claimable keys at or below this is urgent. #123/#124 decayed to ONE key
   *  and nothing announced it for months. */
  keyPoolLow: number
  /** Consecutive failures before a scraper job is called broken rather than
   *  unlucky. */
  scraperFailStreak: number
  /** No dump newer than this is urgent — the "you believe you have a backup" case. */
  backupUrgentHours: number
  /** Past a day's cadence but not yet alarming. */
  backupNoticeHours: number
  diskUrgentPercent: number
  diskNoticePercent: number
  /** Matches ITEMS_STALE_AFTER_MS in globalDb.ts. */
  itemsStaleHours: number
}

export const DEFAULT_THRESHOLDS: AlertThresholds = {
  keyPoolLow: 1,
  scraperFailStreak: 3,
  backupUrgentHours: 48,
  backupNoticeHours: 26,
  diskUrgentPercent: 90,
  diskNoticePercent: 80,
  itemsStaleHours: 6,
}

const hours = (n: number) => `${n.toFixed(0)}h`

export function evaluateAlerts(
  status: FleetStatus,
  thresholds: AlertThresholds = DEFAULT_THRESHOLDS
): Alert[] {
  const alerts: Alert[] = []

  if (status.postgres.state === 'down') {
    alerts.push({
      key: 'postgres-down',
      severity: 'urgent',
      title: 'Postgres is unreachable from the control plane',
      detail: status.postgres.error ?? 'no detail',
    })
  }

  for (const t of status.tenants) {
    if (t.state === 'down') {
      alerts.push({
        key: `tenant-down:${t.slug}`,
        severity: 'urgent',
        title: `${t.slug} is down`,
        detail: t.error ?? 'no response',
      })
    } else if (t.state === 'degraded') {
      // ⚠️ Urgent, not a notice. "Degraded" here means the process answered but
      // its own database did not — the faction's dashboard is up and broken,
      // which is the state most likely to be reported as a mystery bug rather
      // than an outage.
      alerts.push({
        key: `tenant-degraded:${t.slug}`,
        severity: 'urgent',
        title: `${t.slug} is degraded`,
        detail: `db=${t.db ?? 'unknown'} scheduler=${t.scheduler ?? '?'} ticker=${t.ticker ?? '?'}`,
      })
    }
  }

  // ── Key pool and scrapers (#632) ────────────────────────────────────────
  //
  // ⚠️ The two numbers that would have caught #645 on day one instead of day
  // thirteen. capacityx went from 7 usable keys to ZERO in a single run, and
  // members-sync then logged `no pooled key available` 312 times while every
  // health surface reported the tenant fine.
  for (const t of status.tenants) {
    // ⚠️ `metrics === undefined` means NOT MEASURED and must stay silent — no
    // secret configured, or a tenant too old to serve the endpoint. Treating
    // unmeasured as zero would fire on every tenant the moment this shipped,
    // for a fact nobody had established. Same rule as the null items timestamp.
    if (!t.metrics) continue

    const claimable = t.metrics.keys.claimable
    if (claimable === 0 && t.metrics.keys.enrolled > 0) {
      // ⚠️ Distinct from "low": zero claimable keys is self-sustaining, because
      // members-sync is the only job that can refill the pool and it needs a
      // key from the pool it just emptied (#645).
      alerts.push({
        key: `keys-empty:${t.slug}`,
        severity: 'urgent',
        title: `${t.slug} has no usable API key`,
        detail:
          `${t.metrics.keys.enrolled} enrolled, ${t.metrics.keys.disabled} disabled, 0 claimable. ` +
          'Every Torn-backed job will fail until a member logs in.',
      })
    } else if (claimable > 0 && claimable <= thresholds.keyPoolLow) {
      alerts.push({
        key: `keys-low:${t.slug}`,
        severity: 'urgent',
        title: `${t.slug} is down to ${claimable} usable API key`,
        detail: 'One key dying takes the faction offline. This is how #123/#124 started.',
      })
    }

    // ⚠️ Reported per JOB, not as a count. "3 jobs failing" is not actionable;
    // "members-sync has failed 12 times, never succeeded" is. Job names are
    // identical on every tenant and reveal nothing about a faction.
    for (const job of t.metrics.scrapers.failing) {
      if (job.consecutiveFailures < thresholds.scraperFailStreak) continue
      alerts.push({
        key: `scraper-failing:${t.slug}:${job.jobName}`,
        severity: 'urgent',
        title: `${t.slug}: ${job.jobName} has failed ${job.consecutiveFailures} times running`,
        detail:
          (job.lastSuccessAt ? `Last success ${job.lastSuccessAt}. ` : 'It has never succeeded. ') +
          (job.lastError ?? 'no error recorded'),
      })
    }
  }

  const b = status.backups
  if (b.error) {
    alerts.push({
      key: 'backups-unreadable',
      severity: 'urgent',
      title: 'The backup directory cannot be read',
      detail: b.error,
    })
  } else if (b.newestAgeHours === null) {
    // Distinct from "old": nothing has ever run. On a fleet that has been
    // taking nightly dumps for months this can only mean the volume is gone.
    alerts.push({
      key: 'backups-none',
      severity: 'urgent',
      title: 'No database dump exists at all',
      detail: `${b.count} files in the backup directory`,
    })
  } else if (b.newestAgeHours > thresholds.backupUrgentHours) {
    alerts.push({
      key: 'backups-stale',
      severity: 'urgent',
      title: `Newest backup is ${hours(b.newestAgeHours)} old`,
      detail: `Nightly dumps have not run for over ${thresholds.backupUrgentHours}h.`,
    })
  } else if (b.newestAgeHours > thresholds.backupNoticeHours) {
    alerts.push({
      key: 'backups-late',
      severity: 'notice',
      title: `Newest backup is ${hours(b.newestAgeHours)} old`,
      detail: 'One nightly dump appears to have been missed.',
    })
  }

  // ⚠️ A notice rather than urgent, and the reason is a false-alarm the urgent
  // version would generate on purpose: provisioning a faction creates its
  // database immediately and its first dump only at the next nightly run, so
  // every new faction would page someone within minutes of being created. The
  // danger this rule guards against — a faction that is never backed up —
  // takes weeks to matter, so a digest entry is the right speed for it.
  if (b.missing.length > 0) {
    alerts.push({
      key: 'backups-missing',
      severity: 'notice',
      title: `${b.missing.length} faction(s) have no backup on record`,
      detail: b.missing.join(', '),
    })
  }

  const d = status.disk
  if (d) {
    if (d.usedPercent > thresholds.diskUrgentPercent) {
      alerts.push({
        key: 'disk-critical',
        severity: 'urgent',
        title: `Disk ${d.usedPercent.toFixed(0)}% full`,
        detail: `${(d.freeBytes / 1e9).toFixed(1)} GB free on ${d.path}. Nightly dumps will start failing.`,
      })
    } else if (d.usedPercent > thresholds.diskNoticePercent) {
      alerts.push({
        key: 'disk-low',
        severity: 'notice',
        title: `Disk ${d.usedPercent.toFixed(0)}% full`,
        detail: `${(d.freeBytes / 1e9).toFixed(1)} GB free on ${d.path}.`,
      })
    }
  }

  // ⚠️ **NULL is "not in service", never "infinitely stale".** items-sync does
  // not move to the control plane until slice 7, so `itemsSyncedAt` is null on
  // every fleet running this code today. A rule that read null as "stale" would
  // fire on every cycle from the moment this ships, for a feature that does not
  // exist — the fastest possible way to train an operator to ignore the
  // channel. Same bug class as `Number(null) === 0`, which bit `chainedValue`
  // in #585 and which the issue calls out for feature-flag resolution.
  const syncedAt = status.global?.itemsSyncedAt
  if (syncedAt) {
    const ageHours = (Date.parse(status.generatedAt) - Date.parse(syncedAt)) / 3_600_000
    if (Number.isFinite(ageHours) && ageHours > thresholds.itemsStaleHours) {
      alerts.push({
        key: 'items-stale',
        severity: 'urgent',
        title: `Item prices are ${hours(ageHours)} old`,
        detail:
          'Tenants are refusing to value payouts from them and falling back to their own key pools.',
      })
    }
  }

  return alerts
}
