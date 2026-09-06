/**
 * The monitor loop (#609 slice 4) — the one place the alerting path has a clock.
 *
 * Every cycle: collect the fleet status, evaluate the rules against it,
 * reconcile that against the incidents already on record, persist the result,
 * and notify. Each of those steps lives in its own module and none of them
 * knows about the others; this file is the wiring, and it is deliberately the
 * only part that is hard to unit test — which is why `runCycle` is exported
 * and takes its dependencies rather than reaching for globals.
 *
 * ⚠️ Nothing in here is allowed to throw. A monitor that dies on a transient
 * database error is worse than no monitor, because the status page keeps
 * working and the silence reads as "all clear". Every failure is caught,
 * logged, and retried by the simple expedient of the next cycle.
 */
import { evaluateAlerts, type AlertThresholds } from './alertRules.js'
import { reconcile, openIncidents, type AlertPolicy, type Incident } from './incidents.js'
import { collectFleetStatus, type CollectorDeps, type FleetStatus } from './statusCollector.js'
import { notifyDiscord, type NotifyResult } from './discord.js'
import { composeDigest, type Digest } from './digest.js'
import { sendDigestMail, type MailConfig, type MailResult } from './mailer.js'
import type { IncidentStore } from './incidentStore.js'

/** Key in `control_state`. */
export const DIGEST_STATE_KEY = 'digest.last_sent_at'

export const DEFAULT_INTERVAL_MS = 60_000
/** 08:00 UTC — morning in Torn City time, which is what TCT already means here. */
export const DEFAULT_DIGEST_HOUR_UTC = 8

export interface MonitorDeps {
  collector: CollectorDeps
  store: IncidentStore
  discordWebhookUrl?: string
  mail?: MailConfig
  thresholds?: AlertThresholds
  policy?: AlertPolicy
  digestHourUtc?: number
  /** Linked from the digest, so the mail can stay short. */
  pageUrl?: string
  /** Distinguishes fleets if this is ever run twice (prod vs staging). */
  hostLabel?: string
  fetchImpl?: typeof fetch
  now?: () => number
  log?: (msg: string) => void
}

export interface CycleResult {
  status: FleetStatus
  incidents: Incident[]
  opened: Incident[]
  resolved: Incident[]
  discord: NotifyResult
  digest: MailResult | 'not_due'
}

/**
 * Whether today's digest is still owed.
 *
 * ⚠️ Compared against the scheduled instant, not against "24 hours ago". A
 * naive elapsed-time check drifts: each send happens slightly after the last,
 * so the digest walks later every day and eventually crosses midnight into the
 * wrong date. Anchoring to today's scheduled time keeps it fixed.
 */
export function digestIsDue(nowMs: number, lastSentIso: string | null, hourUtc: number): boolean {
  const now = new Date(nowMs)
  const dueAt = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc)
  if (nowMs < dueAt) return false
  // ⚠️ Null means this control plane has never sent one. It is deliberately NOT
  // treated as "overdue since the beginning of time": a container started at
  // 23:00 would fire a digest covering nothing, seconds after a deploy. The
  // caller seeds the timestamp instead, so the first real digest is tomorrow's.
  if (lastSentIso === null) return false
  return Date.parse(lastSentIso) < dueAt
}

export async function runCycle(deps: MonitorDeps): Promise<CycleResult> {
  const nowMs = deps.now?.() ?? Date.now()
  const nowIso = new Date(nowMs).toISOString()

  const status = await collectFleetStatus({ ...deps.collector, now: () => nowMs })
  const alerts = evaluateAlerts(status, deps.thresholds)

  const stored = await deps.store.load()
  const r = reconcile(stored, alerts, nowIso, deps.policy)
  await deps.store.save(r, nowIso)

  const discord = await notifyDiscord(
    deps.discordWebhookUrl,
    { opened: r.opened, resolved: r.resolved },
    deps.fetchImpl,
    deps.hostLabel
  )

  const digest = await maybeSendDigest(deps, status, r.incidents, nowMs, nowIso)

  return { status, incidents: r.incidents, opened: r.opened, resolved: r.resolved, discord, digest }
}

async function maybeSendDigest(
  deps: MonitorDeps,
  status: FleetStatus,
  incidents: Incident[],
  nowMs: number,
  nowIso: string
): Promise<MailResult | 'not_due'> {
  const hour = deps.digestHourUtc ?? DEFAULT_DIGEST_HOUR_UTC
  const last = await deps.store.getState<string>(DIGEST_STATE_KEY)

  if (last === null) {
    // First run ever: start the clock rather than firing immediately.
    await deps.store.setState(DIGEST_STATE_KEY, nowIso)
    return 'not_due'
  }
  if (!digestIsDue(nowMs, last, hour)) return 'not_due'

  const digest = await buildDigest(deps, status, incidents, last, nowIso)
  const result = await sendDigestMail(deps.mail ?? {}, digest)

  // ⚠️ Recorded even when delivery failed, and even when mail is unconfigured.
  // Retrying a digest on the next 60-second cycle would turn one broken SMTP
  // credential into 1,440 attempts a day — and the content is a daily summary,
  // so a delayed retry would be a duplicate of tomorrow's mail rather than a
  // recovery of today's. The failure is logged; the fix is to fix SMTP.
  await deps.store.setState(DIGEST_STATE_KEY, nowIso)
  return result
}

export async function buildDigest(
  deps: MonitorDeps,
  status: FleetStatus,
  incidents: Incident[],
  sinceIso: string,
  nowIso: string
): Promise<Digest> {
  const events = await deps.store.recentEvents(sinceIso)
  return composeDigest({
    status,
    open: openIncidents(incidents),
    events,
    since: sinceIso,
    now: nowIso,
    pageUrl: deps.pageUrl,
  })
}

export interface MonitorHandle {
  stop(): void
}

/**
 * ⚠️ Re-armed with `setTimeout` after each cycle rather than `setInterval`.
 * A cycle that takes longer than the interval — five tenants each on a 3s
 * timeout, during exactly the outage this exists for — would otherwise stack
 * overlapping runs, and two concurrent reconciliations against one row set is
 * how an incident gets announced twice.
 */
export function startMonitor(deps: MonitorDeps, intervalMs = DEFAULT_INTERVAL_MS): MonitorHandle {
  const log = deps.log ?? ((m: string) => console.log(m))
  let timer: NodeJS.Timeout | null = null
  let stopped = false

  const tick = async () => {
    try {
      const r = await runCycle(deps)
      for (const i of r.opened) log(`[monitor] OPEN  ${i.severity} ${i.key} — ${i.title}`)
      for (const i of r.resolved) log(`[monitor] CLEAR ${i.key}`)
      if (r.discord.startsWith('failed')) log(`[monitor] discord ${r.discord}`)
      if (r.digest !== 'not_due') log(`[monitor] digest ${r.digest}`)
    } catch (e) {
      log(`[monitor] cycle failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      if (!stopped) timer = setTimeout(tick, intervalMs)
    }
  }

  void tick()

  return {
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
}
