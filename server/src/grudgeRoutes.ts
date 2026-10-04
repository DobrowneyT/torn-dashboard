// The Book of Grudges (#889) — slice 1: schema-backed CRUD, permissions, audit.
//
// ⚠️ **No Torn calls anywhere in this file, by design.** Every Torn call this
// epic needs is gated behind the API Key Usage disclosure update and the
// forced re-accept (slice 0), because pointing an already-disclosed endpoint
// at arbitrary players and factions is a change of USE even though it is not a
// new endpoint. So a target added here carries its id and whatever the client
// already knew; the enrichment pass fills in name, faction and stats later.
//
// ⚠️ Not coupled to the War Room. Nothing here reads `war_room_state_v2`.
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { requireAuth, requireNotVisitor } from './authz.js'
import { rolesFromClaims } from './auth.js'
import {
  parseTargetId, initialState, canSeeTarget, canModifyEntry, normaliseReason,
} from './grudges.js'
import { readProfile } from './grudgeEnrich.js'
import { createKeyPool } from './scraper/keyPool.js'
import { createTornClient } from './scraper/tornClient.js'

const LEADERSHIP = new Set(['admin', 'leadership'])

const viewerOf = (req: any) => {
  const roles = rolesFromClaims(req.session)
  return {
    memberId: String(req.session.torn_user_id),
    isLeadership: roles.some((r: string) => LEADERSHIP.has(r)),
  }
}

/** Factions leadership wants held for approval. A setting, never hardcoded. */
async function watchedFactions(db: pg.Pool): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT value FROM faction_settings WHERE key = 'grudge_watched_factions'`
  )
  const v = rows[0]?.value
  return Array.isArray(v) ? v.map((x: unknown) => String(x)) : []
}

/** Append-only. This table IS the history the feature was asked for. */
async function audit(
  db: pg.Pool,
  row: {
    targetRowId: number | null; targetId: string; entryId?: number | null
    actor: string; action: string
    field?: string | null; oldValue?: string | null; newValue?: string | null
  }
) {
  await db.query(
    `INSERT INTO grudge_audit
       (target_row_id, target_id, entry_id, actor_member_id, action, field, old_value, new_value)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [row.targetRowId, row.targetId, row.entryId ?? null, row.actor, row.action,
     row.field ?? null, row.oldValue ?? null, row.newValue ?? null]
  )
}

export interface GrudgeRouteDeps {
  db: pg.Pool
  tornBaseUrl: string
  encryptionKey?: string
}

export function registerGrudgeRoutes(app: FastifyInstance, deps: GrudgeRouteDeps) {
  const db = deps.db

  type Looked =
    | ({ ok: true } & NonNullable<ReturnType<typeof readProfile>>)
    | { ok: false; reason: 'no_key' | 'fetch_failed' }

  /**
   * Resolve a target inline, for the add path.
   *
   * ⚠️ `pool.claim({ purpose: 'target-lookup' })`. A member who has not
   * accepted the Target Lookups disclosure is skipped for this and for nothing
   * else (#894). If nobody has accepted, there is no key and the caller fails
   * closed — which is a consent decision working, not an outage.
   *
   * ⚠️ `/user/{id}/profile`, never `/user/{id}/basic`: `basic` carries no
   * faction, and the faction is the whole reason this call happens here.
   */
  async function lookupTarget(targetId: string): Promise<Looked> {
    if (!deps.encryptionKey) return { ok: false, reason: 'no_key' }
    try {
      const pool = createKeyPool({ db, encryptionKey: deps.encryptionKey })
      const claimed = await pool.claim({ purpose: 'target-lookup' })
      if (!claimed) return { ok: false, reason: 'no_key' }
      const client = createTornClient({
        baseUrl: deps.tornBaseUrl,
        budget: { requests: 60, perMs: 60_000 },
      })
      const data = await client.fetch(`/v2/user/${targetId}/profile`, claimed.key)
      const p = readProfile(data)
      return p ? { ok: true, ...p } : { ok: false, reason: 'fetch_failed' }
    } catch {
      // ⚠️ A Torn failure must not fail the ADD. The grudge is the member's
      // contribution and is worth keeping; the lookup is enrichment and the
      // sweep will retry it. Failing closed on the state is the safe half.
      return { ok: false, reason: 'fetch_failed' }
    }
  }
  /* ──────────────────────────────────────────────────────────── settings ── */
  // ⚠️ Severity labels are a FACTION SETTING, never an enum in code. Factions
  // will want their own vocabulary, and a hardcoded Low/Medium/High would be
  // both wrong for them and considerably less fun. An unconfigured faction gets
  // an empty list and the control simply does not render — which is the honest
  // outcome, rather than inventing three tiers nobody chose.
  app.get('/api/grudges/settings', { preHandler: requireAuth() }, async (req) => {
    const viewer = viewerOf(req)
    const { rows } = await db.query(
      `SELECT key, value FROM faction_settings
        WHERE key IN ('grudge_severities', 'grudge_watched_factions')`
    )
    const byKey = new Map(rows.map((r: any) => [r.key, r.value]))
    const severities = byKey.get('grudge_severities')
    return {
      severities: Array.isArray(severities) ? severities : [],
      // Only leadership needs to know which factions trip the gate; a plain
      // member seeing the list learns nothing useful and it is a leadership
      // policy, not public information.
      watched_factions: viewer.isLeadership
        ? ((byKey.get('grudge_watched_factions') as unknown[]) ?? [])
        : undefined,
    }
  })

  /* ───────────────────────────────────────────────────────────── the list ── */
  app.get('/api/grudges', { preHandler: requireAuth() }, async (req) => {
    const viewer = viewerOf(req)
    const { rows: targets } = await db.query(
      // ⚠️ Timestamps converted to epoch ms IN SQL. This stack serves
      // timestamptz with a bare two-digit offset that `new Date()` reads as
      // NaN (#140); the client never meets that string.
      `SELECT id, target_id, target_name, faction_id, faction_name, level, state,
              bsp_total, bsp_str, bsp_spd, bsp_def, bsp_dex, spy_source,
              extract(epoch from bsp_fetched_at) * 1000 AS bsp_fetched_ms,
              -- ⚠️ When the SPY was taken, not when we fetched it. A TornStats
              -- spy can be months older than bsp_fetched_at, and the column
              -- shows this date so nobody reads a stale figure as current.
              -- (No backticks in here: this is inside a JS template literal,
              -- and one would end the string mid-query.)
              extract(epoch from ts_spy_at) * 1000 AS ts_spy_ms,
              status_state, status_until, status_description,
              extract(epoch from status_fetched_at) * 1000 AS status_fetched_ms,
              added_by, extract(epoch from added_at) * 1000 AS added_ms
         FROM grudge_targets
        WHERE removed_at IS NULL
        ORDER BY added_at DESC`
    )
    const visible = targets.filter((t: any) => canSeeTarget(t, viewer))
    if (visible.length === 0) return { targets: [] }

    const { rows: entries } = await db.query(
      `SELECT e.id, e.target_row_id, e.member_id, m.member_name, e.reason, e.severity_id,
              extract(epoch from e.created_at) * 1000 AS created_ms,
              extract(epoch from e.updated_at) * 1000 AS updated_ms
         FROM grudge_entries e
         LEFT JOIN members m ON m.member_id = e.member_id
        WHERE e.removed_at IS NULL AND e.target_row_id = ANY($1::bigint[])
        ORDER BY e.created_at`,
    [visible.map((t: any) => t.id)]
    )
    const byTarget = new Map<string, any[]>()
    for (const e of entries) {
      const k = String(e.target_row_id)
      byTarget.set(k, [...(byTarget.get(k) ?? []), e])
    }
    return {
      targets: visible.map((t: any) => ({ ...t, grudges: byTarget.get(String(t.id)) ?? [] })),
    }
  })

  /* ─────────────────────────────────────────────────────────── add a grudge ── */
  app.post(
    '/api/grudges',
    { preHandler: [requireAuth(), requireNotVisitor()] },
    async (req, reply) => {
      const viewer = viewerOf(req)
      const body = (req.body ?? {}) as any
      const targetId = parseTargetId(body.target)
      if (!targetId) {
        return reply.status(400).send({ error: 'Could not read a Torn profile link or user id' })
      }
      // ⚠️ Refused here as well as by the CHECK constraint. The premise of the
      // feature is that a target earns its place by a STATED grudge.
      const reason = normaliseReason(body.reason)
      if (!reason) return reply.status(400).send({ error: 'A reason is required' })
      if (targetId === viewer.memberId) {
        return reply.status(400).send({ error: 'You cannot hold a grudge against yourself' })
      }

      const watched = await watchedFactions(db)

      // ⚠️ Resolve the target NOW, inline, rather than leaving it to the
      // sweep. The watched-faction gate needs a faction, and at add time we
      // have none — so without this every target would land `active` and an
      // own-faction target would sit on the public list with a grudge attached
      // until the next refresh. That is precisely what the gate exists to
      // prevent, so a window of up to fifteen minutes is not acceptable.
      //
      // It also means the name appears immediately, which is the difference
      // between a readable list and a column of bare ids.
      const looked = await lookupTarget(targetId)
      const factionId = looked.ok ? looked.factionId : null

      // ⚠️ FAILS CLOSED. If we could not look the target up — nobody has
      // accepted the Target Lookups disclosure yet, or Torn is down — we
      // cannot rule out that they are in a watched faction, so leadership
      // rules on it. Publishing on an unverified assumption is the one
      // outcome worth avoiding here; a queue entry is merely annoying.
      const pendingReason: 'watched_faction' | 'unverified' | null = !looked.ok
        ? 'unverified'
        : (initialState(factionId, watched) === 'pending_approval' ? 'watched_faction' : null)

      const existing = await db.query(
        `SELECT id, state, removed_at FROM grudge_targets WHERE target_id = $1`, [targetId]
      )

      let targetRowId: number
      let state: string
      if (existing.rows.length > 0) {
        const row = existing.rows[0]
        targetRowId = Number(row.id)
        state = row.state
        if (row.removed_at !== null) {
          // ⚠️ Revive the SAME row rather than inserting a new one, so the
          // audit trail stays attached to the target it is about.
          state = pendingReason === null ? 'active' : 'pending_approval'
          await db.query(
            `UPDATE grudge_targets
                SET removed_at = NULL, removed_by = NULL, state = $2, state_changed_at = now()
              WHERE id = $1`, [targetRowId, state]
          )
          await audit(db, { targetRowId, targetId, actor: viewer.memberId, action: 'restored' })
        }
      } else {
        state = pendingReason === null ? 'active' : 'pending_approval'
        // ⚠️ The name is NOT accepted from the client — it comes from the
        // lookup above and nowhere else, so there is exactly one source for it
        // and a rename is a fact we observe rather than a guess somebody typed.
        const ins = await db.query(
          `INSERT INTO grudge_targets
             (target_id, target_name, level, faction_id, state, state_changed_at, added_by,
              status_state, status_until, status_description, status_fetched_at)
           VALUES ($1,$2,$3,$4,$5,now(),$6,$7,$8,$9,
                   CASE WHEN $7::text IS NULL THEN NULL ELSE now() END)
           RETURNING id`,
          [targetId, looked.ok ? looked.name : null, looked.ok ? looked.level : null,
           factionId, state, viewer.memberId,
           looked.ok ? looked.statusState : null,
           looked.ok ? looked.statusUntil : null,
           looked.ok ? looked.statusDescription : null]
        )
        targetRowId = Number(ins.rows[0].id)
        await audit(db, {
          targetRowId, targetId, actor: viewer.memberId, action: 'added',
          field: 'state', newValue: state,
        })
      }

      const entry = await db.query(
        `INSERT INTO grudge_entries (target_row_id, member_id, reason, severity_id)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [targetRowId, viewer.memberId, reason, body.severity_id ?? null]
      )
      const entryId = Number(entry.rows[0].id)
      await audit(db, {
        targetRowId, targetId, entryId, actor: viewer.memberId,
        action: 'added', field: 'reason', newValue: reason,
      })

      return reply.status(201).send({
        target_row_id: targetRowId, entry_id: entryId, state,
        // ⚠️ WHY it is pending, so the UI does not tell somebody their target
        // is in a watched faction when the truth is that we could not look
        // them up at all.
        pending_reason: state === 'pending_approval' ? pendingReason : null,
        target_name: looked.ok ? looked.name : null,
      })
    }
  )

  /* ────────────────────────────────────────────────────────── edit a grudge ── */
  app.patch(
    '/api/grudges/entries/:id',
    { preHandler: [requireAuth(), requireNotVisitor()] },
    async (req, reply) => {
      const viewer = viewerOf(req)
      const { id } = req.params as { id: string }
      if (!/^\d+$/.test(id)) return reply.status(400).send({ error: 'invalid id' })
      const { rows } = await db.query(
        `SELECT e.id, e.member_id, e.reason, e.severity_id, e.target_row_id, t.target_id
           FROM grudge_entries e JOIN grudge_targets t ON t.id = e.target_row_id
          WHERE e.id = $1 AND e.removed_at IS NULL`, [id]
      )
      const entry = rows[0]
      if (!entry) return reply.status(404).send({ error: 'not found' })
      if (!canModifyEntry(entry, viewer)) return reply.status(403).send({ error: 'Forbidden' })

      const body = (req.body ?? {}) as any
      const reason = body.reason === undefined ? entry.reason : normaliseReason(body.reason)
      if (!reason) return reply.status(400).send({ error: 'A reason is required' })
      const severity = body.severity_id === undefined ? entry.severity_id : body.severity_id

      await db.query(
        `UPDATE grudge_entries SET reason = $2, severity_id = $3, updated_at = now() WHERE id = $1`,
        [id, reason, severity]
      )
      if (reason !== entry.reason) {
        await audit(db, {
          targetRowId: Number(entry.target_row_id), targetId: entry.target_id,
          entryId: Number(id), actor: viewer.memberId, action: 'edited',
          field: 'reason', oldValue: entry.reason, newValue: reason,
        })
      }
      if (String(severity ?? '') !== String(entry.severity_id ?? '')) {
        await audit(db, {
          targetRowId: Number(entry.target_row_id), targetId: entry.target_id,
          entryId: Number(id), actor: viewer.memberId, action: 'edited',
          field: 'severity_id', oldValue: entry.severity_id, newValue: severity,
        })
      }
      return { id: Number(id), reason, severity_id: severity ?? null }
    }
  )

  /* ──────────────────────────────────────────────────────── remove a grudge ── */
  app.delete(
    '/api/grudges/entries/:id',
    { preHandler: [requireAuth(), requireNotVisitor()] },
    async (req, reply) => {
      const viewer = viewerOf(req)
      const { id } = req.params as { id: string }
      if (!/^\d+$/.test(id)) return reply.status(400).send({ error: 'invalid id' })
      const { rows } = await db.query(
        `SELECT e.id, e.member_id, e.reason, e.target_row_id, t.target_id
           FROM grudge_entries e JOIN grudge_targets t ON t.id = e.target_row_id
          WHERE e.id = $1 AND e.removed_at IS NULL`, [id]
      )
      const entry = rows[0]
      if (!entry) return reply.status(404).send({ error: 'not found' })
      if (!canModifyEntry(entry, viewer)) return reply.status(403).send({ error: 'Forbidden' })

      // ⚠️ Soft delete. The reason stays readable in the audit trail — that is
      // the point of keeping a history of what changed.
      await db.query(
        `UPDATE grudge_entries SET removed_at = now(), removed_by = $2 WHERE id = $1`,
        [id, viewer.memberId]
      )
      await audit(db, {
        targetRowId: Number(entry.target_row_id), targetId: entry.target_id,
        entryId: Number(id), actor: viewer.memberId, action: 'removed',
        field: 'reason', oldValue: entry.reason,
      })

      // A target with no grudges left is no longer on the list for any reason.
      const left = await db.query(
        `SELECT count(*)::int AS n FROM grudge_entries
          WHERE target_row_id = $1 AND removed_at IS NULL`, [entry.target_row_id]
      )
      if (left.rows[0].n === 0) {
        await db.query(
          `UPDATE grudge_targets SET removed_at = now(), removed_by = $2 WHERE id = $1`,
          [entry.target_row_id, viewer.memberId]
        )
        await audit(db, {
          targetRowId: Number(entry.target_row_id), targetId: entry.target_id,
          actor: viewer.memberId, action: 'removed', field: 'target',
          newValue: 'last grudge removed',
        })
      }
      return { removed: Number(id) }
    }
  )

  /* ───────────────────────────────────────────── leadership: the whole target ── */
  app.delete(
    '/api/grudges/targets/:id',
    { preHandler: [requireAuth(), requireNotVisitor()] },
    async (req, reply) => {
      const viewer = viewerOf(req)
      if (!viewer.isLeadership) return reply.status(403).send({ error: 'Forbidden' })
      const { id } = req.params as { id: string }
      if (!/^\d+$/.test(id)) return reply.status(400).send({ error: 'invalid id' })
      const { rows } = await db.query(
        `SELECT id, target_id FROM grudge_targets WHERE id = $1 AND removed_at IS NULL`, [id]
      )
      if (!rows[0]) return reply.status(404).send({ error: 'not found' })
      await db.query(
        `UPDATE grudge_targets SET removed_at = now(), removed_by = $2 WHERE id = $1`,
        [id, viewer.memberId]
      )
      await db.query(
        `UPDATE grudge_entries SET removed_at = now(), removed_by = $2
          WHERE target_row_id = $1 AND removed_at IS NULL`, [id, viewer.memberId]
      )
      await audit(db, {
        targetRowId: Number(id), targetId: rows[0].target_id,
        actor: viewer.memberId, action: 'removed', field: 'target',
      })
      return { removed: Number(id) }
    }
  )

  /* ────────────────────────────────────────────── leadership: the approval gate ── */
  for (const [verb, action, state] of [
    ['approve', 'approved', 'active'],
    ['reject', 'rejected', 'rejected'],
  ] as const) {
    app.post(
      `/api/grudges/targets/:id/${verb}`,
      { preHandler: [requireAuth(), requireNotVisitor()] },
      async (req, reply) => {
        const viewer = viewerOf(req)
        if (!viewer.isLeadership) return reply.status(403).send({ error: 'Forbidden' })
        const { id } = req.params as { id: string }
        if (!/^\d+$/.test(id)) return reply.status(400).send({ error: 'invalid id' })
        const { rows } = await db.query(
          `SELECT id, target_id, state FROM grudge_targets WHERE id = $1`, [id]
        )
        const t = rows[0]
        if (!t) return reply.status(404).send({ error: 'not found' })
        await db.query(
          `UPDATE grudge_targets
              SET state = $2, state_changed_at = now(), state_changed_by = $3
            WHERE id = $1`, [id, state, viewer.memberId]
        )
        await audit(db, {
          targetRowId: Number(id), targetId: t.target_id, actor: viewer.memberId,
          action, field: 'state', oldValue: t.state, newValue: state,
        })
        return { id: Number(id), state }
      }
    )
  }

  /* ──────────────────────────────────────────── leadership: what is waiting ── */
  app.get('/api/grudges/pending', { preHandler: requireAuth() }, async (req, reply) => {
    const viewer = viewerOf(req)
    if (!viewer.isLeadership) return reply.status(403).send({ error: 'Forbidden' })
    const { rows } = await db.query(
      `SELECT id, target_id, target_name, faction_id, faction_name, added_by,
              extract(epoch from added_at) * 1000 AS added_ms
         FROM grudge_targets
        WHERE state = 'pending_approval' AND removed_at IS NULL
        ORDER BY added_at`
    )
    return { pending: rows, count: rows.length }
  })

  /* ───────────────────────────────────────────────────────────── the history ── */
  app.get('/api/grudges/audit', { preHandler: requireAuth() }, async (req) => {
    const q = (req.query ?? {}) as any
    const targetId = q.target_id == null ? null : String(q.target_id)
    const { rows } = await db.query(
      `SELECT a.id, a.target_id, a.entry_id, a.actor_member_id, m.member_name AS actor_name,
              a.action, a.field, a.old_value, a.new_value,
              extract(epoch from a.at) * 1000 AS at_ms
         FROM grudge_audit a
         LEFT JOIN members m ON m.member_id = a.actor_member_id
        WHERE ($1::text IS NULL OR a.target_id = $1)
        ORDER BY a.at DESC
        LIMIT 500`, [targetId]
    )
    return { history: rows }
  })
}
