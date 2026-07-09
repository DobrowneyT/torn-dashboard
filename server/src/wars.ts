// Ranked-war read surface: war history, per-war contributions, windowed
// attack pages, revives, and saved war-payout history. Reads only — war
// syncing/saving arrive with the war-room slices.
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { requireAuth } from './authz.js'

export function registerWarRoutes(app: FastifyInstance, db: pg.Pool) {
  app.get('/api/wars', { preHandler: requireAuth() }, async (req) => {
    const q = req.query as { limit?: string; offset?: string }
    const limit = clamp(q.limit, 5, 100)
    const offset = Math.max(0, Number(q.offset) || 0)
    const [wars, total] = await Promise.all([
      db.query('SELECT * FROM ranked_wars ORDER BY start_at DESC LIMIT $1 OFFSET $2', [limit, offset]),
      db.query('SELECT count(*) AS n FROM ranked_wars'),
    ])
    return { wars: wars.rows, total: total.rows[0].n }
  })

  app.get('/api/wars/:id', { preHandler: requireAuth() }, async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!/^\d+$/.test(id)) return reply.status(404).send({ error: 'War not found' })
    const res = await db.query('SELECT * FROM ranked_wars WHERE id = $1', [id])
    if (res.rows.length === 0) return reply.status(404).send({ error: 'War not found' })
    return { war: res.rows[0] }
  })

  app.get('/api/wars/:id/contributions', { preHandler: requireAuth() }, async (req) => {
    const { id } = req.params as { id: string }
    const res = await db.query(
      'SELECT * FROM war_member_contributions WHERE war_id = $1 ORDER BY score DESC',
      [id]
    )
    return { contributions: res.rows }
  })

  app.get('/api/wars/:id/revives', { preHandler: requireAuth() }, async (req) => {
    const { id } = req.params as { id: string }
    const res = await db.query(
      'SELECT * FROM faction_revives WHERE rw_id = $1 ORDER BY "timestamp" ASC',
      [id]
    )
    return { revives: res.rows }
  })

  // Saved payout history. Nested member rows use the same key the PostgREST
  // embed produced (war_payout_members) so view code is unchanged.
  const PAYOUTS_WITH_MEMBERS = `
    SELECT wp.*,
           COALESCE((
             SELECT jsonb_agg(to_jsonb(wpm) ORDER BY wpm.payout_amount DESC)
             FROM war_payout_members wpm WHERE wpm.payout_id = wp.id
           ), '[]'::jsonb) AS war_payout_members
    FROM war_payouts wp`

  app.get('/api/wars/:id/payouts', { preHandler: requireAuth() }, async (req) => {
    const { id } = req.params as { id: string }
    const res = await db.query(
      `${PAYOUTS_WITH_MEMBERS} WHERE wp.war_id = $1 ORDER BY wp.created_at DESC`,
      [id]
    )
    return { payouts: res.rows }
  })

  app.get('/api/war-payouts', { preHandler: requireAuth() }, async (req) => {
    const limit = clamp((req.query as { limit?: string }).limit, 20, 100)
    const res = await db.query(
      `${PAYOUTS_WITH_MEMBERS} ORDER BY wp.created_at DESC LIMIT $1`,
      [limit]
    )
    return { payouts: res.rows }
  })

  app.get('/api/war-payouts/:id/members', { preHandler: requireAuth() }, async (req) => {
    const { id } = req.params as { id: string }
    const res = await db.query(
      'SELECT * FROM war_payout_members WHERE payout_id = $1 ORDER BY payout_amount DESC',
      [id]
    )
    return { members: res.rows }
  })

  // Faction id → name/tag lookup for opponent labels.
  app.get('/api/factions', { preHandler: requireAuth() }, async (req, reply) => {
    const raw = (req.query as { ids?: string }).ids ?? ''
    const ids = raw.split(',').map((s) => s.trim()).filter((s) => /^\d+$/.test(s))
    if (ids.length === 0) return reply.status(400).send({ error: 'ids (comma-separated faction ids) is required' })
    const res = await db.query(
      'SELECT id, name, tag FROM factions WHERE id = ANY($1::int[]) ORDER BY id',
      [ids]
    )
    return { factions: res.rows }
  })

  // Windowed attack pages for war analytics/payouts. faction_attacks is the
  // largest table — always paginated, never a full-table pull.
  app.get('/api/attacks', { preHandler: requireAuth() }, async (req, reply) => {
    const q = req.query as { from?: string; to?: string; limit?: string; offset?: string }
    const from = Number(q.from)
    if (!q.from || !Number.isFinite(from)) {
      return reply.status(400).send({ error: 'from (unix seconds) is required' })
    }
    const to = Number(q.to)
    const limit = clamp(q.limit, 500, 1000)
    const offset = Math.max(0, Number(q.offset) || 0)

    // to <= 0 or missing = ongoing war, open-ended window.
    const bounded = Number.isFinite(to) && to > 0
    const where = bounded ? 'started >= $1 AND started <= $2' : 'started >= $1'
    const params: unknown[] = bounded ? [from, to] : [from]
    const [attacks, total] = await Promise.all([
      db.query(
        `SELECT * FROM faction_attacks WHERE ${where}
         ORDER BY started DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
      db.query(`SELECT count(*) AS n FROM faction_attacks WHERE ${where}`, params),
    ])
    return { attacks: attacks.rows, total: total.rows[0].n }
  })
}

function clamp(raw: string | undefined, fallback: number, max: number): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) return fallback
  return Math.min(n, max)
}
