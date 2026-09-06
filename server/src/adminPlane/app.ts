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
 * ⚠️ Nothing here does anything yet beyond authenticating. Health checks are
 * slice 3, alerting slice 4, provisioning slice 6. This slice exists to get the
 * security boundary reviewed on its own rather than buried in a feature PR.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { verifyPassword } from './password.js'
import { verifyTotp } from './totp.js'
import { mintAdminSession, verifyAdminSession, type AdminClaims } from './session.js'
import { LoginLimiter } from './lockout.js'

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
  }

  return app
}
