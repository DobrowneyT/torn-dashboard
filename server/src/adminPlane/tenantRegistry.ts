/**
 * The fleet's tenant list, for things that are not the status page.
 *
 * ⚠️ **One source of truth, already dynamic.** `discoverTenants` reads
 * `pg_database`, so a faction appears here the moment it is provisioned and
 * disappears when its database goes — there is no list to remember to update.
 * The alternative that this replaces was every consumer keeping its own copy:
 * the Discord bot's `/chain tenant add` required somebody to retype a slug and
 * a URL that the control plane already knew, and the two drifted the first time
 * a tenant was renamed.
 *
 * ⚠️ **The public URL is DERIVED, not stored, and the domain is a stated
 * tunable.** Every tenant vhost is `server_name <slug>.*` — the domain itself
 * appears nowhere in the nginx config, so it cannot be read back from there.
 * `TENANT_BASE_DOMAIN` supplies it. Unset, this reports the slugs with a null
 * `base_url` and says why, rather than guessing a hostname that would send a
 * consumer to a dead name.
 */
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'

import { bearerFrom, deriveTenantToken, tokenMatches } from '../fleetMetricsAuth.js'
import { discoverTenants } from './statusCollector.js'

/**
 * The scopes the Discord bot's own credentials are derived under.
 *
 * ⚠️ These strings must match `db/chainWatchTokenLib.mjs` and
 * `db/warOverviewTokenLib.mjs` byte for byte — they are what each tenant
 * container was issued with. A mismatch is a 401 with no hint as to which side
 * is wrong, which is why the test imports those modules and asserts equality
 * rather than trusting this copy.
 */
export const chainWatchScope = (slug: string) => `chain-watch:${slug}`
export const warOverviewScope = (slug: string) => `war-overview:${slug}`

export interface TenantRecord {
  slug: string
  /** `https://<slug>.<domain>`, or null when no domain is configured. */
  base_url: string | null
  /** Present only when the caller asked for them AND a fleet secret exists. */
  chain_watch_token?: string
  war_overview_token?: string
}

/**
 * ⚠️ Rejects a domain that is empty or carries a scheme/path. A value like
 * `https://monchoon.me/` would compose into `https://forge.https://monchoon.me/`
 * — a URL that is merely wrong rather than obviously broken, which is the kind
 * that gets diagnosed as an auth problem.
 */
export function normaliseDomain(raw: string | undefined): string | null {
  const domain = (raw ?? '').trim().replace(/^\.+|\.+$/g, '')
  if (!domain) return null
  if (!/^[a-z0-9.-]+$/i.test(domain) || !domain.includes('.')) return null
  return domain.toLowerCase()
}

/**
 * ⚠️ **The bot's credentials are DERIVED here, not stored anywhere.** A tenant's
 * bot token is `HMAC(FLEET_METRICS_SECRET, "<scope>:<slug>")`, so the same
 * computation that issued the tenant its value reproduces it on demand. There
 * is nothing to generate, nothing to keep in step, and nothing to lose.
 *
 * That is the whole point: adding a faction used to mean an SSH session to
 * derive a value and paste it into a file, which is not something anybody can
 * do from a phone — so in practice it did not get done, and the bot reported a
 * faction it could never poll.
 *
 * ⚠️ **Opt-in, so the default answer carries no credentials.** A consumer that
 * only wants to know which factions exist should not be handed the means to
 * read them.
 */
export function buildRegistry(
  slugs: string[], domain: string | null, fleetSecret?: string,
): TenantRecord[] {
  return slugs.map((slug) => {
    const record: TenantRecord = {
      slug,
      base_url: domain ? `https://${slug}.${domain}` : null,
    }
    if (fleetSecret) {
      record.chain_watch_token = deriveTenantToken(fleetSecret, chainWatchScope(slug))
      record.war_overview_token = deriveTenantToken(fleetSecret, warOverviewScope(slug))
    }
    return record
  })
}

/**
 * `GET /api/internal/tenants` — the fleet's factions and where they live.
 *
 * ⚠️ **Token-authed even though it is bound to the local plane.** The local
 * port is kept off the internet by how it is published, which is a deployment
 * property and not a guarantee this code can make. Anything on the box can
 * reach it, and "the bot runs there too" is exactly the reasoning that makes an
 * unauthenticated internal endpoint spread.
 *
 * ⚠️ **Its own scope**, not `FLEET_METRICS_SECRET` itself and not a tenant's
 * metrics token: a consumer that only needs to know which factions exist should
 * not thereby be able to read any faction's metrics.
 */
export const TENANT_REGISTRY_SCOPE = 'fleet-tenants'

export function registerTenantRegistry(
  app: FastifyInstance, db: pg.Pool, expectedToken: string | undefined,
  fleetSecret?: string,
) {
  app.get('/api/internal/tenants', async (req, reply) => {
    if (!expectedToken) {
      // ⚠️ 503, not 401. "Not configured" and "wrong token" are different
      // problems with different fixes, and conflating them sends whoever is
      // debugging to rotate a credential that was never the issue.
      return reply.status(503).send({ error: 'Tenant registry is not configured' })
    }
    const presented = bearerFrom(req.headers.authorization)
    if (presented === null || !tokenMatches(presented, expectedToken)) {
      return reply.status(401).send({ error: 'Authentication required' })
    }
    const domain = normaliseDomain(process.env.TENANT_BASE_DOMAIN)
    // ⚠️ Opt-in. The bot asks for them; anything else that grows a use for this
    // list gets the list alone, and has to say so to get more.
    const wantTokens = (req.query as { tokens?: string })?.tokens === '1'
    const tenants = buildRegistry(
      await discoverTenants(db), domain, wantTokens ? fleetSecret : undefined)
    return {
      tenants,
      // ⚠️ Said out loud so a consumer can report the real cause. A list of
      // tenants with no URLs is otherwise indistinguishable from a fleet that
      // is up but unreachable.
      base_url_available: domain !== null,
      // ⚠️ Likewise: asked for tokens and got none is a configuration fault,
      // and a bot that cannot tell that from "this faction has no token" would
      // send somebody hunting the wrong half.
      tokens_available: wantTokens ? Boolean(fleetSecret) : undefined,
      note: domain ? undefined : 'TENANT_BASE_DOMAIN is not set on the admin container',
    }
  })
}
