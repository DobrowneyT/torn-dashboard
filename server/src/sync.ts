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
import { revivesSyncJob } from './scraper/jobs/revivesSync.js'

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
    const run = await createRunLogger(deps.db).withRun('revives-sync', () => revivesSyncJob(jobDeps(), Number(id)))
    return { run }
  })
}
