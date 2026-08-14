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
import { registerBrandingRoutes } from './branding.js'
import { registerManifestRoute } from './manifest.js'
import { registerCompetitionRoutes, resolveCompetition } from './competitions.js'
import { registerCalendarRoutes } from './calendar.js'
import { createCompetitionTimers, type CompetitionTimers } from './competitions/competitionTimers.js'
import { createKeyPool } from './scraper/keyPool.js'
import { createTornClient } from './scraper/tornClient.js'
import { registerMemberNotesRoutes } from './memberNotes.js'
import { registerFeedbackRoutes, feedbackConfigured } from './feedback.js'
import { registerPushRoutes, type PushService, type VapidConfig } from './push.js'
import { createJobRunner } from './scraper/registerJobs.js'
import { createSecretStore } from './secrets.js'
import { APP_VERSION } from './version.js'

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
  /** VAPID keypair for Web Push (#207); optional — push is off when unset. */
  vapid?: VapidConfig | null
  /** Feedback → GitHub issue integration (#253); disabled when the token is unset. */
  feedbackGithubToken?: string
  /** Target repo "owner/name" for feedback issues. */
  feedbackGithubRepo?: string
  /** GitHub API base URL (test override; defaults to the public API). */
  feedbackGithubBaseUrl?: string
  /** Triage label applied to feedback issues (default needs-triage). */
  feedbackLabel?: string
  /** Public origin for embeddable feedback attachment URLs (#254). */
  publicBaseUrl?: string
}

export async function buildServer(
  opts: ServerOptions
): Promise<FastifyInstance & { warRoomHub?: WarRoomHub; pushService?: PushService; competitionTimers?: CompetitionTimers }> {
  const app = Fastify({ logger: false }) as FastifyInstance & {
    warRoomHub?: WarRoomHub
    pushService?: PushService
    competitionTimers?: CompetitionTimers
  }

  // Liveness: the process is up. Cheap, dependency-free — Docker's HEALTHCHECK
  // and the cheap ping hit this. Must stay 200 even when the DB is down or the
  // key-at-rest secret is malformed (see boot-degrade.test.ts).
  app.get('/api/health', async () => ({ status: 'ok', faction: opts.factionSlug, version: APP_VERSION }))

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

    const feedbackOn = feedbackConfigured({
      githubToken: opts.feedbackGithubToken,
      githubRepo: opts.feedbackGithubRepo,
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
        // The SPA hides the "Send feedback" nav entry when this is false (#253).
        feedback_enabled: feedbackOn,
      }
      if (!req.session) return publicView
      // The header shows the roster name; visitors and not-yet-synced members
      // simply have none. The api_key_hint (#264) is the caller's OWN key's last
      // 4 chars — scoped to req.session, never anyone else's; null when no key.
      const [named, secret] = await Promise.all([
        deps.db.query('SELECT member_name FROM members WHERE member_id = $1', [req.session.torn_user_id]),
        deps.db.query('SELECT key_hint FROM member_secrets WHERE member_id = $1', [req.session.torn_user_id]),
      ])
      return {
        ...publicView,
        user: {
          torn_user_id: req.session.torn_user_id,
          roles: rolesFromClaims(req.session),
          member_name: named.rows[0]?.member_name ?? null,
          api_key_hint: secret.rows[0]?.key_hint ?? null,
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
    registerBrandingRoutes(app, { db: opts.db })
    // Per-tenant PWA manifest (follow-up to #206) — each faction's installed app
    // shows its own name/icon instead of the shared "TNL Forge" default.
    registerManifestRoute(app, opts.db)
    // Precise competition boundary timers (#230): capture a baseline at start and
    // a final sample + auto-freeze at end. Needs a key pool → only when a valid
    // at-rest key is configured; otherwise competitions still resolve live/on the
    // backstop tick without exact-instant captures.
    if (opts.keyEncryptionKey) {
      try {
        const capDeps = {
          db: opts.db,
          pool: createKeyPool({ db: opts.db, encryptionKey: opts.keyEncryptionKey }),
          client: createTornClient({ baseUrl: opts.tornBaseUrl, budget: { requests: 60, perMs: 60_000 } }),
        } as Parameters<typeof createCompetitionTimers>[0]['deps']
        app.competitionTimers = createCompetitionTimers({
          db: opts.db,
          deps: capDeps,
          resolve: (comp) => resolveCompetition(opts.db, comp as never, 'scheduler'),
        })
        app.addHook('onClose', async () => { app.competitionTimers?.stopAll() })
      } catch {
        // A malformed key already logged above via the scraper path — timers just
        // stay off.
      }
    }
    registerCompetitionRoutes(app, opts.db, { competitionTimers: app.competitionTimers })
    registerMemberNotesRoutes(app, opts.db)
    registerCalendarRoutes(app, opts.db)
    // In-app feedback → triaged GitHub issue (#253). Disabled (endpoint 501, nav
    // hidden) when no PAT is configured.
    registerFeedbackRoutes(app, {
      db: opts.db,
      githubToken: opts.feedbackGithubToken,
      githubRepo: opts.feedbackGithubRepo,
      githubBaseUrl: opts.feedbackGithubBaseUrl,
      label: opts.feedbackLabel,
      publicBaseUrl: opts.publicBaseUrl,
    })
    // Web Push (#207): subscription storage + VAPID-signed delivery. The service
    // is kept on the app so background senders (#208/#209) can reuse it.
    app.pushService = registerPushRoutes(app, { db: opts.db, vapid: opts.vapid ?? null })
  }

  return app
}
