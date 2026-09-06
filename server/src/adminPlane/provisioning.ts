/**
 * Provisioning a faction from the admin console (#609 slice 6).
 *
 * ⚠️ **The admin container does not provision anything.** Doing so needs
 * Postgres superuser, write access to the deploy directory, and Docker — on the
 * one container that accepts logins from the internet. So this module validates
 * a request and writes a ROW; `deploy/host-agent.mjs`, running on the host
 * outside every container, claims it and executes one known command with these
 * arguments.
 *
 * A fully compromised admin container can therefore only ask for a faction to
 * be created. It cannot run arbitrary docker or shell. That bound is the whole
 * design, and it disappears the moment the Docker socket is mounted instead.
 *
 * ⚠️ **Validation here is defence in depth, not the only check.** The agent
 * re-validates with the same rules before it runs anything, because "the API
 * validated it" is a sentence that stops being true the day something else
 * writes to that table.
 */
import type pg from 'pg'

/**
 * ⚠️ **The length cap is load-bearing, not tidiness.**
 *
 * `db/new-faction.mjs` interpolates the slug straight into
 * `CREATE DATABASE faction_${slug}` and `CREATE ROLE app_${slug}`. The
 * character class stops injection; the cap stops a subtler failure: Postgres
 * truncates identifiers at 63 bytes SILENTLY, so `faction_<62 chars>` and a
 * different `faction_<62 chars>` can land on the same database. 20 is ample for
 * a faction slug and nowhere near the cliff.
 */
export const SLUG_PATTERN = /^[a-z][a-z0-9_]{1,20}$/

/**
 * Slugs that would collide with something that already exists or already means
 * something.
 *
 * ⚠️ `*_dev` is the interesting one. The staging stack's databases are
 * `faction_<slug>_dev`, and `slugFromDbName` in the status collector
 * deliberately excludes them so five phantom tenants are not reported as down.
 * A real faction slugged `mayhem_dev` would produce `faction_mayhem_dev`, which
 * the fleet monitor would then silently never report on — a tenant invisible to
 * the thing whose job is to notice tenants going down.
 */
export const RESERVED_SLUGS = new Set(['global', 'postgres', 'template0', 'template1', 'admin', 'public'])

export interface ProvisionInput {
  slug: string
  displayName: string
  tornFactionId: string
  leaderId?: string
  adminId?: string
}

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string }

export function validateProvisionRequest(body: unknown): Validation<ProvisionInput> {
  const b = (body ?? {}) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

  const slug = str(b.slug).toLowerCase()
  if (!SLUG_PATTERN.test(slug)) {
    return {
      ok: false,
      error: 'Slug must be 2–21 characters: a lowercase letter followed by lowercase letters, digits or underscores.',
    }
  }
  if (RESERVED_SLUGS.has(slug)) return { ok: false, error: `"${slug}" is reserved.` }
  if (slug.endsWith('_dev')) {
    return {
      ok: false,
      error: 'Slugs ending in "_dev" are reserved for the staging stack, and a faction named that way would be invisible to fleet monitoring.',
    }
  }

  const displayName = str(b.displayName)
  if (displayName.length < 2 || displayName.length > 80) {
    return { ok: false, error: 'Display name must be 2–80 characters.' }
  }

  const tornFactionId = str(b.tornFactionId)
  if (!/^[1-9]\d{0,9}$/.test(tornFactionId)) {
    return { ok: false, error: 'Torn faction id must be a positive number.' }
  }

  const out: ProvisionInput = { slug, displayName, tornFactionId }
  for (const [field, key] of [['leaderId', 'leaderId'], ['adminId', 'adminId']] as const) {
    const raw = str(b[key])
    if (raw === '') continue
    if (!/^[1-9]\d{0,9}$/.test(raw)) return { ok: false, error: `${field} must be a Torn user id.` }
    out[field] = raw
  }
  return { ok: true, value: out }
}

export interface Conflict {
  field: 'slug' | 'tornFactionId'
  reason: string
}

/**
 * Refuse a request that would half-provision rather than let the agent
 * discover it and fail messily.
 *
 * ⚠️ The database check reads `pg_database`, a shared catalog `app_global_rw`
 * can see without being able to CONNECT to any of them. The Torn-id check can
 * only look at this table's own history — the admin container has no read
 * access to any faction's `faction_config`, by design — so it catches a repeat
 * request but not a faction provisioned by hand before this existed. The agent
 * is the backstop: `new-faction.mjs` refuses an existing database unless
 * `--adopt` is passed, and this never passes it.
 */
export async function findConflicts(
  db: pg.Pool,
  input: ProvisionInput
): Promise<Conflict[]> {
  const conflicts: Conflict[] = []

  const dbs = await db.query('SELECT 1 FROM pg_database WHERE datname = $1', [`faction_${input.slug}`])
  if (dbs.rowCount) conflicts.push({ field: 'slug', reason: `Database faction_${input.slug} already exists.` })

  const live = await db.query(
    `SELECT status FROM provision_requests
      WHERE slug = $1 AND status IN ('pending', 'running', 'done') ORDER BY id DESC LIMIT 1`,
    [input.slug]
  )
  if (live.rowCount) {
    conflicts.push({ field: 'slug', reason: `A ${live.rows[0].status} request already exists for "${input.slug}".` })
  }

  const sameTorn = await db.query(
    `SELECT slug FROM provision_requests
      WHERE torn_faction_id = $1 AND slug <> $2 AND status IN ('pending', 'running', 'done')`,
    [input.tornFactionId, input.slug]
  )
  if (sameTorn.rowCount) {
    conflicts.push({
      field: 'tornFactionId',
      reason: `Torn faction ${input.tornFactionId} is already provisioned as "${sameTorn.rows[0].slug}".`,
    })
  }

  return conflicts
}

export interface ProvisionRequestRow {
  id: number
  slug: string
  display_name: string
  torn_faction_id: string
  leader_id: string | null
  admin_id: string | null
  status: 'pending' | 'running' | 'done' | 'failed'
  step: string | null
  log: string
  requested_by: string | null
  requested_at: string
  started_at: string | null
  finished_at: string | null
  attempts: number
}

const COLUMNS = `id, slug, display_name, torn_faction_id, leader_id, admin_id,
                 status, step, log, requested_by, requested_at, started_at, finished_at, attempts`

export async function createProvisionRequest(
  db: pg.Pool,
  input: ProvisionInput,
  requestedBy: string
): Promise<ProvisionRequestRow> {
  const res = await db.query(
    `INSERT INTO provision_requests (slug, display_name, torn_faction_id, leader_id, admin_id, requested_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUMNS}`,
    [input.slug, input.displayName, input.tornFactionId, input.leaderId ?? null, input.adminId ?? null, requestedBy]
  )
  return res.rows[0]
}

export async function listProvisionRequests(db: pg.Pool, limit = 20): Promise<ProvisionRequestRow[]> {
  const res = await db.query(
    `SELECT ${COLUMNS} FROM provision_requests ORDER BY id DESC LIMIT $1`,
    [Math.min(Math.max(limit, 1), 100)]
  )
  return res.rows
}

export async function getProvisionRequest(db: pg.Pool, id: number): Promise<ProvisionRequestRow | null> {
  const res = await db.query(`SELECT ${COLUMNS} FROM provision_requests WHERE id = $1`, [id])
  return res.rows[0] ?? null
}

/**
 * Put a failed request back in the queue.
 *
 * ⚠️ Only a FAILED request may be retried. Re-queueing one that is `running`
 * would hand the same slug to a second agent run while the first is still
 * inside `new-faction.mjs` — the exact race the partial unique index exists to
 * prevent, arriving through the front door instead.
 *
 * ⚠️ The log is kept, not cleared. `new-faction.mjs` is idempotent and has an
 * `--adopt` path, so the useful question on a retry is "what did it get through
 * last time" — and answering it from the previous log is the difference between
 * a retry and a guess.
 */
export async function retryProvisionRequest(db: pg.Pool, id: number): Promise<ProvisionRequestRow | null> {
  const res = await db.query(
    `UPDATE provision_requests
        SET status = 'pending', finished_at = NULL, started_at = NULL,
            log = log || E'\\n--- retry requested ---\\n'
      WHERE id = $1 AND status = 'failed'
      RETURNING ${COLUMNS}`,
    [id]
  )
  return res.rows[0] ?? null
}
