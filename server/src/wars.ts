// Ranked-war read surface: war history, per-war contributions, windowed
// attack pages, revives, and saved war-payout history. Reads only — war
// syncing/saving arrive with the war-room slices.
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { requireAuth, requireNotVisitor, requireRole } from './authz.js'

// Columns the client may set on war_payouts — everything else is
// server-stamped (created_by, created_at, updated_at) or defaulted.
const WAR_PAYOUT_COLUMNS = new Set([
  'war_id', 'war_type', 'faction_cut_percent', 'total_reward', 'total_payout',
  'member_count', 'min_score_threshold', 'flat_payout_amount', 'score_multiplier',
  'attacks_weight', 'effort_weight', 'assist_multiplier', 'min_payout_threshold',
  'notes', 'merc_cost', 'reviver_cost', 'faction_top_up', 'termed_mode',
  'race_target_score', 'race_cutoff_mode', 'race_cutoff_timestamp',
  'race_post_cutoff_mode', 'race_pre_cutoff_percent',
  'war_hit_multiplier', 'loss_multiplier', 'mug_multiplier',
  'regular_hit_multiplier', 'participation_weight',
  'price_melee_cache', 'price_armor_cache', 'price_small_arms_cache',
  'price_medium_arms_cache', 'price_heavy_arms_cache',
  'post_war_hit_multiplier', 'post_assist_multiplier', 'post_loss_multiplier',
  'post_mug_multiplier', 'post_regular_hit_multiplier', 'post_participation_weight',
  'post_dist_mode', 'post_flat_threshold', 'post_scale_enabled', 'post_scale_hours',
])
const WAR_PAYOUT_MEMBER_COLUMNS = new Set([
  'member_id', 'member_name', 'score', 'attacks', 'assist_attacks',
  'payout_amount', 'is_eligible', 'multiplier_overrides', 'war_hits',
  'regular_hits', 'mugs', 'losses', 'race_breakdown',
])

function pick(obj: Record<string, unknown>, allowed: Set<string>) {
  return Object.fromEntries(
    Object.entries(obj)
      .filter(([k, v]) => allowed.has(k))
      // node-pg can't tell json columns from plain objects.
      .map(([k, v]) => [k, v !== null && typeof v === 'object' ? JSON.stringify(v) : v])
  )
}

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

  /**
   * A war's revives — resolved by TIME WINDOW, not by the stored rw_id (#358).
   *
   * This used to filter on `rw_id = $1`, which was correct while the only
   * writer was the per-war backfill: it fetched one war's window and stamped
   * every row with that war. The standing revives feed changed that. It tags a
   * row from whatever wars `ranked_wars` knows about AT INGEST TIME, and
   * wars-sync only runs every three hours — so revives landing in the first
   * hours of a new war are written with a null tag, and nothing ever goes back
   * to fill it in. Those revives would simply be missing from the war page.
   *
   * The window is the authoritative answer anyway: a revive belongs to a war if
   * it happened during it. The rw_id clause is kept as a union so a war whose
   * recorded window later shifts can't drop rows the backfill had already
   * attributed to it.
   */
  app.get('/api/wars/:id/revives', { preHandler: requireAuth() }, async (req) => {
    const { id } = req.params as { id: string }
    const res = await db.query(
      `SELECT r.* FROM faction_revives r
         LEFT JOIN ranked_wars w ON w.id = $1
        WHERE r.rw_id = $1
           OR (w.start_at IS NOT NULL
               AND r."timestamp" >= w.start_at
               AND r."timestamp" <= COALESCE(w.end_at, extract(epoch FROM now())::bigint))
        ORDER BY r."timestamp" ASC`,
      [id]
    )
    return { revives: res.rows }
  })

  // Saved payout history. Nested member rows use the same key the PostgREST
  // embed produced (war_payout_members) so view code is unchanged.
  //
  // The war columns are joined in rather than denormalised onto war_payouts:
  // the payout is a snapshot of a CALCULATION, while who we fought and when is
  // a fact about the war. A LEFT JOIN keeps a payout listable even if its war
  // row is missing — the history should never lose a row over a display field.
  const PAYOUTS_WITH_MEMBERS = `
    SELECT wp.*,
           rw.opponent_name AS war_opponent_name,
           rw.opponent_id   AS war_opponent_id,
           rw.start_at      AS war_start_at,
           rw.end_at        AS war_end_at,
           COALESCE((
             SELECT jsonb_agg(to_jsonb(wpm) ORDER BY wpm.payout_amount DESC)
             FROM war_payout_members wpm WHERE wpm.payout_id = wp.id
           ), '[]'::jsonb) AS war_payout_members
    FROM war_payouts wp
    LEFT JOIN ranked_wars rw ON rw.id = wp.war_id`

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

  // Delete a saved RW payout: remove its member rows, then the payout. The
  // self-hosted replacement for the old DataManagement single-delete tool.
  app.delete('/api/war-payouts/:id', { preHandler: [requireNotVisitor(), requireRole('leadership', 'admin')] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!/^\d+$/.test(id)) return reply.status(400).send({ error: 'valid payout id required' })
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const existing = await client.query('SELECT id FROM war_payouts WHERE id = $1', [id])
      if (existing.rows.length === 0) {
        await client.query('ROLLBACK')
        return reply.status(404).send({ error: 'War payout not found' })
      }
      await client.query('DELETE FROM war_payout_members WHERE payout_id = $1', [id])
      await client.query('DELETE FROM war_payouts WHERE id = $1', [id])
      await client.query('COMMIT')
      return { ok: true, deleted_payout_id: Number(id) }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })

  // Save a computed war payout: overwrite the war's latest payout (or create
  // the first), replacing its member rows — the same semantics the admin-db
  // edge function had. Visitors get the explicit read-only message; everyone
  // else needs leadership/admin.
  app.post('/api/war-payouts', { preHandler: [requireNotVisitor(), requireRole('leadership', 'admin')] }, async (req, reply) => {
    const body = req.body as { payout?: Record<string, unknown>; members?: Record<string, unknown>[] } | null
    if (!body?.payout || !Array.isArray(body.members) || body.members.length === 0) {
      return reply.status(400).send({ error: 'payout and members are required' })
    }
    const payout = pick(body.payout, WAR_PAYOUT_COLUMNS)
    if (!payout.war_id || !payout.war_type) {
      return reply.status(400).send({ error: 'payout.war_id and payout.war_type are required' })
    }
    const memberRows = body.members.map((m) => pick(m, WAR_PAYOUT_MEMBER_COLUMNS))
    if (memberRows.some((m) => m.member_id == null)) {
      return reply.status(400).send({ error: 'each member requires member_id' })
    }
    const createdBy = req.session!.torn_user_id

    const client = await db.connect()
    try {
      await client.query('BEGIN')

      // Overwrite the latest payout for this war (a war keeps at most the
      // history it already had; re-saves don't stack new rows).
      const existing = await client.query(
        'SELECT id FROM war_payouts WHERE war_id = $1 ORDER BY created_at DESC LIMIT 1',
        [payout.war_id]
      )

      const cols = Object.keys(payout)
      let payoutId: number
      if (existing.rows.length > 0) {
        payoutId = existing.rows[0].id
        const sets = cols.map((c, i) => `"${c}" = $${i + 1}`).join(', ')
        await client.query(
          `UPDATE war_payouts SET ${sets}, created_by = $${cols.length + 1}, updated_at = now()
           WHERE id = $${cols.length + 2}`,
          [...cols.map((c) => payout[c]), createdBy, payoutId]
        )
        await client.query('DELETE FROM war_payout_members WHERE payout_id = $1', [payoutId])
      } else {
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ')
        const inserted = await client.query(
          `INSERT INTO war_payouts (${cols.map((c) => `"${c}"`).join(', ')}, created_by, created_at, updated_at)
           VALUES (${placeholders}, $${cols.length + 1}, now(), now())
           RETURNING id`,
          [...cols.map((c) => payout[c]), createdBy]
        )
        payoutId = inserted.rows[0].id
      }

      for (const m of memberRows) {
        const mCols = ['payout_id', ...Object.keys(m)]
        await client.query(
          `INSERT INTO war_payout_members (${mCols.map((c) => `"${c}"`).join(', ')})
           VALUES (${mCols.map((_, i) => `$${i + 1}`).join(', ')})`,
          [payoutId, ...Object.keys(m).map((c) => m[c])]
        )
      }

      await client.query('COMMIT')
      return { payout_id: payoutId, member_count: memberRows.length }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })

  // Toggle a war's Real/Termed classification (mirrors the calculator's
  // war-class picker; only is_termed changes).
  app.post('/api/wars/:id/is-termed', { preHandler: [requireNotVisitor(), requireRole('leadership', 'admin')] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const isTermed = (req.body as { is_termed?: unknown } | null)?.is_termed
    if (typeof isTermed !== 'boolean') {
      return reply.status(400).send({ error: 'is_termed (boolean) is required' })
    }
    const res = await db.query(
      'UPDATE ranked_wars SET is_termed = $1, updated_at = now() WHERE id = $2 RETURNING id',
      [isTermed, id]
    )
    if (res.rows.length === 0) return reply.status(404).send({ error: 'War not found' })
    return { war_id: res.rows[0].id, is_termed: isTermed }
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
