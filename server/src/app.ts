import Fastify, { type FastifyInstance } from 'fastify'
import type pg from 'pg'
import {
  factionIdentity,
  loginWithTornKey,
  rolesFromClaims,
  verifySessionToken,
  type AuthDeps,
} from './auth.js'
import './authz.js'
import './db.js'
import { registerMemberRoutes } from './members.js'
import { registerOcRoutes } from './oc.js'
import { registerPayoutRoutes } from './payouts.js'
import { registerWarRoutes } from './wars.js'
import { registerLeadershipRoutes } from './leadership.js'
import { registerSyncRoutes } from './sync.js'
import { registerWarRoomRoutes, type WarRoomHub } from './warRoom.js'
import { registerWarRoomWriteRoutes } from './warRoomWrites.js'
import { registerWarRoomSetupRoutes } from './warRoomSetup.js'
import { registerAdminRoutes } from './admin.js'
import { createJobRunner } from './scraper/registerJobs.js'

export interface ServerOptions {
  factionSlug: string
  db?: pg.Pool
  tornBaseUrl?: string
  jwtSecret?: string
  /** Faction-held Torn key for server-side live reads (until slice #67's pool). */
  tornApiKey?: string
  /** 32-byte hex secret for the key pool — enables the on-demand sync triggers. */
  keyEncryptionKey?: string
}

export async function buildServer(
  opts: ServerOptions
): Promise<FastifyInstance & { warRoomHub?: WarRoomHub }> {
  const app = Fastify({ logger: false }) as FastifyInstance & { warRoomHub?: WarRoomHub }

  app.get('/api/health', async () => ({ status: 'ok', faction: opts.factionSlug }))

  app.decorateRequest('session', null)

  if (opts.db && opts.tornBaseUrl && opts.jwtSecret) {
    const deps: AuthDeps = {
      db: opts.db, tornBaseUrl: opts.tornBaseUrl, jwtSecret: opts.jwtSecret,
      keyEncryptionKey: opts.keyEncryptionKey,
    }

    // Attach the verified session (or null) to every request; role guards
    // (src/authz.ts) and handlers read req.session.
    app.addHook('onRequest', async (req) => {
      const header = req.headers.authorization
      if (!header?.startsWith('Bearer ')) return
      req.session = await verifySessionToken(deps.jwtSecret, header.slice('Bearer '.length))
    })

    app.post('/api/auth/login', async (req, reply) => {
      const apiKey = (req.body as { apiKey?: unknown } | null)?.apiKey
      if (typeof apiKey !== 'string' || apiKey.trim() === '') {
        return reply.status(400).send({ error: 'apiKey is required' })
      }
      const result = await loginWithTornKey(deps, apiKey.trim())
      if (!result.ok) return reply.status(result.status).send({ error: result.error })
      return { token: result.token, expires_at: result.expiresAt }
    })

    app.get('/api/bootstrap', async (req) => {
      const config = await factionIdentity(deps.db)
      const publicView = {
        faction: {
          slug: config.slug,
          display_name: config.display_name,
          // The SPA keys us-vs-them logic (war room, payout ordering) off this.
          torn_faction_id: config.torn_faction_id,
          branding: config.branding,
        },
        features: config.features,
      }
      if (!req.session) return publicView
      // The header shows the roster name; visitors and not-yet-synced members
      // simply have none.
      const named = await deps.db.query(
        'SELECT member_name FROM members WHERE member_id = $1',
        [req.session.torn_user_id]
      )
      return {
        ...publicView,
        user: {
          torn_user_id: req.session.torn_user_id,
          roles: rolesFromClaims(req.session),
          member_name: named.rows[0]?.member_name ?? null,
        },
      }
    })

    registerMemberRoutes(app, opts.db)
    registerOcRoutes(app, { db: opts.db, tornBaseUrl: opts.tornBaseUrl, tornApiKey: opts.tornApiKey })
    registerPayoutRoutes(app, opts.db)
    registerWarRoutes(app, opts.db)
    registerLeadershipRoutes(app, { db: opts.db, tornBaseUrl: opts.tornBaseUrl, tornApiKey: opts.tornApiKey })
    registerSyncRoutes(app, { db: opts.db, tornBaseUrl: opts.tornBaseUrl, encryptionKey: opts.keyEncryptionKey })
    app.warRoomHub = await registerWarRoomRoutes(app, { db: opts.db, jwtSecret: opts.jwtSecret })
    registerWarRoomWriteRoutes(app, { db: opts.db, hub: app.warRoomHub })
    registerWarRoomSetupRoutes(app, {
      db: opts.db, hub: app.warRoomHub,
      tornBaseUrl: opts.tornBaseUrl, encryptionKey: opts.keyEncryptionKey,
    })
    // Manual triggers run the same job code as the cron scheduler and share
    // its run history; without a (valid) at-rest key there is no pool to
    // claim from, so the trigger surface answers 503. A malformed key must
    // degrade exactly like an absent one — never crash the whole API at boot.
    let scrapers
    if (opts.keyEncryptionKey) {
      try {
        scrapers = createJobRunner({
          db: opts.db, tornBaseUrl: opts.tornBaseUrl, encryptionKey: opts.keyEncryptionKey,
        })
      } catch (err) {
        console.error(
          `[${opts.factionSlug}] KEY_ENCRYPTION_KEY is invalid (need 32 bytes of hex) — ` +
          'scraper triggers disabled:', (err as Error).message
        )
      }
    }
    registerAdminRoutes(app, { db: opts.db, scrapers })
  }

  return app
}
