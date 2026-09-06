/**
 * The admin control plane's HTTP surface (#609 slice 2).
 *
 * ⚠️ **Two listeners, and the split is structural rather than conditional.**
 * This factory builds ONE surface at a time. The public listener
 * (`admin.monchoon.me`) registers read and provisioning routes; the local
 * listener (`127.0.0.1`, reached over an SSH tunnel) registers those plus the
 * destructive ones.
 *
 * A destructive route is unreachable from the internet because it **was never
 * registered there** — not because a guard said no. A misconfigured
 * `preHandler` is a plausible mistake and reviews miss them; a route that does
 * not exist cannot be called by any request, header or bug. On the one box
 * whose compromise is fleet-wide, that difference is worth the small extra
 * plumbing.
 *
 * ⚠️ Every route on this file is a READ, with one exception noted at the point
 * it is registered. Provisioning (slice 6) is the first write, and it lands on
 * the public surface deliberately and with its own reasoning; until then the
 * only thing this listener can change is whether you are logged in.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { verifyPassword } from './password.js'
import { verifyTotp } from './totp.js'
import { mintAdminSession, verifyAdminSession, type AdminClaims } from './session.js'
import { LoginLimiter } from './lockout.js'
import { collectFleetStatus, type CollectorDeps } from './statusCollector.js'
import { statusPageHtml } from './statusPage.js'
import { openIncidents } from './incidents.js'
import { buildDigest, type MonitorDeps } from './monitor.js'
import { sendDigestMail } from './mailer.js'

export type Surface = 'public' | 'local'

export interface AdminOptions {
  surface: Surface
  /** Operator username. */
  username: string
  /** scrypt hash from db/admin-password.mjs — never a plaintext password. */
  passwordHash: string
  /** Base32 TOTP secret. */
  totpSecret: string
  /** ⚠️ MUST NOT be the tenant JWT_SECRET — see session.ts. */
  sessionSecret: string
  /** Shared for tests so lockout can be exercised without waiting. */
  limiter?: LoginLimiter
  version?: string
  /** Fleet status collection (#609 slice 3). Omitted in tests that only
   *  exercise auth, and then the status routes are simply not registered. */
  collector?: CollectorDeps
  /**
   * Alerting (#609 slice 4). Supplies the incident store and the digest
   * configuration so the console can show what the monitor has decided.
   *
   * ⚠️ These routes only ever READ the monitor's state — the loop that opens
   * and closes incidents runs in adminMain.ts, not in a request handler. A
   * page refresh must never be able to advance the incident state machine, or
   * two operators looking at the console at once would race the reconciliation
   * that the whole "one incident, one message" guarantee rests on.
   */
  alerts?: MonitorDeps
}

declare module 'fastify' {
  interface FastifyRequest {
    adminClaims?: AdminClaims | null
  }
}

/**
 * Uniform failure for every rejected login.
 *
 * ⚠️ One message and one status for a wrong username, a wrong password, a wrong
 * TOTP code and an unknown account. Distinguishing them tells an attacker which
 * half they have already solved, which is exactly the information that turns
 * two unknowns into two separate one-unknown problems.
 */
const LOGIN_FAILED = { error: 'Invalid credentials' }

export async function buildAdminApp(opts: AdminOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  const limiter = opts.limiter ?? new LoginLimiter()

  // ⚠️ Its own bucket, not the general one. Sharing a budget with ordinary
  // reads would mean a burst of status polling locks the operator out of
  // logging in — the same reasoning as the tenant auth routes.
  await app.register(rateLimit, { global: false })
  const loginRateLimit = {
    rateLimit: { max: 10, timeWindow: 60_000 },
  }

  app.get('/api/admin/health', async () => ({
    status: 'ok',
    surface: opts.surface,
    version: opts.version ?? 'dev',
  }))

  app.post('/api/admin/login', { config: loginRateLimit }, async (req, reply) => {
    const body = (req.body ?? {}) as { username?: unknown; password?: unknown; code?: unknown }
    const username = typeof body.username === 'string' ? body.username : ''
    const password = typeof body.password === 'string' ? body.password : ''
    const code = typeof body.code === 'string' ? body.code : ''

    const lockedFor = limiter.lockedFor(username || '(blank)')
    if (lockedFor > 0) {
      return reply.status(429).send({
        error: 'Too many failed attempts. Try again later.',
        retry_after_seconds: Math.ceil(lockedFor / 1000),
      })
    }

    // ⚠️ Every factor is checked before any decision is returned, rather than
    // short-circuiting on the first failure. Returning early on a bad username
    // would answer measurably faster than a bad password and turn the uniform
    // message above into a lie the clock tells.
    const userOk = username === opts.username
    const passOk = await verifyPassword(password, opts.passwordHash)
    const totpOk = verifyTotp(opts.totpSecret, code)

    if (!userOk || !passOk || !totpOk) {
      limiter.fail(username || '(blank)')
      return reply.status(401).send(LOGIN_FAILED)
    }

    limiter.succeed(username)
    const token = await mintAdminSession(opts.sessionSecret, username, opts.surface)
    return { token, surface: opts.surface, expires_in: 8 * 60 * 60 }
  })

  const requireAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    const claims = token ? await verifyAdminSession(opts.sessionSecret, token) : null
    if (!claims) return reply.status(401).send({ error: 'Authentication required' })

    // ⚠️ A token minted on the local (tunnel-only) listener must not be
    // replayable against the public one. They are different trust levels and
    // the claim records which was used.
    if (claims.surface !== opts.surface) {
      return reply.status(401).send({ error: 'Authentication required' })
    }
    req.adminClaims = claims
  }

  app.get('/api/admin/me', { preHandler: requireAdmin }, async (req) => ({
    username: req.adminClaims?.sub,
    surface: opts.surface,
  }))

  if (opts.collector) {
    const collector = opts.collector
    app.get('/api/admin/status', { preHandler: requireAdmin }, async () =>
      collectFleetStatus(collector)
    )
  }

  if (opts.alerts) {
    const alerts = opts.alerts

    // What the monitor currently believes, for the console's alerts card.
    // `openIncidents` filters to those that were actually announced: an alert
    // seen once and not yet confirmed is not something anyone was told about,
    // and showing it here would contradict the Discord channel.
    app.get('/api/admin/alerts', { preHandler: requireAdmin }, async () => {
      const since = new Date(Date.now() - 24 * 3_600_000).toISOString()
      const [incidents, events] = await Promise.all([
        alerts.store.load(),
        alerts.store.recentEvents(since),
      ])
      return { open: openIncidents(incidents), events, since }
    })

    // ⚠️ A preview, with no side effect and no mail sent. The digest is the
    // one output of this system that would otherwise be unverifiable without
    // waiting until tomorrow morning — and an operator who cannot see what an
    // alert channel says has no way to tell a working channel from a silent
    // one until the day it matters.
    app.get('/api/admin/digest', { preHandler: requireAdmin }, async () => {
      const now = new Date()
      const since = new Date(now.getTime() - 24 * 3_600_000).toISOString()
      const status = await collectFleetStatus(alerts.collector)
      const incidents = await alerts.store.load()
      const digest = await buildDigest(alerts, status, incidents, since, now.toISOString())
      return digest
    })
  }

  // The page itself. Unauthenticated because it contains no data — it is a
  // login form plus the JavaScript that calls /api/admin/status once a session
  // exists. Everything worth protecting is behind that call.
  if (opts.surface === 'public') {
    app.get('/', async (_req, reply) => {
      reply.type('text/html; charset=utf-8')
      return statusPageHtml(opts.version ?? 'dev')
    })
  }

  // ── Local-only routes ───────────────────────────────────────────────────
  //
  // ⚠️ Registered ONLY when building the local surface. On the public listener
  // these paths 404 because they do not exist, which is the whole point: a
  // request cannot reach a route that was never added to the router.
  //
  // Destructive operations live here per the #608 audit: provisioning is
  // additive and recoverable (a wrongly-created faction can be decommissioned),
  // while dropping a database is not. Slice 6 adds provisioning to the PUBLIC
  // surface; decommissioning stays here permanently.
  if (opts.surface === 'local') {
    app.get('/api/admin/local/ping', { preHandler: requireAdmin }, async () => ({
      ok: true,
      note: 'local control surface — destructive operations land here',
    }))

    // ⚠️ Sending a real email is on the LOCAL surface even though it destroys
    // nothing, because it is the one route here that makes the container reach
    // outward on demand. A POST that causes traffic to leave the box is an
    // amplifier — an attacker who got past the login could use it to mail an
    // arbitrary address on a schedule they control. Behind the tunnel it is
    // exactly what it should be: the way an operator proves SMTP works without
    // waiting until 08:00 UTC.
    if (opts.alerts) {
      const alerts = opts.alerts
      app.post('/api/admin/local/digest/send', { preHandler: requireAdmin }, async () => {
        const now = new Date()
        const since = new Date(now.getTime() - 24 * 3_600_000).toISOString()
        const status = await collectFleetStatus(alerts.collector)
        const incidents = await alerts.store.load()
        const digest = await buildDigest(alerts, status, incidents, since, now.toISOString())
        const result = await sendDigestMail(alerts.mail ?? {}, digest)
        return { result, subject: digest.subject }
      })
    }
  }

  return app
}
