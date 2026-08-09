// On-demand sync triggers (slice #70) — the Data Management / war-page
// "fetch fresh from Torn" buttons. Leadership-gated; each trigger runs the
// SAME job code the scheduler runs, under the run logger, and returns the
// run record (status/rows/error) for the UI to render. 503 when the key
// pool isn't configured (no KEY_ENCRYPTION_KEY).
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { requireNotVisitor, requireRole } from './authz.js'
import { createKeyPool } from './scraper/keyPool.js'
import { createTornClient } from './scraper/tornClient.js'
import { createRunLogger } from './scraper/runLog.js'
import type { JobDeps } from './scraper/jobs/itemsSync.js'
import { warsSyncJob } from './scraper/jobs/warsSync.js'
import { attacksSyncJob } from './scraper/jobs/attacksSync.js'
import { revivesSyncJob, revivesContinuousJob } from './scraper/jobs/revivesSync.js'
import { crimesSyncJob } from './scraper/jobs/crimesSync.js'
import { membersSyncJob } from './scraper/jobs/membersSync.js'

export interface SyncDeps {
  db: pg.Pool
  tornBaseUrl: string
  encryptionKey?: string
}

const GUARD = { preHandler: [requireNotVisitor(), requireRole('leadership', 'admin')] }

export function registerSyncRoutes(app: FastifyInstance, deps: SyncDeps) {
  function jobDeps(): JobDeps {
    return {
      db: deps.db,
      pool: createKeyPool({ db: deps.db, encryptionKey: deps.encryptionKey! }),
      encryptionKey: deps.encryptionKey,
      // On-demand triggers share Torn's per-key budget headroom.
      client: createTornClient({ baseUrl: deps.tornBaseUrl, budget: { requests: 60, perMs: 60_000 } }),
    }
  }

  function guardConfigured(reply: any): boolean {
    if (!deps.encryptionKey) {
      reply.status(503).send({ error: 'Key pool not configured (KEY_ENCRYPTION_KEY)' })
      return false
    }
    return true
  }

  app.post('/api/sync/wars', GUARD, async (_req, reply) => {
    if (!guardConfigured(reply)) return
    const run = await createRunLogger(deps.db).withRun('wars-sync', () => warsSyncJob(jobDeps()))
    return { run }
  })

  app.post('/api/sync/attacks', GUARD, async (_req, reply) => {
    if (!guardConfigured(reply)) return
    const run = await createRunLogger(deps.db).withRun('attacks-sync', () => attacksSyncJob(jobDeps()))
    return { run }
  })

  app.post('/api/sync/wars/:id/revives', GUARD, async (req, reply) => {
    if (!guardConfigured(reply)) return
    const { id } = req.params as { id: string }
    if (!/^\d+$/.test(id)) return reply.status(404).send({ error: 'War not found' })
    // Logged apart from the standing 'revives-sync' cron (#358): both write
    // faction_revives, but one is a bounded backfill of a finished war and the
    // other is the live feed. Sharing a name would make the run history
    // unreadable — a war backfill's row count means something quite different.
    const run = await createRunLogger(deps.db).withRun('revives-sync-war', () => revivesSyncJob(jobDeps(), Number(id)))
    return { run }
  })

  /**
   * Full revive backfill (#358). Walks forward from `from` (default 0 — the
   * whole history), ignoring what is already stored.
   *
   * Exists so a faction with partial history can complete it WITHOUT anyone
   * truncating faction_revives first. The upsert is idempotent, so re-seen
   * revives are refreshed rather than duplicated, and nothing is ever absent
   * mid-run. Truncating to force a re-pull reaches the same end state while
   * risking everything past Torn's own retention horizon.
   *
   * Long-running on the first call — it pages the entire history.
   */
  app.post('/api/sync/revives/backfill', GUARD, async (req, reply) => {
    if (!guardConfigured(reply)) return
    const raw = (req.query as { from?: string } | null)?.from
    const from = raw == null || raw === '' ? 0 : Number(raw)
    if (!Number.isInteger(from) || from < 0) {
      return reply.status(400).send({ error: 'from must be a non-negative unix timestamp' })
    }
    const run = await createRunLogger(deps.db)
      .withRun('revives-sync-backfill', () => revivesContinuousJob(jobDeps(), { from }))
    return { run }
  })

  app.post('/api/sync/crimes', GUARD, async (_req, reply) => {
    if (!guardConfigured(reply)) return
    const run = await createRunLogger(deps.db).withRun('crimes-sync', () => crimesSyncJob(jobDeps()))
    return { run }
  })

  app.post('/api/sync/members', GUARD, async (_req, reply) => {
    if (!guardConfigured(reply)) return
    const run = await createRunLogger(deps.db).withRun('members-sync', () => membersSyncJob(jobDeps()))
    return { run }
  })
}
