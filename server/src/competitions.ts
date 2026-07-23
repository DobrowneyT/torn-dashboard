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
const ROLLING_DAYS_MAX = 366

const SELECT_COLS =
  `id, name, type, metric_id, direction, reducer, window_kind,
   window_start, window_end, rolling_days, auto_resolve, resolve_interval_days,
   next_resolve_at, created_by, created_at`

export function registerCompetitionRoutes(app: FastifyInstance, db: pg.Pool) {
  // Registry shortlist for the create form (no internal paths exposed).
  app.get('/api/competitions/metrics', { preHandler: requireAuth() }, async () => {
    return { metrics: metricOptions() }
  })

  app.get('/api/competitions', { preHandler: requireAuth() }, async () => {
    const res = await db.query(
      `SELECT ${SELECT_COLS} FROM competitions
       ORDER BY COALESCE(window_end, CURRENT_DATE) DESC, id DESC`
    )
    return { competitions: res.rows }
  })

  app.get('/api/competitions/:id', { preHandler: requireAuth() }, async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!/^\d+$/.test(id)) return reply.status(404).send({ error: 'Competition not found' })
    const res = await db.query(
      `SELECT ${SELECT_COLS} FROM competitions WHERE id = $1`,
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
        name?: unknown; metric_id?: unknown; direction?: unknown; reducer?: unknown
        window_kind?: unknown; window_start?: unknown; window_end?: unknown
        rolling_days?: unknown; type?: unknown
        auto_resolve?: unknown; resolve_interval_days?: unknown
      }

      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (!name || name.length > NAME_MAX) {
        return reply.status(400).send({ error: `name is required (max ${NAME_MAX} chars)` })
      }
      const metric = typeof body.metric_id === 'string' ? getMetric(body.metric_id) : undefined
      if (!metric) {
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
      const reducer = body.reducer == null ? 'total' : body.reducer
      if (typeof reducer !== 'string' || !metric.reducers.includes(reducer as never)) {
        return reply.status(400).send({ error: `reducer must be one of: ${metric.reducers.join(', ')}` })
      }

      // Fixed → explicit dates; rolling → a trailing day count (dates are null
      // and the effective window is computed at read time).
      const windowKind = body.window_kind == null ? 'fixed' : body.window_kind
      let windowStart: string | null = null
      let windowEnd: string | null = null
      let rollingDays: number | null = null
      if (windowKind === 'fixed') {
        if (typeof body.window_start !== 'string' || !DATE_RE.test(body.window_start) ||
            typeof body.window_end !== 'string' || !DATE_RE.test(body.window_end)) {
          return reply.status(400).send({ error: 'window_start and window_end must be YYYY-MM-DD dates' })
        }
        if (body.window_end < body.window_start) {
          return reply.status(400).send({ error: 'window_end must be on or after window_start' })
        }
        windowStart = body.window_start
        windowEnd = body.window_end
      } else if (windowKind === 'rolling') {
        rollingDays = Number(body.rolling_days)
        if (!Number.isInteger(rollingDays) || rollingDays < 1 || rollingDays > ROLLING_DAYS_MAX) {
          return reply.status(400).send({ error: `rolling_days must be an integer 1..${ROLLING_DAYS_MAX}` })
        }
      } else {
        return reply.status(400).send({ error: 'window_kind must be "fixed" or "rolling"' })
      }

      // Auto-resolve (#186): the scheduler closes a fixed competition once its
      // end day passes, or draws a rolling one every resolve_interval_days
      // (defaulting to its window length). next_resolve_at seeds the first
      // rolling draw one interval out.
      const autoResolve = body.auto_resolve === true
      let resolveIntervalDays: number | null = null
      let nextResolveAt: Date | null = null
      if (autoResolve && windowKind === 'rolling') {
        resolveIntervalDays = body.resolve_interval_days == null
          ? (rollingDays as number)
          : Number(body.resolve_interval_days)
        if (!Number.isInteger(resolveIntervalDays) || resolveIntervalDays < 1 || resolveIntervalDays > ROLLING_DAYS_MAX) {
          return reply.status(400).send({ error: `resolve_interval_days must be an integer 1..${ROLLING_DAYS_MAX}` })
        }
        nextResolveAt = new Date()
        nextResolveAt.setUTCDate(nextResolveAt.getUTCDate() + resolveIntervalDays)
      }

      const createdBy = req.session!.torn_user_id
      const inserted = await db.query(
        `INSERT INTO competitions
           (name, type, metric_id, direction, reducer, window_kind, window_start, window_end,
            rolling_days, auto_resolve, resolve_interval_days, next_resolve_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING ${SELECT_COLS}`,
        [name, type, body.metric_id, direction, reducer, windowKind, windowStart, windowEnd,
         rollingDays, autoResolve, resolveIntervalDays, nextResolveAt, String(createdBy)]
      )
      return reply.status(201).send({ competition: inserted.rows[0] })
    }
  )

  // Resolve → materialise the current standings into competition_results as a
  // new resolution (fixed resolves once; rolling accretes one per resolve). The
  // top-ranked member is the winner. Refuses an empty board (nothing to crown).
  app.post(
    '/api/competitions/:id/resolve',
    { preHandler: [requireNotVisitor(), requireRole('leadership', 'admin')] },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      if (!/^\d+$/.test(id)) return reply.status(404).send({ error: 'Competition not found' })
      const compRes = await db.query(`SELECT ${SELECT_COLS} FROM competitions WHERE id = $1`, [id])
      if (compRes.rows.length === 0) return reply.status(404).send({ error: 'Competition not found' })
      const competition = compRes.rows[0]

      const result = await resolveCompetition(db, competition, String(req.session!.torn_user_id))
      if (!result) {
        return reply.status(409).send({ error: 'No standings to resolve yet in this window' })
      }
      return result
    }
  )

  // Past resolutions, newest first, each with its frozen standings + winner.
  app.get('/api/competitions/:id/history', { preHandler: requireAuth() }, async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!/^\d+$/.test(id)) return reply.status(404).send({ error: 'Competition not found' })
    const res = await db.query(
      `SELECT resolution_seq, resolved_at, resolved_by, window_start, window_end,
              member_id, member_name, value, rank, partial, winner
         FROM competition_results
        WHERE competition_id = $1
        ORDER BY resolution_seq DESC, rank ASC`,
      [id]
    )
    // Group the flat rows into resolutions.
    const bySeq = new Map<number, any>()
    for (const r of res.rows) {
      let group = bySeq.get(r.resolution_seq)
      if (!group) {
        group = {
          resolution_seq: r.resolution_seq,
          resolved_at: r.resolved_at,
          resolved_by: r.resolved_by,
          window_start: r.window_start,
          window_end: r.window_end,
          winner: null as any,
          standings: [] as any[],
        }
        bySeq.set(r.resolution_seq, group)
      }
      const row = {
        member_id: r.member_id, member_name: r.member_name,
        value: r.value, rank: r.rank, partial: r.partial, winner: r.winner,
      }
      group.standings.push(row)
      if (r.winner) group.winner = row
    }
    return { resolutions: [...bySeq.values()] }
  })
}

interface CompetitionRow {
  id?: number | string
  metric_id: string
  direction: string
  reducer?: string
  window_kind?: string
  window_start?: string | Date | null
  window_end?: string | Date | null
  rolling_days?: number | null
  auto_resolve?: boolean
  resolve_interval_days?: number | null
  next_resolve_at?: string | Date | null
}

function toIsoDate(d: string | Date): string {
  return typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10)
}

// The concrete [start, end] the standings cover: a fixed competition's stored
// dates, or — for a rolling one — the trailing rolling_days ending today (UTC).
export function effectiveWindow(
  competition: CompetitionRow,
  today = new Date()
): { start: string; end: string } | null {
  if (competition.window_kind === 'rolling') {
    const days = competition.rolling_days ?? 0
    if (days < 1) return null
    const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
    const start = new Date(end)
    start.setUTCDate(start.getUTCDate() - days)
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) }
  }
  if (competition.window_start == null || competition.window_end == null) return null
  return { start: toIsoDate(competition.window_start), end: toIsoDate(competition.window_end) }
}

function daysBetween(start: string, end: string): number {
  const ms = Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)
  return Math.max(1, Math.round(ms / 86_400_000))
}

// Per-current-member delta of the metric over the effective window. Rows
// without a numeric value at the metric's path are skipped (never miscounted).
// `partial` marks members whose first in-window snapshot is after the window
// opened. With the per-day-average reducer, the delta is divided by the window
// length — a positive constant, so the SQL ordering on raw delta still holds.
export async function computeStandings(db: pg.Pool, competition: CompetitionRow) {
  const metric = getMetric(competition.metric_id)
  if (!metric) return []
  const window = effectiveWindow(competition)
  if (!window) return []
  const order = competition.direction === 'asc' ? 'ASC' : 'DESC'
  const perDay = competition.reducer === 'avg_per_day'
  const windowDays = daysBetween(window.start, window.end)

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
    [window.start, window.end, metric.path]
  )
  return res.rows.map((r, i) => ({
    rank: i + 1,
    member_id: r.member_id,
    member_name: r.member_name,
    // Per-day average divides by the window length (order-preserving), rounded
    // to 2 dp; total is the raw delta.
    value: perDay ? Math.round((r.value / windowDays) * 100) / 100 : r.value,
    partial: r.partial,
    start_date: r.start_date,
    end_date: r.end_date,
  }))
}

// Materialise the current standings as the next resolution (winner = rank 1).
// Returns null when the window has no standings — nothing to crown. Shared by
// the manual endpoint and the scheduled auto-resolver.
export async function resolveCompetition(
  db: pg.Pool,
  competition: CompetitionRow & { id: number | string },
  resolvedBy: string
) {
  const window = effectiveWindow(competition)
  const standings = await computeStandings(db, competition)
  if (!window || standings.length === 0) return null

  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const seqRes = await client.query(
      `SELECT COALESCE(MAX(resolution_seq), 0) + 1 AS seq
         FROM competition_results WHERE competition_id = $1`,
      [competition.id]
    )
    const seq = seqRes.rows[0].seq as number
    for (const s of standings) {
      await client.query(
        `INSERT INTO competition_results
           (competition_id, resolution_seq, resolved_by, window_start, window_end,
            member_id, member_name, value, rank, partial, winner)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [competition.id, seq, resolvedBy, window.start, window.end, s.member_id, s.member_name,
         s.value, s.rank, s.partial, s.rank === 1]
      )
    }
    await client.query('COMMIT')
    const winner = standings.find((s) => s.rank === 1) ?? null
    return { resolution_seq: seq, winner, member_count: standings.length }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

// Parse a stored timestamp to a Date. db.ts returns timestamptz as a text
// string (space→T) with Postgres's microsecond precision and a bare ±HH offset,
// which `new Date()` can't parse — so normalise the offset to ±HH:MM and trim
// fractional seconds to milliseconds first. Dates and ISO strings pass through.
function toDate(v: string | Date): Date {
  if (v instanceof Date) return v
  let s = String(v)
  // Only a value with a time part carries an offset to normalise; a date-only
  // string like "2999-01-01" must pass through untouched (its trailing "-01"
  // is not an offset).
  if (s.includes('T')) {
    s = s
      .replace(/(\.\d{3})\d+/, '$1')        // micros → millis
      .replace(/([+-]\d{2})$/, '$1:00')     // bare ±HH offset → ±HH:MM
  }
  return new Date(s)
}

// Advance a rolling competition's next-resolution time past `now`, skipping any
// intervals missed while the scheduler was down (catch-up draws the same "today"
// window, so we jump straight to the next future boundary rather than duplicate).
export function advanceNextResolve(from: Date, intervalDays: number, now: Date): Date {
  const next = new Date(from)
  do { next.setUTCDate(next.getUTCDate() + intervalDays) } while (next <= now)
  return next
}

// Whether an auto-managed competition is due to resolve right now. Pure so the
// due/not-due decision is unit-testable; the DB-dependent gates (already
// resolved, end-day snapshot present) are checked in runAutoResolve.
export function isDueToResolve(competition: CompetitionRow, now: Date): boolean {
  if (!competition.auto_resolve) return false
  if (competition.window_kind === 'rolling') {
    if (competition.next_resolve_at == null) return false
    return toDate(competition.next_resolve_at) <= now
  }
  // Fixed: due once the end day has fully passed (strictly after window_end).
  if (competition.window_end == null) return false
  return isoDay(now) > toIsoDate(competition.window_end)
}

// The scheduled tick: resolve every auto-managed competition that's due, gated
// so a fixed one resolves exactly once and only after its final-day snapshot has
// landed. Rolling ones advance their next-resolution time each cycle. Returns
// the number resolved (for the run log).
export async function runAutoResolve(db: pg.Pool, now = new Date()) {
  const { rows } = await db.query(
    `SELECT ${SELECT_COLS} FROM competitions WHERE auto_resolve = true`
  )
  let resolved = 0
  for (const comp of rows) {
    if (!isDueToResolve(comp, now)) continue

    if (comp.window_kind === 'rolling') {
      const result = await resolveCompetition(db, comp, 'scheduler')
      if (result) resolved++
      // Advance regardless of an empty window so we don't spin on this cycle.
      const interval = comp.resolve_interval_days ?? comp.rolling_days ?? 1
      const next = advanceNextResolve(toDate(comp.next_resolve_at), interval, now)
      await db.query('UPDATE competitions SET next_resolve_at = $1, updated_at = now() WHERE id = $2', [next, comp.id])
    } else {
      // Fixed: resolve once. Skip if already resolved or the end-day snapshot
      // hasn't landed yet (don't freeze an under-counted board).
      const already = await db.query('SELECT 1 FROM competition_results WHERE competition_id = $1 LIMIT 1', [comp.id])
      if (already.rows.length > 0) continue
      const endData = await db.query(
        'SELECT 1 FROM member_daily_stats WHERE snapshot_date >= $1 LIMIT 1',
        [toIsoDate(comp.window_end)]
      )
      if (endData.rows.length === 0) continue
      const result = await resolveCompetition(db, comp, 'scheduler')
      if (result) resolved++
    }
  }
  return resolved
}
