// Admin surface (slice #74): leadership self-serve settings (roles, policy
// documents, branding) and the global-admin oversight endpoints (scraper
// runs/jobs, key-pool health). Key material never crosses this boundary —
// the key-pool view is metadata only.
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { ROLES, type Role } from './auth.js'
import { requireRole } from './authz.js'
import { OUTBOX_KINDS, warSubject } from './memberThreads.js'
import { collectMemberWarReport } from './memberWarReport.js'
import type { createJobRunner } from './scraper/registerJobs.js'
import { resolveJobSchedule } from './scraper/scheduleResolution.js'
import type { FlagResolver } from './featureFlags.js'
import { SECRET_NAMES, type SecretName, type createSecretStore } from './secrets.js'
import { PAYOUT_MODES, isPayoutMode } from './payoutModes.js'

export interface AdminDeps {
  db: pg.Pool
  /** Manual-trigger handle; absent when KEY_ENCRYPTION_KEY is not set. */
  scrapers?: ReturnType<typeof createJobRunner>
  /** Per-faction operator secrets (#105); absent without KEY_ENCRYPTION_KEY. */
  secrets?: ReturnType<typeof createSecretStore>
  /** The process-wide flag resolver (#609 slice 5). Shared with the scraper
   *  scheduler, so writes here invalidate the cache the scheduler reads. */
  flags?: FlagResolver
}

// Leadership manage their faction's settings; admin implies leadership here.
const SETTINGS_GUARD = { preHandler: [requireRole('leadership', 'admin')] }
// The global-admin oversight surface — faction leaders don't see it.
const ADMIN_GUARD = { preHandler: [requireRole('admin')] }

// The whole-document policy settings a leader may edit (db/seed/03 shapes
// the first three; war_room_defaults is written by the admin UI only).
// payout_mode is the odd one out — a scalar (the faction's default OC payout
// mode, #136), not a JSON document — so it validates differently below.
// ⚠️ `steadfast_rotation` is per-faction and OFF by default on purpose. The
// rotation encoded in the calendar (STR/SPD on the 1st, DEF/DEX on the 16th)
// is TNL's own policy, and this stack serves several factions — showing them
// all a schedule that is not theirs would be worse than showing none.
const SETTINGS_KEYS = ['tier_requirements', 'cpr_requirements', 'payout_tickets', 'war_room_defaults', 'payout_mode', 'steadfast_rotation']

export function registerAdminRoutes(app: FastifyInstance, deps: AdminDeps) {
  const { db, scrapers, secrets, flags } = deps

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
    // payout_mode is a scalar enum; every other key is a whole JSON document.
    if (key === 'payout_mode') {
      if (!isPayoutMode(value)) {
        return reply.status(400).send({ error: `payout_mode must be one of: ${PAYOUT_MODES.join(', ')}` })
      }
    } else if (value === undefined || value === null || typeof value !== 'object') {
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
      jobs: await Promise.all(scrapers.jobs.map(async ({ job_name, default_schedule }) => {
        const row = byName.get(job_name)
        // ⚠️ Three layers now, and the page shows which one won (#609 slice 5).
        // `cron_schedule` is this faction's own value and may legitimately be
        // NULL, meaning "follow the fleet default" — reporting the effective
        // value without saying where it came from would make a fleet-wide
        // change look like a local one nobody remembers making.
        const resolution = await resolveJobSchedule({
          jobName: job_name,
          codeDefault: default_schedule,
          tenantValue: row?.cron_schedule ?? null,
          flags,
        })
        return {
          job_name,
          cron_schedule: row?.cron_schedule ?? null,
          effective_schedule: resolution.effective,
          schedule_source: resolution.source,
          default_schedule,
          fleet_schedule: resolution.fleetValue ?? null,
          rejected_schedule: resolution.rejected ?? null,
          // Jobs default to disabled everywhere — bring-up is explicit.
          enabled: row?.enabled ?? false,
          updated_at: row?.updated_at ?? null,
        }
      })),
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
    // ⚠️ An explicit `null` means "clear my override and follow the fleet
    // default" (#609 slice 5) — a real instruction, distinct from omitting the
    // field, which means "leave it as it is". Collapsing the two would leave a
    // faction with no way back to the fleet default short of a DB edit.
    const clearSchedule = body.cron_schedule === null
    if (body.cron_schedule !== undefined && !clearSchedule) {
      const cron = await import('node-cron')
      if (typeof body.cron_schedule !== 'string' || !cron.validate(body.cron_schedule)) {
        return reply.status(400).send({ error: 'cron_schedule is not a valid cron expression' })
      }
    }

    await db.query(
      `INSERT INTO scraper_jobs (job_name, cron_schedule, enabled) VALUES ($1, $2, $3)
       ON CONFLICT (job_name) DO UPDATE SET
         enabled = COALESCE($4, scraper_jobs.enabled),
         cron_schedule = CASE WHEN $5 THEN NULL
                              ELSE COALESCE($6, scraper_jobs.cron_schedule) END,
         updated_at = now()`,
      [
        name,
        clearSchedule ? null : ((body.cron_schedule as string | undefined) ?? null),
        (body.enabled as boolean | undefined) ?? false,
        body.enabled ?? null,
        clearSchedule,
        clearSchedule ? null : (body.cron_schedule ?? null),
      ]
    )
    return { ok: true }
  })

  // ── Feature flags (#609 slice 5) ─────────────────────────────────────────
  //
  // ⚠️ The tenant's side of "fleet default, local override wins". Writes here
  // are per-faction and cannot affect anyone else — the fleet defaults live in
  // the admin container and are written only from its tunnel-only surface.
  //
  // ⚠️ Unsetting is a DELETE, never a write of null. The row's EXISTENCE is
  // the signal, so that a faction that deliberately set a cadence to 0 keeps
  // it rather than silently inheriting the fleet's "on". See featureFlags.ts.
  const FLAG_KEY = /^[a-z][a-z0-9_.-]{0,80}$/

  app.get('/api/admin/flags', ADMIN_GUARD, async (_req, reply) => {
    if (!flags) return reply.status(503).send({ error: 'Feature flags not configured' })
    return { flags: await flags.all() }
  })

  app.put('/api/admin/flags/:key', ADMIN_GUARD, async (req, reply) => {
    if (!flags) return reply.status(503).send({ error: 'Feature flags not configured' })
    const { key } = req.params as { key: string }
    if (!FLAG_KEY.test(key)) return reply.status(400).send({ error: 'Invalid flag key' })

    const body = (req.body ?? {}) as { value?: unknown }
    // ⚠️ `null` is refused rather than stored. Writing it would produce a row
    // that exists (so it wins over the fleet) but holds nothing — a state with
    // no meaning that the database CHECK also rejects. Clearing is DELETE.
    if (!('value' in body) || body.value === null || body.value === undefined) {
      return reply.status(400).send({
        error: 'value is required and may not be null — DELETE the flag to unset it',
      })
    }

    await db.query(
      `INSERT INTO feature_flags (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(body.value)]
    )
    flags.invalidate()
    return { ok: true, flag: await flags.get(key) }
  })

  app.delete('/api/admin/flags/:key', ADMIN_GUARD, async (req, reply) => {
    if (!flags) return reply.status(503).send({ error: 'Feature flags not configured' })
    const { key } = req.params as { key: string }
    if (!FLAG_KEY.test(key)) return reply.status(400).send({ error: 'Invalid flag key' })
    await db.query('DELETE FROM feature_flags WHERE key = $1', [key])
    flags.invalidate()
    return { ok: true, flag: await flags.get(key) }
  })

  app.post('/api/admin/scraper/jobs/:name/run', ADMIN_GUARD, async (req, reply) => {
    if (!scrapers) return reply.status(503).send({ error: 'Scrapers not configured (KEY_ENCRYPTION_KEY)' })
    const { name } = req.params as { name: string }
    const run = await scrapers.runNow(name)
    if (run === null) return reply.status(404).send({ error: `Unknown scraper job: ${name}` })
    // A failed job is a successful trigger: the failure lives on the run row.
    return { run }
  })

  /**
   * Queue one member's war report (#943).
   *
   * ⚠️ **One member, deliberately.** The roster-wide run belongs to the war
   * wrap-up job (#945), which can only queue once every source has actually
   * landed. This endpoint is how the path gets proven — and how a single
   * report is re-posted after a correction — without a fan-out that would put
   * ~94 embeds in flight.
   *
   * ⚠️ **Idempotent via the unique index on (member_id, kind, subject).** The
   * subject is the WAR, so queueing the same pair twice does not produce two
   * posts: it is the same mailbox entry, and the bot edits the message it
   * already recorded. MonChoon: *"on a re-run for the same war I would edit the
   * post. on a new war I would append."*
   *
   * ⚠️ **Admin-guarded, not leadership.** What this queues is a permanent,
   * named performance record in a channel the faction's leadership reads.
   */
  app.post('/api/admin/member-threads/war-report', ADMIN_GUARD, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>
    const warId = Number(b.war_id)
    const memberId = b.member_id == null ? '' : String(b.member_id)
    if (!Number.isFinite(warId) || warId <= 0 || !memberId) {
      return reply.status(400).send({ error: 'war_id and member_id are required' })
    }

    // ⚠️ Refuse here rather than letting the bot discover it at post time. The
    // report endpoint already refuses a live or unknown war; queueing one would
    // leave a mailbox entry that can never be drained, and a stuck queue is the
    // failure nobody notices.
    const report = await collectMemberWarReport(db, warId, memberId)
    if ('error' in report) return reply.status(400).send(report)

    // ⚠️ **A re-queue RE-OPENS the existing entry rather than doing nothing.**
    // `message_id` is deliberately kept, which is what makes the bot EDIT the
    // post it already made instead of adding a second embed to the thread.
    // MonChoon: *"on a re-run for the same war I would edit the post. on a new
    // war I would append."* `DO NOTHING` here would mean a correction could
    // never be issued at all — the entry is already posted, so nothing would
    // ever pick it up again.
    const res = await db.query(
      `INSERT INTO member_thread_outbox (member_id, kind, subject, payload)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (member_id, kind, subject) DO UPDATE
          SET posted_at = NULL,
              claimed_at = NULL,
              attempts = 0,
              last_error = NULL,
              payload = EXCLUDED.payload,
              queued_at = now()
       RETURNING id, message_id`,
      [memberId, OUTBOX_KINDS.war_report, warSubject(warId),
       { war_id: warId, member_name: report.member.name }],
    )
    const row = res.rows[0]
    return {
      ok: true,
      id: row?.id ?? null,
      // ⚠️ Stated so the caller knows which it got. "Queued" creates a post;
      // "re-queued" edits one, and an operator issuing a correction wants to
      // see that it is going to land on the existing message.
      requeued: row?.message_id != null,
      editing_message_id: row?.message_id ?? null,
    }
  })

  /**
   * Wrap up ONE named war, now (#945).
   *
   * ⚠️ **This is the only way to wrap up a war that ended before the job was
   * enabled.** Auto-discovery is watermarked so switching the job on never
   * retro-posts: on forge that would have been ~282 permanent messages across
   * three old wars. An explicit request is how you say "yes, that one".
   *
   * ⚠️ **It queues the WHOLE roster** — ~94 reports for forge, each a permanent
   * message in a thread with somebody's name on it. The war has to be named by
   * id; there is no "latest" shorthand on purpose.
   *
   * The mechanism is deliberately the same one a retry uses: put the war's
   * state row into `waiting`, which `warsNeedingWrapUp` admits regardless of
   * the watermark, then run the job. No second code path to keep in step.
   */
  app.post('/api/admin/war-wrap-up', ADMIN_GUARD, async (req, reply) => {
    if (!scrapers) return reply.status(503).send({ error: 'Scrapers not configured (KEY_ENCRYPTION_KEY)' })
    const warId = Number((req.body as { war_id?: unknown } | null)?.war_id)
    if (!Number.isFinite(warId) || warId <= 0) {
      return reply.status(400).send({ error: 'war_id is required' })
    }

    const war = await db.query(
      'SELECT id, opponent_name, end_at FROM ranked_wars WHERE id = $1', [warId],
    )
    if (war.rowCount === 0) return reply.status(404).send({ error: `No such war: ${warId}` })
    // ⚠️ Refused here as well as in the job. A live war has no final scores,
    // and the operator asking for one should be told now rather than finding a
    // `failed` row later.
    if (!war.rows[0].end_at) {
      return reply.status(400).send({ error: `War ${warId} has not ended` })
    }

    // ⚠️ `first_seen_at` is reset, which restarts the retry window. Without it
    // a war whose row is hours old fails instantly on the first pass, and the
    // operator sees "failed" having had no retry at all.
    await db.query(
      `INSERT INTO war_wrap_up_state (war_id, state, first_seen_at, attempts, last_error)
       VALUES ($1, 'waiting', now(), 0, NULL)
       ON CONFLICT (war_id) DO UPDATE
          SET state = 'waiting', first_seen_at = now(), attempts = 0, last_error = NULL`,
      [warId],
    )

    const run = await scrapers.runNow('war-wrap-up')
    return {
      ok: true,
      war: { id: warId, opponent_name: war.rows[0].opponent_name ?? null },
      run,
    }
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
    // Every enrolled key, PLUS a synthetic row for each CURRENT member without a
    // key (missing=true) so leadership can see who still needs to enrol. Missing
    // rows carry no key metadata — the UI shows them with a red "Missing" status.
    const res = await db.query(
      `SELECT s.member_id, m.member_name, s.key_level, s.has_faction_access,
              s.consent_at, s.consent_version, s.disabled, s.last_error,
              s.last_claimed_at, s.updated_at, false AS missing
       FROM member_secrets s
       LEFT JOIN members m ON m.member_id = s.member_id
       UNION ALL
       SELECT m.member_id, m.member_name, NULL, NULL, NULL, NULL, false, NULL,
              NULL, NULL, true AS missing
       FROM members m
       WHERE m.is_current = true AND m.is_fallen = false
         AND NOT EXISTS (SELECT 1 FROM member_secrets s WHERE s.member_id = m.member_id)
       ORDER BY member_id`
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
