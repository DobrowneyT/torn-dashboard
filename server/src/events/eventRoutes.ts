// The faction event the page shows, and leadership's controls for it (#969).
//
// Reads are open to any signed-in member — the page, the nav item and the
// landing redirect all need them. Writes are leadership/admin only, matching
// Chain Watch.
//
// ⚠️ Every timestamp leaves as EPOCH MILLISECONDS computed in SQL. Postgres
// serves timestamptz with a bare offset (`+00`) that `new Date()` reads as
// NaN — the trap that took the chain sampler down once already.
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type pg from 'pg'
import { requireAuth, requireRole } from '../authz.js'
import {
  eventPhase, eventEndedAt, TORN_CHAIN_MAX, type EventPhase, type EventTimes,
} from './eventLifecycle.js'

const LEAD = { preHandler: [requireRole('leadership', 'admin')] }
const actor = (req: FastifyRequest) => (req.session as any)?.torn_user_id ?? null

const SELECT_EVENT = `
  SELECT e.id, e.name, e.theme_color, e.ends_with_chain, e.chain_event_id,
         (extract(epoch from e.starts_at)   * 1000)::bigint AS starts_ms,
         (extract(epoch from e.daily_from)  * 1000)::bigint AS daily_ms,
         (extract(epoch from e.min_ends_at) * 1000)::bigint AS min_end_ms,
         (extract(epoch from e.ended_at)    * 1000)::bigint AS ended_ms,
         (extract(epoch from c.actually_ended_at) * 1000)::bigint AS chain_marked_end_ms
    FROM faction_events e
    LEFT JOIN chain_events c ON c.id = e.chain_event_id`

const times = (r: any): EventTimes => ({
  starts_at: Number(r.starts_ms),
  min_ends_at: Number(r.min_end_ms),
  ends_with_chain: !!r.ends_with_chain,
  ended_at: r.ended_ms == null ? null : Number(r.ended_ms),
})

/**
 * When the chain this event waits on was over, at or after the minimum end.
 *
 * ⚠️ A lead marking the Chain Watch event ended wins, the same precedence Chain
 * Watch's payout uses. Otherwise it is the FIRST sample showing the chain dead —
 * from the append-only history, so the answer does not depend on when anybody
 * opened the page. ⚠️ Samples with no reading are not deaths.
 */
async function chainEndedAt(db: pg.Pool, r: any): Promise<number | null> {
  if (r.chain_marked_end_ms != null) return Number(r.chain_marked_end_ms)
  const res = await db.query(
    `SELECT (extract(epoch from min(sampled_at)) * 1000)::bigint AS ms
       FROM chain_samples
      WHERE sampled_at >= to_timestamp($1::bigint / 1000.0)
        AND chain_current IS NOT NULL
        AND (chain_current = 0 OR chain_current >= $2)`,
    [r.min_end_ms, TORN_CHAIN_MAX],
  )
  return res.rows[0]?.ms == null ? null : Number(res.rows[0].ms)
}

function shape(r: any, phase: EventPhase) {
  return {
    id: Number(r.id),
    name: r.name,
    theme_color: r.theme_color,
    starts_at: Number(r.starts_ms),
    daily_from: Number(r.daily_ms),
    min_ends_at: Number(r.min_end_ms),
    ends_with_chain: !!r.ends_with_chain,
    chain_event_id: r.chain_event_id == null ? null : Number(r.chain_event_id),
    ended_at: r.ended_ms == null ? null : Number(r.ended_ms),
    phase,
  }
}

/**
 * The event the page should show: a live one, else the next upcoming one.
 *
 * ⚠️ **Stamps `ended_at` on any event found to be over**, with the DERIVED end
 * time. That is what keeps a finished event finished — without it, the next
 * ordinary chain the faction starts would bring Halloween back to life.
 */
export async function currentEvent(db: pg.Pool, now = Date.now()) {
  const res = await db.query(`${SELECT_EVENT} WHERE e.ended_at IS NULL ORDER BY e.starts_at`)
  let live: ReturnType<typeof shape> | null = null
  let upcoming: ReturnType<typeof shape> | null = null
  for (const r of res.rows) {
    const t = times(r)
    const chainEnd = t.ends_with_chain && now >= t.min_ends_at ? await chainEndedAt(db, r) : null
    const phase = eventPhase(t, now, chainEnd)
    if (phase === 'ended') {
      const at = eventEndedAt(t, chainEnd)
      if (at != null) {
        await db.query(
          `UPDATE faction_events SET ended_at = to_timestamp($2::bigint / 1000.0), updated_at = now()
            WHERE id = $1 AND ended_at IS NULL`,
          [r.id, at],
        )
      }
      continue
    }
    if (phase === 'live' && !live) live = shape(r, phase)
    if (phase === 'upcoming' && !upcoming) upcoming = shape(r, phase)
  }
  return live ?? upcoming
}

const HEX = /^#[0-9a-fA-F]{6}$/

/** A timestamp from the client: epoch ms or an ISO string. */
function toMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim()) {
    const ms = Date.parse(v)
    return Number.isFinite(ms) ? ms : null
  }
  return null
}

/**
 * Validate a create or edit. `partial` allows fields to be absent (an edit).
 * Returns the columns to write, or an error a lead can act on.
 */
function parse(body: any, partial: boolean): { cols: Record<string, unknown> } | { error: string } {
  const cols: Record<string, unknown> = {}
  const need = (k: string) => !partial && body?.[k] === undefined

  if (body?.name !== undefined) {
    const name = String(body.name).trim()
    if (!name || name.length > 60) return { error: 'name must be 1–60 characters' }
    cols.name = name
  } else if (need('name')) return { error: 'name is required' }

  if (body?.theme_color !== undefined) {
    if (!HEX.test(String(body.theme_color))) return { error: 'theme_color must be a hex colour like #f97316' }
    cols.theme_color = String(body.theme_color)
  }

  for (const k of ['starts_at', 'daily_from', 'min_ends_at'] as const) {
    if (body?.[k] !== undefined) {
      const ms = toMs(body[k])
      if (ms == null) return { error: `${k} is not a valid time` }
      cols[k] = ms
    } else if (need(k)) return { error: `${k} is required` }
  }

  if (body?.ends_with_chain !== undefined) cols.ends_with_chain = !!body.ends_with_chain

  if (body?.chain_event_id !== undefined) {
    const v = body.chain_event_id
    if (v === null) cols.chain_event_id = null
    else if (Number.isInteger(Number(v)) && Number(v) > 0) cols.chain_event_id = Number(v)
    else return { error: 'chain_event_id must be a Chain Watch event id or null' }
  }

  // ⚠️ Edit-only: a lead may end the event by hand ("now"), or set an end.
  if (partial && body?.ended_at !== undefined) {
    if (body.ended_at === null) cols.ended_at = null
    else if (body.ended_at === 'now') cols.ended_at = Date.now()
    else {
      const ms = toMs(body.ended_at)
      if (ms == null) return { error: 'ended_at is not a valid time' }
      cols.ended_at = ms
    }
  }
  return { cols }
}

const TIME_COLS = new Set(['starts_at', 'daily_from', 'min_ends_at', 'ended_at'])

/** Turn a constraint violation into a message a lead can act on. */
function constraintMessage(err: any): string | null {
  const c = String(err?.constraint ?? '')
  if (c === 'faction_events_daily_after_start') return 'daily_from cannot be before starts_at'
  if (c === 'faction_events_min_end_after_start') return 'min_ends_at must be after starts_at'
  if (c.includes('chain_event_id')) return 'no such Chain Watch event'
  if (c.includes('theme_color')) return 'theme_color must be a hex colour like #f97316'
  return null
}

export function registerEventRoutes(app: FastifyInstance, db: pg.Pool) {
  app.get('/api/events/current', { preHandler: requireAuth() }, async () => {
    return { event: await currentEvent(db), server_now: Date.now() }
  })

  app.post('/api/events', LEAD, async (req, reply) => {
    const parsed = parse(req.body, false)
    if ('error' in parsed) return reply.status(400).send(parsed)
    const c = parsed.cols
    try {
      const res = await db.query(
        `INSERT INTO faction_events
           (name, theme_color, starts_at, daily_from, min_ends_at, ends_with_chain,
            chain_event_id, created_by, updated_by)
         VALUES ($1, COALESCE($2, '#f97316'), to_timestamp($3::bigint / 1000.0),
                 to_timestamp($4::bigint / 1000.0), to_timestamp($5::bigint / 1000.0),
                 COALESCE($6, true), $7, $8, $8)
         RETURNING id`,
        [c.name, c.theme_color ?? null, c.starts_at, c.daily_from, c.min_ends_at,
         c.ends_with_chain ?? null, c.chain_event_id ?? null, actor(req)],
      )
      return { id: Number(res.rows[0].id), event: await currentEvent(db) }
    } catch (err) {
      const msg = constraintMessage(err)
      if (msg) return reply.status(400).send({ error: msg })
      throw err
    }
  })

  app.patch('/api/events/:id', LEAD, async (req, reply) => {
    const id = Number((req.params as any).id)
    if (!Number.isInteger(id) || id <= 0) return reply.status(400).send({ error: 'bad id' })
    const parsed = parse(req.body, true)
    if ('error' in parsed) return reply.status(400).send(parsed)
    const entries = Object.entries(parsed.cols)
    if (entries.length === 0) return reply.status(400).send({ error: 'nothing to change' })

    const sets: string[] = []
    const vals: unknown[] = [id]
    for (const [k, v] of entries) {
      vals.push(v)
      sets.push(TIME_COLS.has(k) && v !== null
        ? `${k} = to_timestamp($${vals.length}::bigint / 1000.0)`
        : `${k} = $${vals.length}`)
    }
    vals.push(actor(req))
    try {
      const res = await db.query(
        `UPDATE faction_events SET ${sets.join(', ')}, updated_by = $${vals.length}, updated_at = now()
          WHERE id = $1 RETURNING id`,
        vals,
      )
      if (res.rowCount === 0) return reply.status(404).send({ error: 'no such event' })
      return { id, event: await currentEvent(db) }
    } catch (err) {
      const msg = constraintMessage(err)
      if (msg) return reply.status(400).send({ error: msg })
      throw err
    }
  })
}
