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
    const deps: AuthDeps = { db: opts.db, tornBaseUrl: opts.tornBaseUrl, jwtSecret: opts.jwtSecret }

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
          branding: config.branding,
        },
        features: config.features,
      }
      if (!req.session) return publicView
      return {
        ...publicView,
        user: { torn_user_id: req.session.torn_user_id, roles: rolesFromClaims(req.session) },
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
  }

  return app
}
