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
import { chainReportEnded } from './eventChainReport.js'
import {
  chainSection, dailySection, targetsSection, highlightsSection, rangeMembers, nameBook, reportVersion,
  wantedSection, memberAttackers,
} from './eventReport.js'

const LEAD = { preHandler: [requireRole('leadership', 'admin')] }
const actor = (req: FastifyRequest) => (req.session as any)?.torn_user_id ?? null

const SELECT_EVENT = `
  SELECT e.id, e.name, e.theme_color, e.ends_with_chain, e.site_accent, e.wanted_min_attacks, e.chain_event_id,
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
 * Precedence, most trusted first:
 *   1. A lead marking the Chain Watch event ended — the same precedence Chain
 *      Watch's payout uses.
 *   2. The live chain report's own `end` (#970), once polls have run a margin
 *      past it — Torn's exact time, where the sampler below is four minutes
 *      coarse and blind during an outage. ⚠️ Judged against the last
 *      SUCCESSFUL poll, not the last change: a finished report stops changing,
 *      so its `sampled_at` would never move past its end.
 *   3. The FIRST chain sample showing the chain dead — from the append-only
 *      history, so the answer does not depend on when anybody opened the page.
 *      ⚠️ Samples with no reading are not deaths.
 */
async function chainEndedAt(db: pg.Pool, r: any): Promise<number | null> {
  if (r.chain_marked_end_ms != null) return Number(r.chain_marked_end_ms)
  const rep = await db.query(
    `SELECT (extract(epoch from l.chain_end) * 1000)::bigint AS end_ms,
            (extract(epoch from s.last_ok_at) * 1000)::bigint AS ok_ms
       FROM event_chain_report_latest l
       LEFT JOIN event_chain_report_poll_state s ON s.event_id = l.event_id
      WHERE l.event_id = $1`,
    [r.id],
  )
  const row = rep.rows[0]
  if (row?.end_ms != null && row.ok_ms != null
      && chainReportEnded(Number(row.end_ms), Number(row.ok_ms))) {
    return Number(row.end_ms)
  }
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
    site_accent: r.site_accent !== false,
    wanted_min_attacks: Number(r.wanted_min_attacks ?? 3),
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

/** How long one answer to "has the report changed?" is reused (#972). */
export const VERSION_TTL_MS = 3_000

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
  if (body?.site_accent !== undefined) cols.site_accent = !!body.site_accent
  if (body?.wanted_min_attacks !== undefined) {
    const n = Number(body.wanted_min_attacks)
    if (!Number.isInteger(n) || n < 1 || n > 1000) return { error: 'wanted_min_attacks must be a whole number from 1 to 1000' }
    cols.wanted_min_attacks = n
  }

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

  // #971 — the Report tab. Open to every member, like the page. Served for an
  // ENDED event too: the report outlives the event it describes.
  app.get('/api/events/:id/report', { preHandler: requireAuth() }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    if (!Number.isInteger(id) || id <= 0) return reply.status(400).send({ error: 'Invalid event id' })
    const ev = await db.query(`${SELECT_EVENT} WHERE e.id = $1`, [id])
    const r = ev.rows[0]
    if (!r) return reply.status(404).send({ error: 'No such event' })
    const now = Date.now()
    const t = times(r)
    const until = Math.min(now, t.ended_at ?? now)

    const us = Number((await db.query('SELECT torn_faction_id FROM faction_config LIMIT 1')).rows[0]?.torn_faction_id)
    const names = nameBook((await db.query('SELECT member_id AS id, member_name AS name FROM members')).rows)

    const latest = (await db.query(
      `SELECT chain_id, details, attackers, bonuses, non_attackers,
              (extract(epoch from chain_start) * 1000)::bigint AS start_ms,
              (extract(epoch from chain_end)   * 1000)::bigint AS end_ms,
              (extract(epoch from sampled_at)  * 1000)::bigint AS sampled_ms
         FROM event_chain_report_latest WHERE event_id = $1`, [id])).rows[0]

    const phase = r.ended_ms != null ? 'ended' : now < t.starts_at ? 'upcoming' : 'live'
    return {
      event: { ...shape(r, phase as EventPhase) },
      server_now: now,
      chain: latest ? chainSection(latest, names) : null,
      daily: Number.isFinite(us) ? await dailySection(db, us, Number(r.daily_ms), until, names) : [],
      targets: Number.isFinite(us) ? await targetsSection(db, us, t.starts_at, until, names) : null,
    }
  })

  // The wanted board, and the breakdown behind "Most targeted" (2026-10-18).
  // Open to every member, like the rest of the report; removing someone from
  // the board is leadership's call.
  const eventWindow = async (id: number) => {
    const ev = await db.query(`${SELECT_EVENT} WHERE e.id = $1`, [id])
    const r = ev.rows[0]
    if (!r) return null
    const now = Date.now()
    const t = times(r)
    const us = Number((await db.query('SELECT torn_faction_id FROM faction_config LIMIT 1')).rows[0]?.torn_faction_id)
    return { r, us, from: t.starts_at, to: Math.min(now, t.ended_at ?? now) }
  }
  const idParam = (v: unknown) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null }

  app.get('/api/events/:id/wanted', { preHandler: requireAuth() }, async (req, reply) => {
    const id = idParam((req.params as any).id)
    if (!id) return reply.status(400).send({ error: 'Invalid event id' })
    const w = await eventWindow(id)
    if (!w) return reply.status(404).send({ error: 'No such event' })
    const names = nameBook((await db.query('SELECT member_id AS id, member_name AS name FROM members')).rows)
    return wantedSection(db, id, w.us, w.from, w.to, names, Number(w.r.wanted_min_attacks ?? 3))
  })

  app.get('/api/events/:id/targeted/:memberId', { preHandler: requireAuth() }, async (req, reply) => {
    const id = idParam((req.params as any).id)
    const member = idParam((req.params as any).memberId)
    if (!id || !member) return reply.status(400).send({ error: 'Invalid id' })
    const w = await eventWindow(id)
    if (!w) return reply.status(404).send({ error: 'No such event' })
    return memberAttackers(db, w.us, member, w.from, w.to)
  })

  app.post('/api/events/:id/wanted/:attackerId/dismiss', LEAD, async (req, reply) => {
    const id = idParam((req.params as any).id)
    const attacker = idParam((req.params as any).attackerId)
    if (!id || !attacker) return reply.status(400).send({ error: 'Invalid id' })
    const note = typeof (req.body as any)?.note === 'string' ? String((req.body as any).note).trim().slice(0, 200) || null : null
    await db.query(
      `INSERT INTO event_wanted_dismissed (event_id, attacker_id, note, dismissed_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (event_id, attacker_id) DO UPDATE SET note = EXCLUDED.note,
         dismissed_by = EXCLUDED.dismissed_by, dismissed_at = now()`,
      [id, attacker, note, actor(req)])
    return { ok: true }
  })

  app.delete('/api/events/:id/wanted/:attackerId/dismiss', LEAD, async (req, reply) => {
    const id = idParam((req.params as any).id)
    const attacker = idParam((req.params as any).attackerId)
    if (!id || !attacker) return reply.status(400).send({ error: 'Invalid id' })
    await db.query('DELETE FROM event_wanted_dismissed WHERE event_id = $1 AND attacker_id = $2', [id, attacker])
    return { ok: true }
  })

  // The Stats view (Daily + Highlights merged): every per-member figure and
  // highlight over ONE range — a day, the whole event ("Overall"), or a custom
  // span. `from`/`to` are epoch ms; both default to the event's own window.
  // ⚠️ Clamped to the event: a range can narrow it, never widen it.
  app.get('/api/events/:id/stats', { preHandler: requireAuth() }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    if (!Number.isInteger(id) || id <= 0) return reply.status(400).send({ error: 'Invalid event id' })
    const ev = await db.query(`${SELECT_EVENT} WHERE e.id = $1`, [id])
    const r = ev.rows[0]
    if (!r) return reply.status(404).send({ error: 'No such event' })
    const now = Date.now()
    const t = times(r)
    const end = Math.min(now, t.ended_at ?? now)
    const q = req.query as { from?: string; to?: string }
    const want = (v: string | undefined, dflt: number) => {
      if (v === undefined || v === '') return dflt
      const n = Number(v)
      return Number.isFinite(n) ? n : NaN
    }
    const from = Math.max(t.starts_at, want(q.from, t.starts_at))
    const to = Math.min(end, want(q.to, end))
    if (!Number.isFinite(from) || !Number.isFinite(to)) return reply.status(400).send({ error: "That time range isn't valid." })
    const us = Number((await db.query('SELECT torn_faction_id FROM faction_config LIMIT 1')).rows[0]?.torn_faction_id)
    const names = nameBook((await db.query('SELECT member_id AS id, member_name AS name FROM members')).rows)
    const range = to > from && Number.isFinite(us)
      ? await rangeMembers(db, us, from, to, names)
      : { totals: null, members: [] }
    return {
      from, to, server_now: now,
      totals: range.totals,
      members: range.members,
      highlights: to > from ? await highlightsSection(db, id, from, to, names) : null,
    }
  })

  // #972 — "has the report changed?", asked by every open report page every
  // few seconds. ⚠️ Memoised per event for VERSION_TTL_MS, so a hundred open
  // tabs cost one query rather than a hundred. Deliberately its own pull
  // endpoint rather than the War Room's push hub, which this shares nothing
  // with (see chainSample.ts).
  const versions = new Map<number, { at: number; version: string }>()
  app.get('/api/events/:id/report/version', { preHandler: requireAuth() }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    if (!Number.isInteger(id) || id <= 0) return reply.status(400).send({ error: 'Invalid event id' })
    const now = Date.now()
    const hit = versions.get(id)
    if (hit && now - hit.at < VERSION_TTL_MS) return { version: hit.version }
    const ev = await db.query(`${SELECT_EVENT} WHERE e.id = $1`, [id])
    const r = ev.rows[0]
    if (!r) return reply.status(404).send({ error: 'No such event' })
    const t = times(r)
    const us = Number((await db.query('SELECT torn_faction_id FROM faction_config LIMIT 1')).rows[0]?.torn_faction_id)
    const version = await reportVersion(db, id, us, t.starts_at, Math.min(now, t.ended_at ?? now))
    versions.set(id, { at: now, version })
    return { version }
  })

  // #973 — the attack-log archive's health. ⚠️ A growing backlog is the
  // number that matters: logs that wait too long expire and are lost.
  app.get('/api/events/:id/attack-logs/status', LEAD, async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    if (!Number.isInteger(id) || id <= 0) return reply.status(400).send({ error: 'Invalid event id' })
    const [st, counts] = await Promise.all([
      db.query(
        `SELECT backlog, calls, keys_available, last_error,
                (extract(epoch from growing_since) * 1000)::bigint AS growing_since,
                (extract(epoch from last_run_at)   * 1000)::bigint AS last_run_at,
                (extract(epoch from last_error_at) * 1000)::bigint AS last_error_at
           FROM event_attack_log_state WHERE event_id = $1`, [id]),
      db.query(
        `SELECT status, count(*) AS n FROM event_attack_logs WHERE event_id = $1 GROUP BY status`, [id]),
    ])
    const r = st.rows[0]
    if (!r) return { status: null }
    const by = Object.fromEntries(counts.rows.map((c) => [c.status, Number(c.n)]))
    const n = (v: unknown) => (v == null ? null : Number(v))
    return {
      status: {
        archived: by.archived ?? 0, gone: by.gone ?? 0, failed: by.failed ?? 0,
        backlog: Number(r.backlog), calls: Number(r.calls), keys_available: Number(r.keys_available),
        growing_since: n(r.growing_since), last_run_at: n(r.last_run_at),
        last_error: r.last_error, last_error_at: n(r.last_error_at),
      },
    }
  })

  // #970 — the chain-report poller's health. ⚠️ `changes / polls` IS the
  // measurement the cadence is set from: if the report changes on one poll in
  // six, polling every 5 s is buying nothing over 30 s.
  app.get('/api/events/:id/chain-report/status', LEAD, async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    if (!Number.isInteger(id) || id <= 0) return reply.status(400).send({ error: 'Invalid event id' })
    const { rows } = await db.query(
      `SELECT s.polls, s.changes, s.failures, s.consecutive_failures, s.skipped,
              s.last_error, s.last_skip_reason,
              (extract(epoch from s.last_ok_at)     * 1000)::bigint AS last_ok_at,
              (extract(epoch from s.last_change_at) * 1000)::bigint AS last_change_at,
              (extract(epoch from s.last_error_at)  * 1000)::bigint AS last_error_at,
              l.chain_id,
              (l.details->>'chain')::bigint AS chain,
              (SELECT count(*) FROM event_chain_report_snapshots x WHERE x.event_id = s.event_id) AS snapshots
         FROM event_chain_report_poll_state s
         LEFT JOIN event_chain_report_latest l ON l.event_id = s.event_id
        WHERE s.event_id = $1`,
      [id],
    )
    const r = rows[0]
    if (!r) return { status: null }
    const n = (v: unknown) => (v == null ? null : Number(v))
    const polls = Number(r.polls)
    return {
      status: {
        polls, changes: Number(r.changes), failures: Number(r.failures),
        consecutive_failures: Number(r.consecutive_failures), skipped: Number(r.skipped),
        change_rate: polls > 0 ? Number(r.changes) / polls : null,
        last_ok_at: n(r.last_ok_at), last_change_at: n(r.last_change_at),
        last_error_at: n(r.last_error_at), last_error: r.last_error, last_skip_reason: r.last_skip_reason,
        chain_id: n(r.chain_id), chain: n(r.chain), snapshots: Number(r.snapshots),
      },
    }
  })

  app.post('/api/events', LEAD, async (req, reply) => {
    const parsed = parse(req.body, false)
    if ('error' in parsed) return reply.status(400).send(parsed)
    const c = parsed.cols
    try {
      const res = await db.query(
        `INSERT INTO faction_events
           (name, theme_color, starts_at, daily_from, min_ends_at, ends_with_chain,
            chain_event_id, created_by, updated_by, site_accent)
         VALUES ($1, COALESCE($2, '#f97316'), to_timestamp($3::bigint / 1000.0),
                 to_timestamp($4::bigint / 1000.0), to_timestamp($5::bigint / 1000.0),
                 COALESCE($6, true), $7, $8, $8, COALESCE($9, true))
         RETURNING id`,
        [c.name, c.theme_color ?? null, c.starts_at, c.daily_from, c.min_ends_at,
         c.ends_with_chain ?? null, c.chain_event_id ?? null, actor(req), c.site_accent ?? null],
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
