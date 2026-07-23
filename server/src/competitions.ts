// Competitions API (#183). A competition names a metric (from the code
// registry) and a fixed date window; the leaderboard is computed on read from
// member_daily_stats.personalstats deltas — value at the last in-window
// snapshot minus the first, per current member. A member whose first in-window
// snapshot lands after the window opened is flagged `partial` (their baseline
// isn't the opening day), so the comparison stays honest. Reads are open to any
// session; creating is leadership/admin and blocked for visitors.
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { requireAuth, requireNotVisitor, requireRole } from './authz.js'
import { getMetric, metricOptions } from './competitions/metrics.js'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const NAME_MAX = 120

export function registerCompetitionRoutes(app: FastifyInstance, db: pg.Pool) {
  // Registry shortlist for the create form (no internal paths exposed).
  app.get('/api/competitions/metrics', { preHandler: requireAuth() }, async () => {
    return { metrics: metricOptions() }
  })

  app.get('/api/competitions', { preHandler: requireAuth() }, async () => {
    const res = await db.query(
      `SELECT id, name, type, metric_id, direction, window_start, window_end,
              created_by, created_at
       FROM competitions ORDER BY window_end DESC, id DESC`
    )
    return { competitions: res.rows }
  })

  app.get('/api/competitions/:id', { preHandler: requireAuth() }, async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!/^\d+$/.test(id)) return reply.status(404).send({ error: 'Competition not found' })
    const res = await db.query(
      `SELECT id, name, type, metric_id, direction, window_start, window_end,
              created_by, created_at
       FROM competitions WHERE id = $1`,
      [id]
    )
    if (res.rows.length === 0) return reply.status(404).send({ error: 'Competition not found' })
    const competition = res.rows[0]
    const standings = await computeStandings(db, competition)
    return { competition, standings }
  })

  app.post(
    '/api/competitions',
    { preHandler: [requireNotVisitor(), requireRole('leadership', 'admin')] },
    async (req, reply) => {
      const body = (req.body ?? {}) as {
        name?: unknown; metric_id?: unknown; direction?: unknown
        window_start?: unknown; window_end?: unknown; type?: unknown
      }

      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (!name || name.length > NAME_MAX) {
        return reply.status(400).send({ error: `name is required (max ${NAME_MAX} chars)` })
      }
      if (typeof body.metric_id !== 'string' || !getMetric(body.metric_id)) {
        return reply.status(400).send({ error: 'metric_id must be a known competition metric' })
      }
      // Only leaderboard exists in this slice; lottery lands with #187.
      const type = body.type == null ? 'leaderboard' : body.type
      if (type !== 'leaderboard') {
        return reply.status(400).send({ error: 'type must be "leaderboard"' })
      }
      const direction = body.direction == null ? 'desc' : body.direction
      if (direction !== 'asc' && direction !== 'desc') {
        return reply.status(400).send({ error: 'direction must be "asc" or "desc"' })
      }
      if (typeof body.window_start !== 'string' || !DATE_RE.test(body.window_start) ||
          typeof body.window_end !== 'string' || !DATE_RE.test(body.window_end)) {
        return reply.status(400).send({ error: 'window_start and window_end must be YYYY-MM-DD dates' })
      }
      if (body.window_end < body.window_start) {
        return reply.status(400).send({ error: 'window_end must be on or after window_start' })
      }

      const createdBy = req.session!.torn_user_id
      const inserted = await db.query(
        `INSERT INTO competitions (name, type, metric_id, direction, window_start, window_end, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, name, type, metric_id, direction, window_start, window_end, created_by, created_at`,
        [name, type, body.metric_id, direction, body.window_start, body.window_end, String(createdBy)]
      )
      return reply.status(201).send({ competition: inserted.rows[0] })
    }
  )
}

interface CompetitionRow {
  metric_id: string
  direction: string
  window_start: string | Date
  window_end: string | Date
}

// Per-current-member delta of the metric over the window. Rows without a
// numeric value at the metric's path are skipped (never miscounted). `partial`
// marks members whose first in-window snapshot is after the window opened.
export async function computeStandings(db: pg.Pool, competition: CompetitionRow) {
  const metric = getMetric(competition.metric_id)
  if (!metric) return []
  const order = competition.direction === 'asc' ? 'ASC' : 'DESC'

  const res = await db.query(
    `WITH in_window AS (
       SELECT s.member_id, s.snapshot_date,
              (s.personalstats #>> $3::text[])::numeric AS val
       FROM member_daily_stats s
       WHERE s.snapshot_date BETWEEN $1 AND $2
         AND (s.personalstats #>> $3::text[]) ~ '^-?[0-9]+(\\.[0-9]+)?$'
     ),
     bounds AS (
       SELECT member_id,
              min(snapshot_date) AS start_date,
              max(snapshot_date) AS end_date,
              (array_agg(val ORDER BY snapshot_date ASC))[1]  AS start_val,
              (array_agg(val ORDER BY snapshot_date DESC))[1] AS end_val
       FROM in_window
       GROUP BY member_id
     )
     SELECT b.member_id, m.member_name,
            (b.end_val - b.start_val)::float8 AS value,
            b.start_date, b.end_date,
            (b.start_date > $1) AS partial
     FROM bounds b
     JOIN members m ON m.member_id = b.member_id AND m.is_current = true
     ORDER BY value ${order}, m.member_name`,
    [competition.window_start, competition.window_end, metric.path]
  )
  return res.rows.map((r, i) => ({
    rank: i + 1,
    member_id: r.member_id,
    member_name: r.member_name,
    value: r.value,
    partial: r.partial,
    start_date: r.start_date,
    end_date: r.end_date,
  }))
}
