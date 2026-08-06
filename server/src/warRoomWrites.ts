// War-room write path (slice #72) — dibs, chain save, roll call, notes.
// Ports the war-room-fetch edge handlers onto the authenticated API: the
// session identifies the actor (the old dibs flow deliberately skipped user
// verification — that hole closes here for free), the DB's partial unique
// index serializes concurrent dib claims, and every mutation that rides a
// WS channel is broadcast to connected clients immediately.
//
// Visitor semantics (read-only demo role): dibs allowed, the leads-only
// private note readable; roll call, notes, chain-save rejected.
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { requireAuth, requireNotVisitor, requireRole } from './authz.js'
import { rolesFromClaims } from './auth.js'
import { DIBS_EXPIRY_SECONDS } from './warRoomDibsExpiry.js'
import {
  buildJsonPayload,
  buildNukeFields,
  checkReviveTarget,
  resolveCountryFromDescription,
} from './warRoomRevive.js'
import type { WarRoomHub } from './warRoom.js'

export interface WarRoomWriteDeps {
  db: pg.Pool
  hub: WarRoomHub
}

export function registerWarRoomWriteRoutes(app: FastifyInstance, { db, hub }: WarRoomWriteDeps) {
  async function actorName(tornUserId: string): Promise<string> {
    const res = await db.query('SELECT member_name FROM members WHERE member_id = $1', [tornUserId])
    return res.rows[0]?.member_name ?? `User ${tornUserId}`
  }

  async function serverNow(): Promise<string> {
    const res = await db.query('SELECT now() AS n')
    return res.rows[0].n
  }

  const isAdmin = (req: any) => rolesFromClaims(req.session!).includes('admin')

  // ── Dibs ────────────────────────────────────────────────────────────────
  // Visitors included: claiming a target is the one mutation the demo role
  // keeps (it's how the war room is trialled).
  app.post('/api/war-room/dibs', { preHandler: requireAuth() }, async (req, reply) => {
    const body = req.body as { target_id?: unknown; war_id?: unknown } | null
    const targetId = Number(body?.target_id)
    if (!Number.isFinite(targetId) || targetId <= 0) {
      return reply.status(400).send({ error: 'target_id required' })
    }
    const userId = Number(req.session!.torn_user_id)
    const name = await actorName(req.session!.torn_user_id)

    const dbc = await db.connect()
    try {
      await dbc.query('BEGIN')
      const existing = await dbc.query(
        `SELECT claimed_by, claimed_name FROM war_room_dibs_v2
         WHERE target_id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [targetId]
      )
      if (existing.rows.length > 0 && Number(existing.rows[0].claimed_by) !== userId) {
        await dbc.query('ROLLBACK')
        return reply.status(409).send({
          error: `Already claimed by ${existing.rows[0].claimed_name}`,
          owner: { id: Number(existing.rows[0].claimed_by), name: existing.rows[0].claimed_name },
        })
      }
      // Single-dibs rule: tombstone the caller's other live claims (and a
      // re-claim of the same target) before inserting the fresh row.
      const tombstoned = await dbc.query(
        `UPDATE war_room_dibs_v2 SET deleted_at = now(), updated_at = now()
         WHERE claimed_by = $1 AND deleted_at IS NULL RETURNING *`,
        [userId]
      )
      // #159: if the target is already alive (Okay) at claim time, start the
      // auto-drop countdown — dibs_expiry_seconds out — so a claim the holder
      // never converts frees up. A target still in hospital gets no claim-time
      // deadline; the #106 hospital-exit window governs that case instead.
      const ctx = await dbc.query(
        `SELECT (SELECT dibs_expiry_seconds FROM war_room_config_v2 WHERE id = 1) AS secs,
                (SELECT state->'status'->>'state' FROM war_room_state_v2 WHERE member_id = $1) AS status`,
        [targetId]
      )
      const expirySecs = Number(ctx.rows[0]?.secs ?? DIBS_EXPIRY_SECONDS)
      const targetAlive = ctx.rows[0]?.status === 'Okay'
      const inserted = await dbc.query(
        `INSERT INTO war_room_dibs_v2 (target_id, claimed_by, claimed_name, war_id, auto_expire_at)
         VALUES ($1, $2, $3, $4,
                 CASE WHEN $5 THEN now() + make_interval(secs => $6) ELSE NULL END)
         RETURNING *`,
        [targetId, userId, name, body?.war_id ?? null, targetAlive, expirySecs]
      )
      await dbc.query('COMMIT')
      hub.broadcast('dibs', [...tombstoned.rows, ...inserted.rows], await serverNow())
      return { ok: true }
    } catch (err: any) {
      await dbc.query('ROLLBACK')
      // The partial unique index is the last word under true races.
      if (err?.code === '23505') {
        const owner = await db.query(
          `SELECT claimed_by, claimed_name FROM war_room_dibs_v2
           WHERE target_id = $1 AND deleted_at IS NULL`,
          [targetId]
        )
        return reply.status(409).send({
          error: `Already claimed by ${owner.rows[0]?.claimed_name ?? 'someone else'}`,
          owner: owner.rows[0]
            ? { id: Number(owner.rows[0].claimed_by), name: owner.rows[0].claimed_name }
            : null,
        })
      }
      throw err
    } finally {
      dbc.release()
    }
  })

  app.delete('/api/war-room/dibs/:targetId', { preHandler: requireAuth() }, async (req) => {
    const { targetId } = req.params as { targetId: string }
    const userId = Number(req.session!.torn_user_id)
    // Non-admins release only their own claim (a filtered no-op otherwise).
    const res = isAdmin(req)
      ? await db.query(
          `UPDATE war_room_dibs_v2 SET deleted_at = now(), updated_at = now()
           WHERE target_id = $1 AND deleted_at IS NULL RETURNING *`,
          [targetId]
        )
      : await db.query(
          `UPDATE war_room_dibs_v2 SET deleted_at = now(), updated_at = now()
           WHERE target_id = $1 AND deleted_at IS NULL AND claimed_by = $2 RETURNING *`,
          [targetId, userId]
        )
    if (res.rows.length > 0) hub.broadcast('dibs', res.rows, await serverNow())
    return { ok: true }
  })

  // ── Chain save ──────────────────────────────────────────────────────────
  app.post('/api/war-room/chain-save', { preHandler: requireNotVisitor() }, async (req, reply) => {
    const userId = Number(req.session!.torn_user_id)
    const name = await actorName(req.session!.torn_user_id)
    const existing = await db.query(
      'SELECT save_claimed_by, save_claimed_name FROM war_room_chain_v2 WHERE id = 1'
    )
    const holder = existing.rows[0]?.save_claimed_by
    if (holder != null && Number(holder) !== userId) {
      return reply.status(409).send({
        error: `Already claimed by ${existing.rows[0].save_claimed_name}`,
        owner: { id: Number(holder), name: existing.rows[0].save_claimed_name },
      })
    }
    const res = await db.query(
      `UPDATE war_room_chain_v2 SET save_claimed_by = $1, save_claimed_name = $2,
              save_claimed_at = now(), updated_at = now()
       WHERE id = 1 RETURNING *`,
      [userId, name]
    )
    if (res.rows.length > 0) hub.broadcast('chain', res.rows, await serverNow())
    return { ok: true }
  })

  app.delete('/api/war-room/chain-save', { preHandler: requireNotVisitor() }, async (req) => {
    const userId = Number(req.session!.torn_user_id)
    const res = isAdmin(req)
      ? await db.query(
          `UPDATE war_room_chain_v2 SET save_claimed_by = NULL, save_claimed_name = NULL,
                  save_claimed_at = NULL, updated_at = now()
           WHERE id = 1 AND save_claimed_by IS NOT NULL RETURNING *`
        )
      : await db.query(
          `UPDATE war_room_chain_v2 SET save_claimed_by = NULL, save_claimed_name = NULL,
                  save_claimed_at = NULL, updated_at = now()
           WHERE id = 1 AND save_claimed_by = $1 RETURNING *`,
          [userId]
        )
    if (res.rows.length > 0) hub.broadcast('chain', res.rows, await serverNow())
    return { ok: true }
  })

  // ── Headline banner (#158) ───────────────────────────────────────────────
  // One active leader headline on the config singleton, broadcast live over the
  // 'config' channel. Warleads/leadership/admin set or clear it; everyone sees it.
  const HEADLINE_TONES = ['danger', 'warn', 'go', 'neutral']
  const HEADLINE_MAX = 200

  app.post('/api/war-room/headline', { preHandler: requireRole('warlead', 'leadership', 'admin') }, async (req, reply) => {
    const body = req.body as { text?: unknown; tone?: unknown } | null
    const text = typeof body?.text === 'string' ? body.text.trim() : ''
    if (!text) return reply.status(400).send({ error: 'text required' })
    if (text.length > HEADLINE_MAX) return reply.status(400).send({ error: `text must be ≤ ${HEADLINE_MAX} chars` })
    const tone = typeof body?.tone === 'string' && HEADLINE_TONES.includes(body.tone) ? body.tone : 'neutral'
    const userId = Number(req.session!.torn_user_id)
    const res = await db.query(
      `INSERT INTO war_room_config_v2 (id, headline_text, headline_tone, headline_set_by, headline_set_at, updated_at)
       VALUES (1, $1, $2, $3, now(), now())
       ON CONFLICT (id) DO UPDATE SET headline_text = EXCLUDED.headline_text,
         headline_tone = EXCLUDED.headline_tone, headline_set_by = EXCLUDED.headline_set_by,
         headline_set_at = now(), updated_at = now()
       RETURNING *`,
      [text, tone, userId]
    )
    if (res.rows.length > 0) hub.broadcast('config', res.rows, await serverNow())
    return { ok: true }
  })

  app.delete('/api/war-room/headline', { preHandler: requireRole('warlead', 'leadership', 'admin') }, async () => {
    const res = await db.query(
      `UPDATE war_room_config_v2 SET headline_text = NULL, headline_tone = NULL,
              headline_set_by = NULL, headline_set_at = NULL, updated_at = now()
       WHERE id = 1 RETURNING *`
    )
    if (res.rows.length > 0) hub.broadcast('config', res.rows, await serverNow())
    return { ok: true }
  })

  // ── Roll call ───────────────────────────────────────────────────────────
  // Visitors excluded on submit: a roll-call row for a non-member would
  // pollute leadership's results table.
  app.post('/api/war-room/roll-call', { preHandler: requireNotVisitor() }, async (req, reply) => {
    const d = req.body as Record<string, any> | null
    if (d?.war_id == null) return reply.status(400).send({ error: 'war_id required' })
    if (typeof d.on_at_start !== 'boolean') return reply.status(400).send({ error: 'on_at_start required' })

    const userId = Number(req.session!.torn_user_id)
    const name = await actorName(req.session!.torn_user_id)
    // Q2/Q3 only apply when not on at the start.
    const answers = {
      on_at_start: d.on_at_start,
      can_self_hospital: d.on_at_start ? null : (d.can_self_hospital ?? null),
      needs_merc: d.on_at_start ? null : (d.needs_merc ?? null),
      availability: d.on_at_start ? 'on_time' : (d.availability ?? null),
    }

    const existing = await db.query(
      `SELECT * FROM war_room_roll_call_v2 WHERE war_id = $1 AND member_id = $2`,
      [d.war_id, userId]
    )
    if (existing.rows.length === 0) {
      await db.query(
        `INSERT INTO war_room_roll_call_v2 (war_id, member_id, member_name, on_at_start,
           can_self_hospital, needs_merc, availability)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [d.war_id, userId, name, answers.on_at_start, answers.can_self_hospital,
         answers.needs_merc, answers.availability]
      )
      return { ok: true, created: true }
    }
    const prev = existing.rows[0]
    const changed =
      prev.on_at_start !== answers.on_at_start ||
      prev.can_self_hospital !== answers.can_self_hospital ||
      prev.needs_merc !== answers.needs_merc ||
      prev.availability !== answers.availability
    await db.query(
      `UPDATE war_room_roll_call_v2 SET member_name = $2, on_at_start = $3,
         can_self_hospital = $4, needs_merc = $5, availability = $6,
         revised = CASE WHEN $7 THEN true ELSE revised END, updated_at = now()
       WHERE id = $1`,
      [prev.id, name, answers.on_at_start, answers.can_self_hospital,
       answers.needs_merc, answers.availability, changed]
    )
    return { ok: true, updated: true, changed }
  })

  // Roll-call rows are member-visible (matches the legacy RLS surface): the
  // banner needs "have I answered?", the leads panel needs everyone's.
  app.get(
    '/api/war-room/roll-call',
    { preHandler: requireAuth() },
    async (req, reply) => {
      const warId = (req.query as { war_id?: string }).war_id
      if (!warId) return reply.status(400).send({ error: 'war_id required' })
      const res = await db.query(
        `SELECT * FROM war_room_roll_call_v2 WHERE war_id = $1 ORDER BY submitted_at ASC`,
        [warId]
      )
      return { responses: res.rows }
    }
  )

  // ── War notes ───────────────────────────────────────────────────────────
  // Public row is optimistically locked on updated_at; the private note
  // lives in its own table and is never on the member-readable surface.
  app.put(
    '/api/war-room/notes',
    { preHandler: [requireNotVisitor(), requireRole('warlead', 'leadership', 'admin')] },
    async (req, reply) => {
      const d = req.body as Record<string, any> | null
      if (d?.war_id == null) return reply.status(400).send({ error: 'war_id required' })
      const userId = Number(req.session!.torn_user_id)
      const name = await actorName(req.session!.torn_user_id)

      const publicCols = {
        opponent_faction_id: d.opponent_faction_id ?? null,
        war_type: d.war_type ?? null,
        termed_score_us: d.termed_score_us ?? null,
        termed_score_them: d.termed_score_them ?? null,
        race_target_score: d.race_target_score ?? null,
        notes_public: d.notes_public ?? null,
      }
      const expected = d.expected_updated_at ?? null

      if (expected) {
        const updated = await db.query(
          `UPDATE war_room_notes_v2 SET opponent_faction_id = $2, war_type = $3,
             termed_score_us = $4, termed_score_them = $5, race_target_score = $6,
             notes_public = $7, updated_by_id = $8, updated_by_name = $9, updated_at = now()
           WHERE war_id = $1 AND updated_at = $10 RETURNING updated_at`,
          [d.war_id, publicCols.opponent_faction_id, publicCols.war_type,
           publicCols.termed_score_us, publicCols.termed_score_them,
           publicCols.race_target_score, publicCols.notes_public, userId, name, expected]
        )
        if (updated.rows.length === 0) {
          const exists = await db.query('SELECT 1 FROM war_room_notes_v2 WHERE war_id = $1', [d.war_id])
          if (exists.rows.length > 0) {
            return reply.status(409).send({
              error: 'These notes were changed by someone else. Reload and try again.',
              conflict: true,
            })
          }
          await db.query(
            `INSERT INTO war_room_notes_v2 (war_id, opponent_faction_id, war_type, termed_score_us,
               termed_score_them, race_target_score, notes_public, updated_by_id, updated_by_name)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [d.war_id, publicCols.opponent_faction_id, publicCols.war_type,
             publicCols.termed_score_us, publicCols.termed_score_them,
             publicCols.race_target_score, publicCols.notes_public, userId, name]
          )
        }
      } else {
        await db.query(
          `INSERT INTO war_room_notes_v2 (war_id, opponent_faction_id, war_type, termed_score_us,
             termed_score_them, race_target_score, notes_public, updated_by_id, updated_by_name)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (war_id) DO UPDATE SET
             opponent_faction_id = EXCLUDED.opponent_faction_id, war_type = EXCLUDED.war_type,
             termed_score_us = EXCLUDED.termed_score_us, termed_score_them = EXCLUDED.termed_score_them,
             race_target_score = EXCLUDED.race_target_score, notes_public = EXCLUDED.notes_public,
             updated_by_id = EXCLUDED.updated_by_id, updated_by_name = EXCLUDED.updated_by_name,
             updated_at = now()`,
          [d.war_id, publicCols.opponent_faction_id, publicCols.war_type,
           publicCols.termed_score_us, publicCols.termed_score_them,
           publicCols.race_target_score, publicCols.notes_public, userId, name]
        )
      }

      // The private (leads-only) note rides every save; undefined leaves it alone.
      if (d.notes_private !== undefined) {
        await db.query(
          `INSERT INTO war_room_notes_private_v2 (war_id, notes, updated_by_id, updated_by_name)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (war_id) DO UPDATE SET notes = EXCLUDED.notes,
             updated_by_id = EXCLUDED.updated_by_id, updated_by_name = EXCLUDED.updated_by_name,
             updated_at = now()`,
          [d.war_id, d.notes_private ?? null, userId, name]
        )
      }

      const fresh = await db.query('SELECT updated_at FROM war_room_notes_v2 WHERE war_id = $1', [d.war_id])
      return { ok: true, updated_at: fresh.rows[0]?.updated_at ?? null }
    }
  )

  // Past-wars archive (#145): every war's notes joined to ranked_wars for the
  // opponent + start date, newest first. Leads only — never members/visitors.
  // The list carries only the public note; the private note stays behind the
  // per-war leads-gated endpoint below. (Static route — Fastify matches it
  // ahead of /notes/:warId.)
  app.get(
    '/api/war-room/notes/archive',
    { preHandler: requireRole('warlead', 'leadership', 'admin') },
    async () => {
      const res = await db.query(
        `SELECT n.war_id, n.opponent_faction_id, n.war_type, n.notes_public, n.updated_at,
                w.opponent_name, w.start_at, w.end_at
         FROM war_room_notes_v2 n
         LEFT JOIN ranked_wars w ON w.id = n.war_id
         ORDER BY COALESCE(w.start_at, 0) DESC, n.war_id DESC`
      )
      return { wars: res.rows }
    }
  )

  app.get('/api/war-room/notes/:warId', { preHandler: requireAuth() }, async (req) => {
    const { warId } = req.params as { warId: string }
    const res = await db.query('SELECT * FROM war_room_notes_v2 WHERE war_id = $1', [warId])
    return { notes: res.rows[0] ?? null }
  })

  // The private note read deliberately includes visitors: they demo the full
  // leads view, and this only ever reads.
  app.get(
    '/api/war-room/notes/:warId/private',
    { preHandler: requireRole('warlead', 'leadership', 'admin', 'visitor') },
    async (req) => {
      const { warId } = req.params as { warId: string }
      const res = await db.query(
        'SELECT notes, updated_at FROM war_room_notes_private_v2 WHERE war_id = $1',
        [warId]
      )
      return { ok: true, notes: res.rows[0]?.notes ?? '', updated_at: res.rows[0]?.updated_at ?? null }
    }
  )

  // ── Revive request proxy (#308) ─────────────────────────────────────────
  // Browsers cannot POST cross-origin to services like tornuhc.eu, so the
  // server forwards the call (server-to-server, no CORS). Replaces the retired
  // Supabase `war-room-fetch` `revive_request` action.
  //
  // NOTE (Nuke): Nuke appears to shadow-filter datacenter IPs — it answers 200
  // while the request never reaches the reviver pool. The VPS is a datacenter
  // IP, so the frontend still sends the Nuke preset DIRECT from the browser
  // (residential IP) and only routes JSON presets here. This endpoint
  // implements the Nuke shape anyway, so flipping the frontend over is a
  // one-line change once a real Nuke request through the VPS is confirmed to
  // land. See #308.
  app.post('/api/war-room/revive', { preHandler: requireNotVisitor() }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>

    const target = checkReviveTarget(body.url)
    if (!target.ok) return reply.status(400).send({ error: target.error })
    const url = target.url!.toString()

    // Identity comes from the session, never the request body: a revive
    // request is always for yourself, and trusting a client-supplied id would
    // let anyone spam the reviver pool under someone else's name.
    const userID = Number(req.session!.torn_user_id)
    const identity = {
      userID,
      userName: await actorName(req.session!.torn_user_id),
      factionName: typeof body.factionName === 'string' ? body.factionName : '',
    }
    const source = typeof body.source === 'string' ? body.source : undefined
    const preset = String(body.preset ?? 'json').toLowerCase()

    let headers: Record<string, string>
    let outBody: string
    let sentPayload: Record<string, unknown>

    if (preset === 'nuke') {
      // The server owns war-room state, so it resolves the country itself
      // rather than trusting whatever the client believed. A tombstoned row is
      // "not in state" and falls back to Torn.
      const state = await db.query(
        `SELECT state->'status'->>'description' AS description
           FROM war_room_state_v2 WHERE member_id = $1 AND deleted_at IS NULL`,
        [userID]
      )
      const country = resolveCountryFromDescription(state.rows[0]?.description)
      sentPayload = buildNukeFields(identity, { source, country })
      headers = { 'content-type': 'application/x-www-form-urlencoded' }
      outBody = new URLSearchParams(sentPayload as Record<string, string>).toString()
    } else {
      sentPayload = buildJsonPayload(identity, {
        source,
        sourceKey: typeof body.sourceKey === 'string' ? body.sourceKey : undefined,
      })
      headers = { 'content-type': 'application/json' }
      outBody = JSON.stringify(sentPayload)
    }

    try {
      // The service is a third party that can hang; without a deadline a stuck
      // connection would pin a request handler until the client gives up.
      const resp = await fetch(url, {
        method: 'POST', headers, body: outBody,
        signal: AbortSignal.timeout(15_000),
      })
      const text = await resp.text()
      let parsed: unknown
      try { parsed = JSON.parse(text) } catch { parsed = { raw: text } }
      // A non-2xx from the SERVICE is a successful proxy of a refusal, not a
      // proxy failure — the UI renders ok:false and shows the reason.
      return { ok: resp.ok, status: resp.status, body: parsed, sentPayload, url }
    } catch (e) {
      req.log.error({ err: e, url, preset }, 'revive request failed')
      return reply.status(502).send({ error: `Revive request failed: ${(e as Error).message}` })
    }
  })
}
