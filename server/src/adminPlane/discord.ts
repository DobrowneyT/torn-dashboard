/**
 * The urgent channel: a Discord webhook (#609 slice 4).
 *
 * ⚠️ **A webhook, not a bot.** No token, no gateway connection, no permissions,
 * and it cannot READ anything — the worst case for a leaked webhook URL is
 * someone posting in a private channel. `torn-discord-bot` is untouched, which
 * also settles MonChoon's concern about that bot living in the whole TNL
 * server: this posts to an admin-only channel and has no relationship to it.
 *
 * ⚠️ **One HTTP request per cycle, carrying every event as an embed.** The
 * obvious shape — a POST per incident — hits Discord's per-webhook rate limit
 * exactly when it matters, because the cycle that opens six incidents at once
 * is Postgres dying and taking every tenant with it. Batching also makes the
 * "one incident, one message" promise stronger rather than weaker: an incident
 * still appears exactly once, and a storm is one notification instead of six.
 *
 * Urgent only. Notices wait for the daily digest — #598 is the standing lesson
 * here, where a channel that fired on every hospital churn during a termed war
 * got muted, *"which then costs them the alert in the war where it mattered"*.
 */
import type { Incident } from './incidents.js'

/** Discord's own cap. Past this we summarise rather than truncate silently. */
const MAX_EMBEDS = 10
const RED = 0xc0342b
const GREEN = 0x1a7f4b
const TIMEOUT_MS = 5_000

export type NotifyResult = 'sent' | 'nothing_urgent' | 'not_configured' | `failed: ${string}`

export interface UrgentBatch {
  opened: Incident[]
  resolved: Incident[]
}

interface Embed {
  title: string
  description?: string
  color: number
  timestamp?: string
}

/** Exported for tests — the message body is the contract, not the transport. */
export function buildPayload(batch: UrgentBatch, hostLabel?: string) {
  const opened = batch.opened.filter((i) => i.severity === 'urgent')
  const resolved = batch.resolved.filter((i) => i.severity === 'urgent')
  if (opened.length === 0 && resolved.length === 0) return null

  const total = opened.length + resolved.length
  let embeds: Embed[]

  if (total > MAX_EMBEDS) {
    // A storm is one event, not `total` events. The detail is on the status
    // page; what a phone needs at 3am is the count and the shape.
    embeds = [{
      title: `${opened.length} incident(s) opened, ${resolved.length} resolved`,
      description: [
        opened.length ? `**Opened**\n${opened.map((i) => `• ${i.title}`).join('\n')}` : '',
        resolved.length ? `**Resolved**\n${resolved.map((i) => `• ${i.title}`).join('\n')}` : '',
      ].filter(Boolean).join('\n\n').slice(0, 4000),
      color: opened.length ? RED : GREEN,
    }]
  } else {
    embeds = [
      ...opened.map((i) => ({
        title: `🔴 ${i.title}`,
        description: i.detail.slice(0, 2000),
        color: RED,
        timestamp: i.openedAt ?? i.firstSeenAt,
      })),
      ...resolved.map((i) => ({
        // Duration is the part an operator cannot reconstruct later, and it is
        // the difference between "it blipped" and "it was down all night".
        title: `🟢 Resolved: ${i.title}`,
        description: `Open for ${humanDuration(i.openedAt ?? i.firstSeenAt, i.lastSeenAt)}.`,
        color: GREEN,
        timestamp: i.lastSeenAt,
      })),
    ]
  }

  return {
    username: hostLabel ? `Fleet monitor · ${hostLabel}` : 'Fleet monitor',
    embeds,
  }
}

function humanDuration(fromIso: string, toIso: string): string {
  const ms = Math.max(0, Date.parse(toIso) - Date.parse(fromIso))
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return `${mins} min`
  const h = Math.floor(mins / 60)
  return h < 48 ? `${h}h ${mins % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`
}

/**
 * ⚠️ Never throws, and never retries.
 *
 * This runs inside the monitor loop, so an exception here would stop the fleet
 * being polled at all — a notification failure taking down the monitoring is a
 * strictly worse outcome than a missed message. Retrying is skipped for the
 * same reason a re-announcement is: the next cycle is 60 seconds away and the
 * incident is still open, but a retry storm against a rate-limited webhook is
 * how one outage becomes an hour of blocked requests.
 */
export async function notifyDiscord(
  webhookUrl: string | undefined,
  batch: UrgentBatch,
  fetchImpl: typeof fetch = fetch,
  hostLabel?: string
): Promise<NotifyResult> {
  if (!webhookUrl) return 'not_configured'
  const payload = buildPayload(batch, hostLabel)
  if (!payload) return 'nothing_urgent'

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    return res.ok ? 'sent' : `failed: HTTP ${res.status}`
  } catch (e) {
    return `failed: ${e instanceof Error ? e.message : String(e)}`
  } finally {
    clearTimeout(timer)
  }
}
