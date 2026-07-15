import Fastify, { type FastifyInstance } from 'fastify'
import type pg from 'pg'
import {
  factionIdentity,
  loginWithTornKey,
  refreshSession,
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
import { createSecretStore } from './secrets.js'

/** Mutable readiness flags (#76). main.ts flips these true after arming the
 *  background scheduler + war-room ticker; /api/health/ready reports them. */
export interface HealthFlags {
  scheduler: boolean
  ticker: boolean
}

export interface ServerOptions {
  factionSlug: string
  db?: pg.Pool
  tornBaseUrl?: string
  jwtSecret?: string
  /** Readiness flags for /api/health/ready; owned and updated by the caller. */
  health?: HealthFlags
  /** 32-byte hex secret for the key pool — server-side Torn reads and the
   *  on-demand sync triggers claim from it (#98). */
  keyEncryptionKey?: string
  /** Spy-stat providers for the war room (#100); optional. */
  tornStatsApiKey?: string
  bspApiKey?: string
  tornStatsBaseUrl?: string
  bspBaseUrl?: string
}

export async function buildServer(
  opts: ServerOptions
): Promise<FastifyInstance & { warRoomHub?: WarRoomHub }> {
  const app = Fastify({ logger: false }) as FastifyInstance & { warRoomHub?: WarRoomHub }

  // Liveness: the process is up. Cheap, dependency-free — Docker's HEALTHCHECK
  // and the cheap ping hit this. Must stay 200 even when the DB is down or the
  // key-at-rest secret is malformed (see boot-degrade.test.ts).
  app.get('/api/health', async () => ({ status: 'ok', faction: opts.factionSlug }))

  // Readiness: what an uptime monitor and an operator need per faction — live
  // DB connectivity plus whether background work is armed. DB down ⇒ 503.
  const health = opts.health ?? { scheduler: false, ticker: false }
  app.get('/api/health/ready', async (_req, reply) => {
    let db: 'up' | 'down' | 'not_configured' = 'not_configured'
    if (opts.db) {
      try {
        await opts.db.query('SELECT 1')
        db = 'up'
      } catch {
        db = 'down'
      }
    }
    const ok = db !== 'down'
    return reply.status(ok ? 200 : 503).send({
      status: ok ? 'ok' : 'degraded',
      faction: opts.factionSlug,
      db,
      scheduler: health.scheduler ? 'armed' : 'disarmed',
      ticker: health.ticker ? 'armed' : 'disarmed',
    })
  })

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

    // Silent session renewal (#119). Reads the raw header itself: the
    // onRequest hook above deliberately drops STALE tokens (that's the 24h
    // gate), but a stale-yet-unexpired token is exactly what refresh is for.
    app.post('/api/auth/refresh', async (req, reply) => {
      const header = req.headers.authorization
      if (!header?.startsWith('Bearer ')) {
        return reply.status(401).send({ error: 'Session expired — please log in again' })
      }
      const result = await refreshSession(deps, header.slice('Bearer '.length))
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
    registerOcRoutes(app, { db: opts.db, tornBaseUrl: opts.tornBaseUrl, encryptionKey: opts.keyEncryptionKey })
    registerPayoutRoutes(app, opts.db)
    registerWarRoutes(app, opts.db)
    registerLeadershipRoutes(app, { db: opts.db, tornBaseUrl: opts.tornBaseUrl, encryptionKey: opts.keyEncryptionKey })
    registerSyncRoutes(app, { db: opts.db, tornBaseUrl: opts.tornBaseUrl, encryptionKey: opts.keyEncryptionKey })
    app.warRoomHub = await registerWarRoomRoutes(app, { db: opts.db, jwtSecret: opts.jwtSecret })
    registerWarRoomWriteRoutes(app, { db: opts.db, hub: app.warRoomHub })
    registerWarRoomSetupRoutes(app, {
      db: opts.db, hub: app.warRoomHub,
      tornBaseUrl: opts.tornBaseUrl, encryptionKey: opts.keyEncryptionKey,
      tornStatsApiKey: opts.tornStatsApiKey, bspApiKey: opts.bspApiKey,
      tornStatsBaseUrl: opts.tornStatsBaseUrl, bspBaseUrl: opts.bspBaseUrl,
    })
    // Manual triggers run the same job code as the cron scheduler and share
    // its run history; without a (valid) at-rest key there is no pool to
    // claim from, so the trigger surface answers 503. A malformed key must
    // degrade exactly like an absent one — never crash the whole API at boot.
    let scrapers
    let secrets
    if (opts.keyEncryptionKey) {
      try {
        scrapers = createJobRunner({
          db: opts.db, tornBaseUrl: opts.tornBaseUrl, encryptionKey: opts.keyEncryptionKey,
        })
        secrets = createSecretStore({ db: opts.db, encryptionKey: opts.keyEncryptionKey })
      } catch (err) {
        console.error(
          `[${opts.factionSlug}] KEY_ENCRYPTION_KEY is invalid (need 32 bytes of hex) — ` +
          'scraper triggers disabled:', (err as Error).message
        )
      }
    }
    registerAdminRoutes(app, { db: opts.db, scrapers, secrets })
  }

  return app
}
