// Event bingo routes (#965).
//
// Members read their own card and ask for squares with proof. Leadership and
// admin set the card up, review the requests and can cross a square directly.
//
// ⚠️ Images (the card art and proof screenshots) are stored as bytea in the
// tenant DB, uploaded as base64 JSON — the branding pattern (#173): no shared
// volume, and they ride the per-faction backups.
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type pg from 'pg'
import { requireAuth, requireRole } from '../authz.js'
import {
  AUTO_RULES, HALLOWEEN_TEMPLATE, HALLOWEEN_GRID, checkCard, completedLines, type Tile,
} from './bingo.js'

const LEAD = { preHandler: [requireRole('leadership', 'admin')] }
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const CARD_IMAGE_MAX = 5_242_880 // 5 MB
const PROOF_IMAGE_MAX = 3_145_728 // 3 MB
const PROOF_TEXT_MAX = 4000

const me = (req: FastifyRequest) => String((req.session as any)?.torn_user_id ?? '')
const isLead = (req: FastifyRequest) => {
  const s = req.session as any
  return !!(s?.is_leadership || s?.is_admin)
}

function decodeBase64(input: string): Buffer {
  let b64 = input
  if (b64.startsWith('data:')) {
    const comma = b64.indexOf(',')
    if (comma !== -1) b64 = b64.slice(comma + 1)
  }
  return Buffer.from(b64, 'base64')
}

async function card(db: pg.Pool, eventId: number) {
  const { rows } = await db.query(
    `SELECT enabled, rows, cols, grid_left::float8 AS l, grid_top::float8 AS t,
            grid_right::float8 AS r, grid_bottom::float8 AS b,
            image IS NOT NULL AS has_image,
            (extract(epoch FROM image_updated_at) * 1000)::bigint AS image_ms
       FROM event_bingo_cards WHERE event_id = $1`, [eventId])
  const c = rows[0]
  const tiles = (await db.query(
    'SELECT idx, label, kind, rule FROM event_bingo_tiles WHERE event_id = $1 ORDER BY idx', [eventId],
  )).rows.map((t): Tile => ({ idx: Number(t.idx), label: t.label, kind: t.kind, rule: t.rule }))
  return c
    ? {
        configured: true,
        enabled: !!c.enabled,
        rows: Number(c.rows),
        cols: Number(c.cols),
        grid: { left: c.l, top: c.t, right: c.r, bottom: c.b },
        image_url: c.has_image ? `/api/events/${eventId}/bingo/image?v=${c.image_ms ?? 0}` : null,
        tiles,
      }
    : {
        configured: false, enabled: false, rows: 5, cols: 5,
        grid: { left: 0, top: 0, right: 100, bottom: 100 }, image_url: null, tiles,
      }
}

/** Every member's crossed squares (approved, plus free) and pending ones. */
async function marksByMember(db: pg.Pool, eventId: number) {
  const { rows } = await db.query(
    `SELECT m.member_id, m.idx, m.status, m.source, mem.member_name
       FROM event_bingo_marks m
       LEFT JOIN members mem ON mem.member_id = m.member_id
      WHERE m.event_id = $1 AND m.status IN ('pending', 'approved')`, [eventId])
  return rows
}

function markView(row: any) {
  return {
    id: Number(row.id),
    idx: Number(row.idx),
    member_id: row.member_id,
    member_name: row.member_name ?? null,
    status: row.status,
    source: row.source,
    proof_text: row.proof_text ?? null,
    has_image: !!row.has_image,
    evidence: row.evidence ?? null,
    created_at: Number(row.created_ms),
    reviewed_by: row.reviewed_by == null ? null : String(row.reviewed_by),
    reviewed_at: row.reviewed_ms == null ? null : Number(row.reviewed_ms),
    review_note: row.review_note ?? null,
  }
}

const MARK_SELECT = `
  SELECT m.id, m.idx, m.member_id, mem.member_name, m.status, m.source, m.proof_text,
         m.proof_image IS NOT NULL AS has_image, m.evidence, m.reviewed_by, m.review_note,
         (extract(epoch FROM m.created_at) * 1000)::bigint AS created_ms,
         (extract(epoch FROM m.reviewed_at) * 1000)::bigint AS reviewed_ms
    FROM event_bingo_marks m
    LEFT JOIN members mem ON mem.member_id = m.member_id`

export function registerBingoRoutes(app: FastifyInstance, db: pg.Pool) {
  const eventExists = async (id: number) =>
    (await db.query('SELECT 1 FROM faction_events WHERE id = $1', [id])).rows.length > 0

  // ── The card ────────────────────────────────────────────────────────────
  /**
   * The card, one member's crosses on it, and (for leadership) the standings
   * and how many requests are waiting. `?member=` lets leadership look at any
   * member's card; everybody else always gets their own.
   */
  app.get('/api/events/:id/bingo', { preHandler: requireAuth() }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    if (!(await eventExists(id))) return reply.status(404).send({ error: 'No such event' })
    const c = await card(db, id)
    if (!c.enabled && !isLead(req)) return reply.status(404).send({ error: 'Bingo is not on for this event' })

    const asked = String((req.query as { member?: string }).member ?? '')
    const who = isLead(req) && /^\d+$/.test(asked) ? asked : me(req)

    const { rows: mine } = await db.query(
      `${MARK_SELECT} WHERE m.event_id = $1 AND m.member_id = $2 ORDER BY m.created_at DESC`, [id, who])

    const free = c.tiles.filter((t) => t.kind === 'free').map((t) => t.idx)
    const all = await marksByMember(db, id)
    const byMember = new Map<string, { name: string | null; crossed: Set<number>; pending: number }>()
    for (const r of all) {
      const e = byMember.get(r.member_id) ?? { name: r.member_name ?? null, crossed: new Set(free), pending: 0 }
      if (r.status === 'approved') e.crossed.add(Number(r.idx))
      else e.pending += 1
      byMember.set(r.member_id, e)
    }
    const standings = [...byMember.entries()]
      .map(([member_id, e]) => ({
        member_id, name: e.name,
        squares: [...e.crossed].filter((i) => !free.includes(i)).length,
        lines: completedLines(c.rows, c.cols, e.crossed),
        pending: e.pending,
      }))
      .filter((s) => s.squares > 0 || s.pending > 0)
      .sort((a, b) => b.lines - a.lines || b.squares - a.squares)

    const name = (await db.query('SELECT member_name FROM members WHERE member_id = $1', [who])).rows[0]?.member_name ?? null
    const pending = isLead(req)
      ? Number((await db.query(
          `SELECT count(*)::int AS n FROM event_bingo_marks WHERE event_id = $1 AND status = 'pending'`, [id],
        )).rows[0].n)
      : null

    return {
      ...c,
      auto_rules: AUTO_RULES,
      member: { member_id: who, name },
      marks: mine.map(markView),
      standings,
      pending_reviews: pending,
    }
  })

  // ⚠️ PUBLIC, like the branding images: an <img> cannot send the bearer
  // token, and card art is decoration, not faction data. Proof screenshots are
  // a different matter and stay behind auth (below).
  app.get('/api/events/:id/bingo/image', async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    const { rows } = await db.query(
      'SELECT image, image_type FROM event_bingo_cards WHERE event_id = $1 AND image IS NOT NULL', [id])
    if (!rows[0]) return reply.status(404).send({ error: 'No card image' })
    reply.header('Content-Type', rows[0].image_type)
    reply.header('Cache-Control', 'public, max-age=86400')
    return reply.send(rows[0].image)
  })

  /** Save the card's shape and squares. Leadership/admin. */
  app.put('/api/events/:id/bingo', LEAD, async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    if (!(await eventExists(id))) return reply.status(404).send({ error: 'No such event' })
    const b = (req.body ?? {}) as Record<string, any>
    const rows = Number(b.rows)
    const cols = Number(b.cols)
    const grid = {
      left: Number(b.grid?.left), top: Number(b.grid?.top),
      right: Number(b.grid?.right), bottom: Number(b.grid?.bottom),
    }
    const tiles: Tile[] = (Array.isArray(b.tiles) ? b.tiles : []).map((t: any) => ({
      idx: Number(t?.idx),
      label: String(t?.label ?? '').trim(),
      kind: t?.kind,
      rule: t?.kind === 'auto' ? String(t?.rule ?? '') : null,
    }))
    const bad = checkCard({ rows, cols, grid, tiles })
    if (bad) return reply.status(400).send({ error: bad })

    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO event_bingo_cards (event_id, enabled, rows, cols, grid_left, grid_top, grid_right, grid_bottom, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
         ON CONFLICT (event_id) DO UPDATE SET enabled = EXCLUDED.enabled, rows = EXCLUDED.rows, cols = EXCLUDED.cols,
           grid_left = EXCLUDED.grid_left, grid_top = EXCLUDED.grid_top, grid_right = EXCLUDED.grid_right,
           grid_bottom = EXCLUDED.grid_bottom, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [id, b.enabled === true, rows, cols, grid.left, grid.top, grid.right, grid.bottom, Number(me(req)) || null])
      await client.query('DELETE FROM event_bingo_tiles WHERE event_id = $1', [id])
      for (const t of tiles) {
        await client.query(
          'INSERT INTO event_bingo_tiles (event_id, idx, label, kind, rule) VALUES ($1, $2, $3, $4, $5)',
          [id, t.idx, t.label, t.kind, t.rule])
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
    return card(db, id)
  })

  /** The starter card from the shared Halloween design. Not saved until Save. */
  app.get('/api/events/:id/bingo/template', LEAD, async () => ({
    rows: HALLOWEEN_TEMPLATE.rows,
    cols: HALLOWEEN_TEMPLATE.cols,
    grid: HALLOWEEN_GRID,
    tiles: HALLOWEEN_TEMPLATE.tiles.map((t, idx) => ({ ...t, idx })),
  }))

  app.put('/api/events/:id/bingo/image', { ...LEAD, bodyLimit: 7_500_000 }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    if (!(await eventExists(id))) return reply.status(404).send({ error: 'No such event' })
    const body = (req.body ?? {}) as { content_type?: unknown; data_base64?: unknown }
    if (typeof body.content_type !== 'string' || !IMAGE_TYPES.includes(body.content_type)) {
      return reply.status(400).send({ error: 'The card image must be PNG, JPEG, WebP or GIF.' })
    }
    if (typeof body.data_base64 !== 'string' || !body.data_base64.trim()) {
      return reply.status(400).send({ error: 'No image was sent.' })
    }
    const bytes = decodeBase64(body.data_base64)
    if (bytes.length === 0) return reply.status(400).send({ error: 'The image is empty.' })
    if (bytes.length > CARD_IMAGE_MAX) return reply.status(413).send({ error: 'The card image must be 5 MB or smaller.' })
    await db.query(
      `INSERT INTO event_bingo_cards (event_id, image, image_type, image_updated_at, updated_by)
       VALUES ($1, $2, $3, now(), $4)
       ON CONFLICT (event_id) DO UPDATE SET image = EXCLUDED.image, image_type = EXCLUDED.image_type,
         image_updated_at = now(), updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [id, bytes, body.content_type, Number(me(req)) || null])
    return card(db, id)
  })

  app.delete('/api/events/:id/bingo/image', LEAD, async (req) => {
    const id = Number((req.params as { id: string }).id)
    await db.query(
      `UPDATE event_bingo_cards SET image = NULL, image_type = NULL, image_updated_at = now(), updated_at = now()
        WHERE event_id = $1`, [id])
    return card(db, id)
  })

  // ── Marks ───────────────────────────────────────────────────────────────
  /**
   * Ask for a square with proof — or, for leadership naming a member, cross it
   * for them outright (`source: council`).
   */
  app.post('/api/events/:id/bingo/marks', { preHandler: requireAuth(), bodyLimit: 4_500_000 }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    const c = await card(db, id)
    if (!c.enabled && !isLead(req)) return reply.status(404).send({ error: 'Bingo is not on for this event' })
    const b = (req.body ?? {}) as Record<string, any>
    const idx = Number(b.idx)
    const tile = c.tiles.find((t) => t.idx === idx)
    if (!tile) return reply.status(400).send({ error: 'No such square.' })
    if (tile.kind === 'free') return reply.status(400).send({ error: 'The free square is already crossed.' })

    const forOther = b.member_id != null && String(b.member_id) !== me(req)
    if (forOther && !isLead(req)) return reply.status(403).send({ error: 'Only leadership can cross a square for someone else.' })
    const member = forOther ? String(b.member_id) : me(req)
    if (!/^\d+$/.test(member)) return reply.status(400).send({ error: 'Which member?' })
    const council = forOther || (isLead(req) && b.council === true)

    const text = typeof b.proof_text === 'string' ? b.proof_text.trim().slice(0, PROOF_TEXT_MAX) : ''
    let image: Buffer | null = null
    let imageType: string | null = null
    if (b.proof_image_base64) {
      if (typeof b.proof_image_type !== 'string' || !IMAGE_TYPES.includes(b.proof_image_type)) {
        return reply.status(400).send({ error: 'Screenshots must be PNG, JPEG, WebP or GIF.' })
      }
      image = decodeBase64(String(b.proof_image_base64))
      imageType = b.proof_image_type
      if (image.length > PROOF_IMAGE_MAX) return reply.status(413).send({ error: 'Screenshots must be 3 MB or smaller.' })
    }
    if (!council && !text && !image) {
      return reply.status(400).send({ error: 'Add some proof: paste a log snippet or attach a screenshot.' })
    }

    try {
      const { rows } = await db.query(
        `INSERT INTO event_bingo_marks (event_id, idx, member_id, status, source, proof_text, proof_image, proof_image_type,
                                        reviewed_by, reviewed_at)
         VALUES ($1, $2, $3, $4, $5, nullif($6, ''), $7, $8, $9, CASE WHEN $4 = 'approved' THEN now() END)
         RETURNING id`,
        [id, idx, member, council ? 'approved' : 'pending', council ? 'council' : 'proof',
         text, image, imageType, council ? Number(me(req)) || null : null])
      const { rows: [row] } = await db.query(`${MARK_SELECT} WHERE m.id = $1`, [rows[0].id])
      return reply.status(201).send(markView(row))
    } catch (err) {
      if ((err as { constraint?: string })?.constraint === 'event_bingo_marks_live') {
        return reply.status(409).send({ error: 'That square is already crossed or waiting for review.' })
      }
      throw err
    }
  })

  /** Withdraw your own request while it is still waiting. */
  app.delete('/api/events/:id/bingo/marks/:markId', { preHandler: requireAuth() }, async (req, reply) => {
    const p = req.params as { id: string; markId: string }
    const { rowCount } = await db.query(
      `DELETE FROM event_bingo_marks
        WHERE id = $1 AND event_id = $2 AND status = 'pending' AND (member_id = $3 OR $4)`,
      [Number(p.markId), Number(p.id), me(req), isLead(req)])
    if (!rowCount) return reply.status(404).send({ error: 'Nothing waiting to withdraw.' })
    return { ok: true }
  })

  /** The review queue: waiting requests first, then recent decisions. */
  app.get('/api/events/:id/bingo/reviews', LEAD, async (req) => {
    const id = Number((req.params as { id: string }).id)
    const { rows } = await db.query(
      `${MARK_SELECT}
        WHERE m.event_id = $1 AND (m.status = 'pending' OR (m.source = 'proof' AND m.reviewed_at > now() - interval '7 days'))
        ORDER BY (m.status = 'pending') DESC, m.created_at`, [id])
    return { marks: rows.map(markView) }
  })

  app.patch('/api/events/:id/bingo/marks/:markId', LEAD, async (req, reply) => {
    const p = req.params as { id: string; markId: string }
    const b = (req.body ?? {}) as { decision?: unknown; note?: unknown }
    if (b.decision !== 'approved' && b.decision !== 'rejected') {
      return reply.status(400).send({ error: 'decision must be approved or rejected' })
    }
    const note = typeof b.note === 'string' ? b.note.trim().slice(0, 500) : ''
    // ⚠️ Only a waiting request is decided, and only once. Un-crossing an
    // approved square is a separate, deliberate act (DELETE below).
    const { rows } = await db.query(
      `UPDATE event_bingo_marks
          SET status = $3, reviewed_by = $4, reviewed_at = now(), review_note = nullif($5, '')
        WHERE id = $1 AND event_id = $2 AND status = 'pending'
        RETURNING id`,
      [Number(p.markId), Number(p.id), b.decision, Number(me(req)) || null, note])
    if (!rows[0]) return reply.status(409).send({ error: 'That request has already been decided.' })
    const { rows: [row] } = await db.query(`${MARK_SELECT} WHERE m.id = $1`, [rows[0].id])
    return markView(row)
  })

  /** Un-cross a square (a mistake, or proof found wanting later). Leadership. */
  app.post('/api/events/:id/bingo/marks/:markId/revoke', LEAD, async (req, reply) => {
    const p = req.params as { id: string; markId: string }
    const note = String(((req.body ?? {}) as { note?: unknown }).note ?? '').trim().slice(0, 500)
    const { rows } = await db.query(
      `UPDATE event_bingo_marks
          SET status = 'rejected', reviewed_by = $3, reviewed_at = now(), review_note = nullif($4, '')
        WHERE id = $1 AND event_id = $2 AND status = 'approved'
        RETURNING id`,
      [Number(p.markId), Number(p.id), Number(me(req)) || null, note || 'Un-crossed by leadership'])
    if (!rows[0]) return reply.status(404).send({ error: 'That square is not crossed.' })
    return { ok: true }
  })

  /** A proof screenshot: the member who sent it, or leadership. */
  app.get('/api/events/:id/bingo/marks/:markId/image', { preHandler: requireAuth() }, async (req, reply) => {
    const p = req.params as { id: string; markId: string }
    const { rows } = await db.query(
      `SELECT proof_image, proof_image_type, member_id FROM event_bingo_marks
        WHERE id = $1 AND event_id = $2 AND proof_image IS NOT NULL`, [Number(p.markId), Number(p.id)])
    const row = rows[0]
    if (!row || (row.member_id !== me(req) && !isLead(req))) return reply.status(404).send({ error: 'Not found' })
    reply.header('Content-Type', row.proof_image_type)
    reply.header('Cache-Control', 'private, max-age=3600')
    return reply.send(row.proof_image)
  })
}
