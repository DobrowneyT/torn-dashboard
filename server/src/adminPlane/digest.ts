/**
 * The daily digest (#609 slice 4).
 *
 * ⚠️ **It is sent every day, including the days when nothing is wrong, and that
 * is the point.** The tempting design — mail only when there is something to
 * report — makes silence ambiguous: an empty inbox means either "the fleet is
 * healthy" or "the monitor died three weeks ago", and those are the two states
 * you most need to tell apart. This project has already been bitten by exactly
 * that shape: the key pool decayed to a single key in July (#123/#124) and
 * nothing announced it, because nothing was *supposed* to announce anything.
 * A digest that arrives daily is its own heartbeat.
 *
 * ⚠️ Composition is pure and delivery is not, split for the usual reason: this
 * is the piece worth testing, and it should not need an SMTP server to test.
 * The same text is served at `/api/admin/digest`, so the digest is inspectable
 * without waiting for tomorrow morning or configuring mail at all.
 */
import type { FleetStatus } from './statusCollector.js'
import type { Incident } from './incidents.js'
import type { AlertEvent } from './incidentStore.js'

export interface DigestInput {
  status: FleetStatus
  /** Announced and not yet cleared. */
  open: Incident[]
  /** Everything that opened or resolved in the window — including both. */
  events: AlertEvent[]
  since: string
  now: string
  pageUrl?: string
}

export interface Digest {
  subject: string
  text: string
  html: string
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

const gb = (n: number) => `${(n / 1e9).toFixed(1)} GB`

export function composeDigest(input: DigestInput): Digest {
  const { status, open, events } = input
  const up = status.tenants.filter((t) => t.state === 'ok').length
  const urgent = open.filter((i) => i.severity === 'urgent')

  // ⚠️ The subject line has to be readable from a phone's lock screen without
  // opening anything, so it leads with the number that decides whether to open
  // it. A subject like "Fleet digest" is a subject nobody reads twice.
  const headline =
    urgent.length > 0
      ? `${urgent.length} urgent`
      : open.length > 0
        ? `${open.length} open`
        : 'all clear'
  const subject = `[fleet] ${headline} · ${up}/${status.tenants.length} tenants up`

  const lines: string[] = []
  const push = (s = '') => lines.push(s)

  push(`Fleet digest — ${input.since.slice(0, 16).replace('T', ' ')} to ${input.now.slice(0, 16).replace('T', ' ')} UTC`)
  push()

  push(open.length ? `OPEN INCIDENTS (${open.length})` : 'OPEN INCIDENTS — none')
  for (const i of open) {
    push(`  [${i.severity}] ${i.title}`)
    if (i.detail) push(`      ${i.detail}`)
    push(`      open since ${i.openedAt ?? i.firstSeenAt}`)
  }
  push()

  // ⚠️ Incidents that opened AND closed inside the window are the ones this
  // section exists for. Nobody was awake for them, the status page no longer
  // shows them, and a tenant that restarts itself every night at 4am is
  // invisible in every other view in this system.
  push(events.length ? `ACTIVITY (${events.length})` : 'ACTIVITY — nothing opened or resolved')
  for (const e of events) {
    push(`  ${e.at.slice(11, 16)}  ${e.kind === 'opened' ? 'OPEN ' : 'CLEAR'}  ${e.title}`)
  }
  push()

  push('TENANTS')
  for (const t of status.tenants) {
    push(`  ${t.slug.padEnd(14)} ${t.state.padEnd(9)} db=${t.db ?? '?'}${t.error ? `  ${t.error}` : ''}`)
  }
  push()

  push('OPERATIONS')
  push(`  Postgres        ${status.postgres.state}${status.postgres.error ? ` — ${status.postgres.error}` : ''}`)
  const b = status.backups
  push(
    `  Newest backup   ${b.newestAgeHours === null ? 'none on record' : `${b.newestAgeHours.toFixed(0)}h old`} (${b.count} dumps)`
  )
  if (b.missing.length) push(`  No backup for   ${b.missing.join(', ')}`)
  if (status.disk) {
    push(`  Disk            ${status.disk.usedPercent.toFixed(0)}% used, ${gb(status.disk.freeBytes)} free`)
  }
  const g = status.global
  push(`  Global schema   ${g?.schemaVersion ?? 'unavailable'}`)
  push(`  OC model        ${g?.ocModelVersion ?? 'not published'}`)
  push(`  Item prices     ${g?.itemsSyncedAt ?? 'not in service'}`)

  if (input.pageUrl) {
    push()
    push(`Full detail: ${input.pageUrl}`)
  }

  const text = lines.join('\n')

  const html = `<!doctype html><meta charset="utf-8">
<div style="font:14px/1.55 ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#14181f;max-width:720px">
<h2 style="font-size:17px;margin:0 0 4px">Fleet digest</h2>
<p style="color:#63707f;font-size:12px;margin:0 0 18px">${esc(input.since.slice(0, 16).replace('T', ' '))} → ${esc(input.now.slice(0, 16).replace('T', ' '))} UTC</p>
<h3 style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#63707f;margin:0 0 6px">Open incidents</h3>
${open.length
  ? `<ul style="margin:0 0 18px;padding-left:18px">${open
      .map((i) => `<li><strong style="color:${i.severity === 'urgent' ? '#c0342b' : '#a86800'}">${esc(i.title)}</strong>${i.detail ? `<br><span style="color:#63707f">${esc(i.detail)}</span>` : ''}</li>`)
      .join('')}</ul>`
  : '<p style="margin:0 0 18px;color:#1a7f4b">Nothing open.</p>'}
<h3 style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#63707f;margin:0 0 6px">Tenants</h3>
<table style="border-collapse:collapse;width:100%;margin-bottom:18px">
${status.tenants
  .map((t) => `<tr><td style="padding:4px 8px;border-bottom:1px solid #e3e7ec"><strong>${esc(t.slug)}</strong></td><td style="padding:4px 8px;border-bottom:1px solid #e3e7ec;color:${t.state === 'ok' ? '#1a7f4b' : t.state === 'degraded' ? '#a86800' : '#c0342b'}">${esc(t.state)}</td><td style="padding:4px 8px;border-bottom:1px solid #e3e7ec;color:#63707f">${esc(t.error ?? `db=${t.db ?? '?'}`)}</td></tr>`)
  .join('')}
</table>
<pre style="font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:#f6f7f9;border:1px solid #e3e7ec;border-radius:8px;padding:12px;white-space:pre-wrap">${esc(
    lines.slice(lines.indexOf('OPERATIONS')).join('\n')
  )}</pre>
${input.pageUrl ? `<p><a href="${esc(input.pageUrl)}">Full detail</a></p>` : ''}
</div>`

  return { subject, text, html }
}
