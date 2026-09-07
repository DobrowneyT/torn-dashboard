/**
 * How the control plane proves itself to a tenant (#632).
 *
 * ⚠️ **Not one shared secret pasted into every tenant.** That is the obvious
 * shape and it has a specific failure: a leak from ANY single tenant's `.env`
 * yields the ability to read EVERY tenant's metrics. The blast radius of one
 * faction's compromise should be one faction.
 *
 * Instead each tenant holds only its own token, derived from a fleet secret:
 *
 *     token(slug) = HMAC-SHA256(FLEET_METRICS_SECRET, slug)
 *
 * The admin container holds the fleet secret and derives whatever it needs; a
 * tenant holds a value that says nothing about any other tenant. Losing the
 * fleet secret still exposes everything — but that secret lives only on the
 * container which is already the fleet-wide credential holder, so it adds no
 * new concentration.
 *
 * ⚠️ The endpoint is genuinely reachable from the internet, which is why this
 * matters: the generated tenant vhost proxies `location /api/` wholesale, so
 * `/api/internal/*` is NOT protected by living on the compose network.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

export function deriveTenantToken(fleetSecret: string, slug: string): string {
  return createHmac('sha256', fleetSecret).update(slug).digest('hex')
}

/**
 * ⚠️ Constant-time, and length-checked first.
 *
 * `timingSafeEqual` throws on a length mismatch rather than returning false, so
 * a short token would 500 instead of 401 — which is itself an oracle, and a
 * noisy one.
 */
export function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** `Authorization: Bearer <token>` → the token, or null. */
export function bearerFrom(header: string | undefined): string | null {
  if (!header || !header.startsWith('Bearer ')) return null
  const token = header.slice(7).trim()
  return token.length > 0 ? token : null
}
