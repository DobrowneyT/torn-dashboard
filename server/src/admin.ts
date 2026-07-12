// Admin surface (slice #74): leadership self-serve settings (roles, policy
// documents, branding) and the global-admin oversight endpoints (scraper
// runs/jobs, key-pool health). Key material never crosses this boundary —
// the key-pool view is metadata only.
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { ROLES, type Role } from './auth.js'
import { requireNotVisitor, requireRole } from './authz.js'
import type { createJobRunner } from './scraper/registerJobs.js'
import { SECRET_NAMES, type SecretName, type createSecretStore } from './secrets.js'

export interface AdminDeps {
  db: pg.Pool
  /** Manual-trigger handle; absent when KEY_ENCRYPTION_KEY is not set. */
  scrapers?: ReturnType<typeof createJobRunner>
  /** Per-faction operator secrets (#105); absent without KEY_ENCRYPTION_KEY. */
  secrets?: ReturnType<typeof createSecretStore>
}

// Leadership manage their faction's settings; admin implies leadership here.
const SETTINGS_GUARD = { preHandler: [requireNotVisitor(), requireRole('leadership', 'admin')] }
// The global-admin oversight surface — faction leaders don't see it.
const ADMIN_GUARD = { preHandler: [requireNotVisitor(), requireRole('admin')] }

// The whole-document policy settings a leader may edit (db/seed/03 shapes
// the first three; war_room_defaults is written by the admin UI only).
const SETTINGS_KEYS = ['tier_requirements', 'cpr_requirements', 'payout_tickets', 'war_room_defaults']

export function registerAdminRoutes(app: FastifyInstance, deps: AdminDeps) {
  const { db, scrapers, secrets } = deps

  app.get('/api/admin/roles', SETTINGS_GUARD, async () => {
    const res = await db.query(
      `SELECT ra.torn_user_id::text, ra.role, ra.granted_by::text, ra.granted_at,
              m.member_name
       FROM role_assignments ra
       LEFT JOIN members m ON m.member_id = ra.torn_user_id::text
       ORDER BY ra.torn_user_id, ra.role`
    )
    return { roles: res.rows }
  })

  app.post('/api/admin/roles', SETTINGS_GUARD, async (req, reply) => {
    const body = (req.body ?? {}) as { torn_user_id?: unknown; role?: unknown }
    const userId = Number(body.torn_user_id)
    if (!Number.isInteger(userId) || userId <= 0) {
      return reply.status(400).send({ error: 'torn_user_id must be a positive integer' })
    }
    if (typeof body.role !== 'string' || !ROLES.includes(body.role as Role)) {
      return reply.status(400).send({ error: `role must be one of: ${ROLES.join(', ')}` })
    }
    await db.query(
      `INSERT INTO role_assignments (torn_user_id, role, granted_by)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [userId, body.role, req.session!.torn_user_id]
    )
    return { ok: true }
  })

  app.delete('/api/admin/roles/:userId/:role', SETTINGS_GUARD, async (req, reply) => {
    const { userId, role } = req.params as { userId: string; role: string }
    const res = await db.query(
      'DELETE FROM role_assignments WHERE torn_user_id = $1 AND role = $2',
      [userId, role]
    )
    if (res.rowCount === 0) return reply.status(404).send({ error: 'No such role assignment' })
    return { ok: true }
  })

  // The editor's read. Members consume policy through GET /api/oc-config;
  // this one adds updated_at and non-OC documents (war_room_defaults).
  app.get('/api/admin/settings', SETTINGS_GUARD, async () => {
    const res = await db.query('SELECT key, value, updated_at FROM faction_settings ORDER BY key')
    return { settings: res.rows }
  })

  // Identity + branding, reflected by /api/bootstrap on next load. Partial:
  // omitted fields keep their value (branding replaces as one document —
  // it's edited whole in the UI).
  app.put('/api/admin/config', SETTINGS_GUARD, async (req, reply) => {
    const body = (req.body ?? {}) as { display_name?: unknown; branding?: unknown }
    const sets: string[] = []
    const values: unknown[] = []
    if (body.display_name !== undefined) {
      if (typeof body.display_name !== 'string' || body.display_name.trim() === '') {
        return reply.status(400).send({ error: 'display_name must be a non-empty string' })
      }
      values.push(body.display_name.trim())
      sets.push(`display_name = $${values.length}`)
    }
    if (body.branding !== undefined) {
      if (body.branding === null || typeof body.branding !== 'object' || Array.isArray(body.branding)) {
        return reply.status(400).send({ error: 'branding must be a JSON object' })
      }
      values.push(JSON.stringify(body.branding))
      sets.push(`branding = $${values.length}`)
    }
    if (sets.length === 0) {
      return reply.status(400).send({ error: 'Nothing to update: provide display_name and/or branding' })
    }
    await db.query(`UPDATE faction_config SET ${sets.join(', ')}, updated_at = now()`, values)
    return { ok: true }
  })

  app.put('/api/admin/settings/:key', SETTINGS_GUARD, async (req, reply) => {
    const { key } = req.params as { key: string }
    if (!SETTINGS_KEYS.includes(key)) {
      return reply.status(400).send({ error: `Unknown settings key; expected one of: ${SETTINGS_KEYS.join(', ')}` })
    }
    const value = (req.body as { value?: unknown } | null)?.value
    if (value === undefined || value === null || typeof value !== 'object') {
      return reply.status(400).send({ error: 'value must be a JSON document' })
    }
    await db.query(
      `INSERT INTO faction_settings (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)]
    )
    return { ok: true }
  })

  // ── Global-admin oversight: scraper jobs, run history, key-pool health ────

  // Known jobs joined with their DB rows: the scraper_jobs row (created when
  // the cron scheduler first registers, or by the toggle below) owns
  // schedule + enabled; jobs the scheduler hasn't seen yet show their
  // defaults so the surface is complete even on a fresh API.
  app.get('/api/admin/scraper/jobs', ADMIN_GUARD, async (_req, reply) => {
    if (!scrapers) return reply.status(503).send({ error: 'Scrapers not configured (KEY_ENCRYPTION_KEY)' })
    const rows = await db.query('SELECT job_name, cron_schedule, enabled, updated_at FROM scraper_jobs')
    const byName = new Map(rows.rows.map((r) => [r.job_name, r]))
    return {
      jobs: scrapers.jobs.map(({ job_name, default_schedule }) => {
        const row = byName.get(job_name)
        return {
          job_name,
          cron_schedule: row?.cron_schedule ?? default_schedule,
          // Jobs default to disabled everywhere — bring-up is explicit.
          enabled: row?.enabled ?? false,
          updated_at: row?.updated_at ?? null,
        }
      }),
    }
  })

  // enabled flips take effect on the scheduler's next tick; cron_schedule
  // edits arm on the API's next restart (tasks are created from scraper_jobs
  // at scheduler start).
  app.put('/api/admin/scraper/jobs/:name', ADMIN_GUARD, async (req, reply) => {
    if (!scrapers) return reply.status(503).send({ error: 'Scrapers not configured (KEY_ENCRYPTION_KEY)' })
    const { name } = req.params as { name: string }
    const known = scrapers.jobs.find((j) => j.job_name === name)
    if (!known) return reply.status(404).send({ error: `Unknown scraper job: ${name}` })

    const body = (req.body ?? {}) as { enabled?: unknown; cron_schedule?: unknown }
    if (body.enabled === undefined && body.cron_schedule === undefined) {
      return reply.status(400).send({ error: 'Provide enabled and/or cron_schedule' })
    }
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      return reply.status(400).send({ error: 'enabled must be a boolean' })
    }
    if (body.cron_schedule !== undefined) {
      const cron = await import('node-cron')
      if (typeof body.cron_schedule !== 'string' || !cron.validate(body.cron_schedule)) {
        return reply.status(400).send({ error: 'cron_schedule is not a valid cron expression' })
      }
    }

    await db.query(
      `INSERT INTO scraper_jobs (job_name, cron_schedule, enabled) VALUES ($1, $2, $3)
       ON CONFLICT (job_name) DO UPDATE SET
         enabled = COALESCE($4, scraper_jobs.enabled),
         cron_schedule = COALESCE($5, scraper_jobs.cron_schedule),
         updated_at = now()`,
      [
        name,
        (body.cron_schedule as string | undefined) ?? known.default_schedule,
        (body.enabled as boolean | undefined) ?? false,
        body.enabled ?? null,
        body.cron_schedule ?? null,
      ]
    )
    return { ok: true }
  })

  app.post('/api/admin/scraper/jobs/:name/run', ADMIN_GUARD, async (req, reply) => {
    if (!scrapers) return reply.status(503).send({ error: 'Scrapers not configured (KEY_ENCRYPTION_KEY)' })
    const { name } = req.params as { name: string }
    const run = await scrapers.runNow(name)
    if (run === null) return reply.status(404).send({ error: `Unknown scraper job: ${name}` })
    // A failed job is a successful trigger: the failure lives on the run row.
    return { run }
  })

  // Operator secrets (#105): writes accept the plaintext once; reads expose
  // configured-state + a last-4 hint only. No endpoint returns the value.
  app.get('/api/admin/secrets', ADMIN_GUARD, async (_req, reply) => {
    if (!secrets) return reply.status(503).send({ error: 'Secrets not configured (KEY_ENCRYPTION_KEY)' })
    return { secrets: await secrets.list() }
  })

  app.put('/api/admin/secrets/:name', ADMIN_GUARD, async (req, reply) => {
    if (!secrets) return reply.status(503).send({ error: 'Secrets not configured (KEY_ENCRYPTION_KEY)' })
    const { name } = req.params as { name: string }
    if (!SECRET_NAMES.includes(name as SecretName)) {
      return reply.status(400).send({ error: `Unknown secret; expected one of: ${SECRET_NAMES.join(', ')}` })
    }
    const value = (req.body as { value?: unknown } | null)?.value
    if (typeof value !== 'string' || value.trim() === '') {
      return reply.status(400).send({ error: 'value must be a non-empty string' })
    }
    await secrets.set(name as SecretName, value.trim())
    return { ok: true }
  })

  // Pool health is metadata only — the encrypted blob (cpr_api_key) must
  // never cross this boundary, and there is no endpoint that returns it.
  app.get('/api/admin/key-pool', ADMIN_GUARD, async () => {
    const res = await db.query(
      `SELECT s.member_id, m.member_name, s.key_level, s.has_faction_access,
              s.consent_at, s.consent_version, s.disabled, s.last_error,
              s.last_claimed_at, s.updated_at
       FROM member_secrets s
       LEFT JOIN members m ON m.member_id = s.member_id
       ORDER BY s.member_id`
    )
    return { keys: res.rows }
  })

  app.get('/api/admin/scraper/runs', ADMIN_GUARD, async (req) => {
    const limit = Math.min(Number((req.query as { limit?: string }).limit ?? 50) || 50, 200)
    const res = await db.query(
      'SELECT * FROM scraper_runs ORDER BY started_at DESC, id DESC LIMIT $1',
      [limit]
    )
    return { runs: res.rows }
  })
}
