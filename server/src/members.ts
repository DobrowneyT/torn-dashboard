// Read endpoints backing the Members and Dashboard views. All queries join
// server-side; responses use snake_case DB names under a resource key.
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { requireAuth, requireRole } from './authz.js'

export function registerMemberRoutes(app: FastifyInstance, db: pg.Pool) {
  app.get('/api/members', { preHandler: requireAuth() }, async () => {
    const res = await db.query(`
      SELECT m.member_id, m.member_name, m.tier, m.tier_override, m.last_scraped,
             m.total_days_in_faction,
             -- Streak: whole days since the current (open) faction stint began (#287).
             (SELECT floor(extract(epoch FROM (now() - s.joined_at)) / 86400)::int
              FROM member_faction_stints s
              WHERE s.member_id = m.member_id AND s.left_at IS NULL
              ORDER BY s.joined_at DESC LIMIT 1) AS streak_days,
             COALESCE(avg(c.cpr_value), 0)::float8 AS avg_cpr,
             count(c.cpr_value)::int AS role_count
      FROM members m
      LEFT JOIN member_cpr_v2 c ON c.member_id = m.member_id
      WHERE m.is_current = true
      GROUP BY m.member_id
      ORDER BY m.member_id
    `)
    return { members: res.rows }
  })

  app.get('/api/members/:id', { preHandler: requireAuth() }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const member = await db.query('SELECT * FROM members WHERE member_id = $1', [id])
    if (member.rows.length === 0) return reply.status(404).send({ error: 'Member not found' })
    const cpr = await db.query(
      `SELECT crime_name, difficulty, position_label, cpr_value, observation_count
       FROM member_cpr_v2 WHERE member_id = $1
       ORDER BY crime_name, position_label`,
      [id]
    )
    return { member: member.rows[0], cpr: cpr.rows }
  })

  app.get('/api/members/:id/cpr', { preHandler: requireAuth() }, async (req) => {
    const { id } = req.params as { id: string }
    const res = await db.query(
      `SELECT crime_name, difficulty, position_label, cpr_value, observation_count
       FROM member_cpr_v2 WHERE member_id = $1
       ORDER BY crime_name, position_label`,
      [id]
    )
    return { cpr: res.rows }
  })

  app.get('/api/members/:id/daily-stats', { preHandler: requireAuth() }, async (req) => {
    const { id } = req.params as { id: string }
    const limit = clampLimit((req.query as { limit?: string }).limit, 31, 366)
    const res = await db.query(
      `SELECT snapshot_date, personalstats, api_version, gym_strength, gym_speed,
              gym_dexterity, gym_defense, gym_energy
       FROM member_daily_stats WHERE member_id = $1
       ORDER BY snapshot_date DESC LIMIT $2`,
      [id, limit]
    )
    return { daily_stats: res.rows }
  })

  app.get('/api/members/:id/crimes', { preHandler: requireAuth() }, async (req) => {
    const { id } = req.params as { id: string }
    const limit = clampLimit((req.query as { limit?: string }).limit, 500, 1000)
    const res = await db.query(
      `SELECT c.*,
              s."position"             AS member_position,
              s.joined_at              AS member_joined_at,
              s.checkpoint_pass_rate   AS member_cpr,
              s.user_outcome           AS member_outcome
       FROM crime_slots s
       JOIN crimes c ON c.crime_id = s.crime_id
       WHERE s.user_id = $1
       ORDER BY c.executed_at DESC NULLS LAST
       LIMIT $2`,
      [id, limit]
    )
    return { crimes: res.rows }
  })

  app.get('/api/members/:id/payouts', { preHandler: requireAuth() }, async (req) => {
    const { id } = req.params as { id: string }
    const res = await db.query(
      `SELECT pm.*,
              CASE WHEN w.id IS NULL THEN NULL ELSE jsonb_build_object(
                'week_start', w.week_start,
                'week_end', w.week_end,
                'member_payout_total', w.member_payout_total,
                'crimes_processed', w.crimes_processed
              ) END AS oc_payout_weeks
       FROM oc_payout_members pm
       LEFT JOIN oc_payout_weeks w ON w.id = pm.week_id
       WHERE pm.member_id = $1
       ORDER BY pm.week_end DESC`,
      [id]
    )
    return { payouts: res.rows }
  })

  app.get('/api/members/:id/wars', { preHandler: requireAuth() }, async (req) => {
    const { id } = req.params as { id: string }
    const res = await db.query(
      `SELECT w.*, wc.score AS my_score, wc.attacks AS my_attacks,
              (w.winner_faction_id IS NOT NULL AND
               w.winner_faction_id = (SELECT torn_faction_id FROM faction_config)) AS we_won
       FROM war_member_contributions wc
       JOIN ranked_wars w ON w.id = wc.war_id
       WHERE wc.member_id = $1
         AND wc.faction_id = (SELECT torn_faction_id FROM faction_config)
       ORDER BY w.start_at DESC
       LIMIT 100`,
      [id]
    )
    return { wars: res.rows }
  })

  app.get('/api/members/:id/war-payouts', { preHandler: requireAuth() }, async (req) => {
    const { id } = req.params as { id: string }
    // Max covers a member's full war history (the RW payouts page sums it).
    const limit = clampLimit((req.query as { limit?: string }).limit, 5, 500)
    const res = await db.query(
      `SELECT wpm.payout_id, wpm.payout_amount,
              to_jsonb(wp) || jsonb_build_object(
                'ranked_wars', CASE WHEN rw.id IS NULL THEN NULL ELSE jsonb_build_object(
                  'start_at', rw.start_at,
                  'end_at', rw.end_at,
                  'opponent_name', rw.opponent_name,
                  'opponent_id', rw.opponent_id,
                  'winner_faction_id', rw.winner_faction_id,
                  'our_score', rw.our_score,
                  'opponent_score', rw.opponent_score
                ) END
              ) AS war_payouts
       FROM war_payout_members wpm
       JOIN war_payouts wp ON wp.id = wpm.payout_id
       LEFT JOIN ranked_wars rw ON rw.id = wp.war_id
       WHERE wpm.member_id = $1
       ORDER BY wpm.payout_id DESC
       LIMIT $2`,
      [id, limit]
    )
    return { war_payouts: res.rows }
  })

  app.get('/api/inventory/loaned', { preHandler: requireAuth() }, async () => {
    const res = await db.query(
      `SELECT * FROM inventory_items_with_prices WHERE loaned > 0`
    )
    return { items: res.rows }
  })

  /**
   * Our own members' battle stats (#348). WAR LEADS / LEADERSHIP / ADMIN ONLY.
   *
   * Battle stats decide who can hit whom, so this is the most sensitive number
   * we hold about a member. It lives in its own table precisely so it can have
   * its own guard — folding it into /api/members would have exposed it to
   * every authenticated caller, since that route is read by every view.
   *
   * `source` rides along so the UI can distinguish a member's own exact figure
   * from a TornStats spy or a BSP estimate.
   */
  app.get(
    '/api/members/battle-stats',
    { preHandler: requireRole('warlead', 'leadership', 'admin') },
    async () => {
      const res = await db.query(`
        SELECT b.member_id, m.member_name,
               b.strength, b.defense, b.speed, b.dexterity, b.total,
               b.source, b.fetched_at, b.spy_at
          FROM member_battle_stats b
          JOIN members m ON m.member_id = b.member_id
         WHERE m.is_current = true
         ORDER BY b.total DESC NULLS LAST
      `)
      return { battle_stats: res.rows }
    }
  )
}

function clampLimit(raw: string | undefined, fallback: number, max: number): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) return fallback
  return Math.min(n, max)
}
