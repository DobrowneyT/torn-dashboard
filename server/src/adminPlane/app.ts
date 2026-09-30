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
import type pg from 'pg'
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
import {
  validateProvisionRequest, findConflicts, createProvisionRequest,
  listProvisionRequests, getProvisionRequest, retryProvisionRequest,
} from './provisioning.js'
import { syncFleetItems, type ItemsSyncDeps } from './itemsSync.js'
import { registerTenantRegistry } from './tenantRegistry.js'

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
  /**
   * Writer pool on `global`, for the fleet feature-flag defaults (#609 slice
   * 5). Reads are registered on both surfaces; WRITES only on the local one.
   */
  fleetDb?: pg.Pool
  /** Fleet item catalogue sync (#609 slice 7). Absent without a Torn key. */
  items?: ItemsSyncDeps
  /**
   * The Discord bot's bearer for `GET /api/internal/tenants`.
   *
   * ⚠️ Derived from the fleet secret under its OWN scope, so a consumer that
   * only needs to know which factions exist cannot thereby read any faction's
   * metrics. Absent leaves the route registered but answering 503 — see the
   * note in tenantRegistry.ts on why that is not a 401.
   */
  tenantRegistryToken?: string
  /**
   * The fleet secret, so the registry can derive the bot's per-tenant tokens
   * on request.
   *
   * ⚠️ The secret itself never leaves this container — only values derived
   * from it under the bot's two scopes. A consumer holding those cannot mint
   * anything else, which is the property that makes this safe to answer at all:
   * losing the registry token costs the bot's own access, not the fleet's.
   */
  fleetMetricsSecret?: string
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

  // ── Fleet feature-flag defaults (#609 slice 5) ───────────────────────────
  //
  // Reading is safe from anywhere; the write is not — see below.
  if (opts.fleetDb) {
    const fleetDb = opts.fleetDb
    app.get('/api/admin/flags', { preHandler: requireAdmin }, async () => {
      const res = await fleetDb.query(
        'SELECT key, value, description, updated_at FROM fleet_flags ORDER BY key'
      )
      return { flags: res.rows }
    })
  }

  // ── Provisioning a faction (#609 slice 6) ────────────────────────────────
  //
  // ⚠️ These are WRITES on the internet-facing surface, and the only ones. The
  // audit's recommendation was to keep provisioning a CLI; MonChoon reversed
  // that deliberately, and it is defensible because provisioning is ADDITIVE
  // AND RECOVERABLE — a wrongly-created faction can be decommissioned, while a
  // wrongly-dropped one cannot be un-dropped. Decommissioning stays off the web
  // permanently, and no route here touches Docker or the deploy directory: they
  // write a request row for the host-side agent to claim.
  if (opts.fleetDb) {
    const fleetDb = opts.fleetDb

    app.post('/api/admin/provision', { preHandler: requireAdmin }, async (req, reply) => {
      const parsed = validateProvisionRequest(req.body)
      if (!parsed.ok) return reply.status(400).send({ error: parsed.error })

      // ⚠️ Checked before insert so a duplicate is a readable message rather
      // than a half-provisioned faction discovered by the agent at step three.
      const conflicts = await findConflicts(fleetDb, parsed.value)
      if (conflicts.length) {
        return reply.status(409).send({ error: conflicts[0].reason, conflicts })
      }

      const row = await createProvisionRequest(fleetDb, parsed.value, req.adminClaims?.sub ?? 'unknown')
      return reply.status(202).send({ request: row })
    })

    app.get('/api/admin/provision', { preHandler: requireAdmin }, async (req) => {
      const { limit } = req.query as { limit?: string }
      return { requests: await listProvisionRequests(fleetDb, Number(limit) || 20) }
    })

    app.get('/api/admin/provision/:id', { preHandler: requireAdmin }, async (req, reply) => {
      const row = await getProvisionRequest(fleetDb, Number((req.params as { id: string }).id))
      if (!row) return reply.status(404).send({ error: 'No such request' })
      return { request: row }
    })

    // Failure has to be re-runnable without hand-repair — new-faction.mjs is
    // idempotent and has an --adopt path, so a retry is a real option rather
    // than a hopeful one.
    app.post('/api/admin/provision/:id/retry', { preHandler: requireAdmin }, async (req, reply) => {
      const id = Number((req.params as { id: string }).id)
      const row = await retryProvisionRequest(fleetDb, id)
      if (!row) {
        const existing = await getProvisionRequest(fleetDb, id)
        return reply.status(existing ? 409 : 404).send({
          error: existing ? `Only a failed request can be retried (this one is ${existing.status}).` : 'No such request',
        })
      }
      return { request: row }
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
    // ⚠️ Local surface only. The registry names every faction in the fleet,
    // which is fleet-shaped information and has no business on a surface the
    // internet can reach — the token is the second lock, not the first.
    if (opts.fleetDb) {
      registerTenantRegistry(
        app, opts.fleetDb, opts.tenantRegistryToken, opts.fleetMetricsSecret)
    }

    app.get('/api/admin/local/ping', { preHandler: requireAdmin }, async () => ({
      ok: true,
      note: 'local control surface — destructive operations land here',
    }))

    // ⚠️ **Writing a fleet flag is a tunnel-only operation**, and this is the
    // one place in slice 5 where that call is worth arguing. Provisioning was
    // allowed onto the public surface because it is additive and recoverable —
    // a wrongly-created faction can be decommissioned. A fleet flag is neither:
    // it takes effect on every tenant within a minute, and the failure that
    // matters is not a malformed value (resolveJobSchedule rejects those and
    // falls back) but a perfectly VALID one. `* * * * * *` on a scraper cadence
    // would have five factions calling Torn every second on their own pooled
    // keys — a rate-limit ban across the fleet, from one typo, with no undo
    // that gives the keys back. Nobody needs to do that from a phone.
    if (opts.fleetDb) {
      const fleetDb = opts.fleetDb
      const FLAG_KEY = /^[a-z][a-z0-9_.-]{0,80}$/

      app.put('/api/admin/local/flags/:key', { preHandler: requireAdmin }, async (req, reply) => {
        const { key } = req.params as { key: string }
        if (!FLAG_KEY.test(key)) return reply.status(400).send({ error: 'Invalid flag key' })
        const body = (req.body ?? {}) as { value?: unknown; description?: unknown }
        // ⚠️ Refused, not stored. A null would produce a row that EXISTS — and
        // therefore counts as "set" — while holding nothing. Unsetting is a
        // DELETE, which is the only thing that means "fall back".
        if (!('value' in body) || body.value === null || body.value === undefined) {
          return reply.status(400).send({
            error: 'value is required and may not be null — DELETE the flag to unset it',
          })
        }
        const res = await fleetDb.query(
          `INSERT INTO fleet_flags (key, value, description) VALUES ($1, $2::jsonb, $3)
           ON CONFLICT (key) DO UPDATE SET
             value = EXCLUDED.value,
             description = COALESCE(EXCLUDED.description, fleet_flags.description),
             updated_at = now()
           RETURNING key, value, description, updated_at`,
          [key, JSON.stringify(body.value), typeof body.description === 'string' ? body.description : null]
        )
        return { ok: true, flag: res.rows[0] }
      })

      app.delete('/api/admin/local/flags/:key', { preHandler: requireAdmin }, async (req, reply) => {
        const { key } = req.params as { key: string }
        if (!FLAG_KEY.test(key)) return reply.status(400).send({ error: 'Invalid flag key' })
        const res = await fleetDb.query('DELETE FROM fleet_flags WHERE key = $1 RETURNING key', [key])
        // ⚠️ Reported rather than 404'd. "It is not set" is the state the
        // caller asked for, and an error here would make a retry after a
        // half-successful run look like a failure.
        return { ok: true, deleted: (res.rowCount ?? 0) > 0 }
      })
    }

    // ⚠️ Same reasoning as the digest below: forcing a catalogue refresh makes
    // this container reach out to Torn on demand, which is an amplifier in
    // anyone else's hands. Behind the tunnel it is how an operator proves the
    // key works without waiting up to two hours for the next scheduled run.
    if (opts.items) {
      const items = opts.items
      app.post('/api/admin/local/items/sync', { preHandler: requireAdmin }, async (_req, reply) => {
        try {
          return await syncFleetItems(items)
        } catch (e) {
          // ⚠️ 502, not 500: the failure is Torn's or the key's, and the
          // previous prices are intact. The message carries the reason so an
          // operator is not left guessing between a bad key and an outage.
          return reply.status(502).send({ error: e instanceof Error ? e.message : String(e) })
        }
      })
    }

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
