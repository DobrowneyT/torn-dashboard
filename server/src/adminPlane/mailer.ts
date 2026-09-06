/**
 * Digest delivery over SMTP (#609 slice 4).
 *
 * ⚠️ **Unconfigured is a supported state, not an error.** The whole alerting
 * path has to work with no mail server at all: the digest is composed either
 * way, served at `/api/admin/digest`, and the urgent channel is a webhook that
 * needs nothing from this file. Mail is an extra delivery route for something
 * that already exists — so a missing `ADMIN_SMTP_URL` logs once and moves on,
 * rather than joining the fail-closed checks in adminMain.ts. Those exist for
 * the auth gate, where "started fine" would mean "started open"; there is no
 * equivalent danger in a digest nobody receives by email.
 *
 * ⚠️ Nodemailer is imported lazily. It is a dependency of the shared `server`
 * workspace, so every tenant image carries it, and none of them should ever
 * load it — a top-level import would put an SMTP client in the request path of
 * five faction APIs to serve one container's daily email.
 */
import type { Digest } from './digest.js'

export interface MailConfig {
  /** e.g. smtps://user:pass@smtp.example.com:465 — one variable, no matrix. */
  url?: string
  from?: string
  /** Comma-separated. */
  to?: string
}

export type MailResult = 'sent' | 'not_configured' | `failed: ${string}`

export function mailConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MailConfig {
  return {
    url: env.ADMIN_SMTP_URL,
    from: env.ADMIN_DIGEST_FROM,
    to: env.ADMIN_DIGEST_TO,
  }
}

export async function sendDigestMail(config: MailConfig, digest: Digest): Promise<MailResult> {
  if (!config.url || !config.to) return 'not_configured'
  try {
    const { createTransport } = await import('nodemailer')
    const transport = createTransport(config.url)
    await transport.sendMail({
      from: config.from ?? 'fleet-monitor@localhost',
      to: config.to,
      subject: digest.subject,
      text: digest.text,
      html: digest.html,
    })
    return 'sent'
  } catch (e) {
    // Same rule as the webhook: a delivery failure must not stop the monitor.
    return `failed: ${e instanceof Error ? e.message : String(e)}`
  }
}
