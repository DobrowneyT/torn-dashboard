// Chain Watch (#771): hourly sign-ups for a long chain, and the record that
// pays for them.
//
// Reads are open to any authenticated session. Every mutation of the
// EVENT is leadership; the sign-up routes are the exception, because claiming
// an hour is the whole point of the page.
//
// ⚠️ Time arithmetic stays in SQL. Postgres serves timestamptz as text with a
// bare two-digit offset ("...+00") which `new Date` parses to NaN — the #140
// trap. Nothing here round-trips a stored timestamp through JS: the window
// grows with `ends_at + interval '24 hours'`, and every bound is compared
// in the database.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type pg from 'pg'
import { requireAuth, requireRole } from './authz.js'
import { projectChain, type ChainReading } from './chain/chainProjection.js'
import { flagFor, FLAG_REASON, type HourEvidence } from './chain/watchFlags.js'
import { chainOutcome, type OutcomeSample } from './chain/chainOutcome.js'
import { notifyBoardChanged, notifyEnabled } from './chainWatchNotify.js'

const TITLE_MAX = 120
const REASON_MAX = 500
const MAX_DAYS = 60
const APPLIES_TO = new Set(['tickets', 'payout', 'both'])
const STATUSES = new Set(['draft', 'open', 'closed'])

/** Leadership guard, spelled out on every mutating route rather than inherited. */
const LEAD = { preHandler: [requireRole('leadership', 'admin')] }
/** Any authenticated member may claim and drop their OWN slot. */
const MEMBER = { preHandler: [requireAuth()] }

const isLead = (req: FastifyRequest) =>
  !!req.session?.is_leadership || !!req.session?.is_admin
const actor = (req: FastifyRequest) => req.session?.torn_user_id ?? null

/**
 * Event columns plus the two derivations that must never be frozen onto a row.
 *
 * ⚠️ `is_bonus` is computed from the event's CURRENT `bonus_hours`, not stamped
 * at sign-up. The spreadsheet froze its bonus into a column position and paid
 * 28 slots nobody intended; making this a read-time derivation is what lets
 * leadership correct the hours mid-event and have the correction apply to
 * hours already served.
 */
const SIGNUP_SELECT = `
  s.id, s.event_id, s.hour_start, s.slot_index, s.member_id,
  s.created_at, s.created_by, s.removed_at, s.removed_by, s.removed_reason, s.via,
  m.member_name,
  -- ⚠️ Epoch ms alongside the timestamp. Postgres serves timestamptz with a
  -- BARE two-digit offset ("...-05"), which new Date() parses to NaN — the
  -- #140 trap. Nothing downstream may parse hour_start in JS.
  -- (No backticks in here: this comment lives inside a template literal.)
  (extract(epoch from s.hour_start) * 1000)::bigint AS hour_ms,
  -- ⚠️ Same reason as hour_ms: created_at is a timestamptz and arrives with a
  -- bare two-digit offset that new Date() reads as NaN (#140). The grid shows
  -- when a slot was claimed, so it needs a number it can trust.
  (extract(epoch from s.created_at) * 1000)::bigint AS created_ms,
  (extract(hour from s.hour_start at time zone 'UTC')::int = ANY (e.bonus_hours)) AS is_bonus,
  s.pay_decision, s.decided_by, s.decided_at,
  -- ⚠️ Precedence matters: a leader's explicit actually_ended_at wins over the
  -- end derived from chain_samples, which wins over the planned ends_at. One
  -- expression, so the grid and the payout panel cannot disagree about which
  -- hours were real.
  (s.hour_start < coalesce(e.actually_ended_at, $2::timestamptz, e.ends_at))     AS is_payable`

async function loadEvent(db: pg.Pool, id: number) {
  const { rows } = await db.query('SELECT * FROM chain_events WHERE id = $1', [id])
  return rows[0] ?? null
}

/** Postgres surfaces WHICH unique index failed; the caller needs them separable. */
function conflictFor(err: unknown): { status: number; error: string } | null {
  const name = (err as { constraint?: string })?.constraint
  if (name === 'chain_watch_signups_slot_live') {
    return { status: 409, error: 'That slot was just taken' }
  }
  if (name === 'chain_watch_signups_member_hour_live') {
    // ⚠️ Deliberately does not say "taken": the slot is free, the person is
    // not. The picker disables that name with this reason rather than
    // pretending an empty slot is occupied.
    return { status: 409, error: 'Already watching this hour — one member cannot hold both slots' }
  }
  return null
}

export function registerChainWatchRoutes(
  app: FastifyInstance, db: pg.Pool, factionSlug = '',
) {
  // ⚠️ One hook rather than a call at every return point. There are eight
  // mutating routes and more will be added; a nudge that has to be remembered
  // per-route is one that gets forgotten, and the symptom — a board that is
  // stale only after THIS particular action — is invisible in testing.
  //
  // ⚠️ Fires only on success. A 409 "that slot was just taken" changed nothing,
  // and redrawing for it would put load on Discord proportional to contention,
  // which is exactly backwards.
  if (notifyEnabled() && factionSlug) {
    app.addHook('onResponse', async (req, reply) => {
      if (req.method === 'GET' || reply.statusCode >= 300) return
      const url = req.url.split('?')[0]
      if (!url.startsWith('/api/chain-events')) return
      // The pay decision is a payout-panel concern and never reaches the
      // board; a bulk review would otherwise redraw once per row.
      if (url.endsWith('/decision')) return
      void notifyBoardChanged(factionSlug)
    })
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  app.get('/api/chain-events', { preHandler: requireAuth() }, async () => {
    const { rows } = await db.query('SELECT * FROM chain_events ORDER BY starts_at DESC')
    return { events: rows }
  })

  app.get('/api/chain-events/:id', { preHandler: requireAuth() }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    const event = await loadEvent(db, id)
    if (!event) return reply.status(404).send({ error: 'No such event' })

    // ⚠️ When did the chain actually end? Read back out of chain_samples
    // rather than caught in the moment — which is the entire reason that series
    // is append-only. A leader's explicit `actually_ended_at` still wins.
    const { rows: outcomeRows } = await db.query(
      `SELECT (extract(epoch from sampled_at) * 1000)::bigint AS at,
              chain_current, chain_cooldown
         FROM chain_samples
        WHERE sampled_at >= $1::timestamptz
        ORDER BY sampled_at`, [event.starts_at])
    const outcome = chainOutcome(outcomeRows.map((r): OutcomeSample => ({
      at: Number(r.at),
      chain: r.chain_current == null ? null : Number(r.chain_current),
      cooldown: r.chain_cooldown == null ? null : Number(r.chain_cooldown),
    })))
    const derivedEnd = outcome.state === 'ended' ? new Date(outcome.endedAt).toISOString() : null

    // Live rows only. Removed ones are the payout panel's business (#773),
    // which asks for them explicitly — the grid showing both would double-count.
    const { rows } = await db.query(
      `SELECT ${SIGNUP_SELECT}
         FROM chain_watch_signups s
         JOIN chain_events e ON e.id = s.event_id
         LEFT JOIN members m ON m.member_id = s.member_id
        WHERE s.event_id = $1 AND s.removed_at IS NULL
        ORDER BY s.hour_start, s.slot_index`, [id, derivedEnd])

    // ⚠️ Removed slots on hours that have RUN. A member who worked an hour and
    // was later taken off it sees a smaller number with no explanation
    // otherwise, which is the fastest way to lose trust in the whole sheet.
    // "Removed" is not "never signed up", and this panel is the only place
    // anyone will look.
    const { rows: removed } = await db.query(
      `SELECT ${SIGNUP_SELECT}, rb.member_name AS removed_by_name
         FROM chain_watch_signups s
         JOIN chain_events e ON e.id = s.event_id
         LEFT JOIN members m ON m.member_id = s.member_id
         LEFT JOIN members rb ON rb.member_id = s.removed_by
        WHERE s.event_id = $1 AND s.removed_at IS NOT NULL AND s.hour_start < now()
        ORDER BY s.hour_start, s.slot_index`, [id, derivedEnd])
    // ⚠️ Evidence for the review flags (#774), gathered per served hour. An
    // hour with NO samples yields no flag at all: "we were not looking" must
    // never render as "they were not there".
    const { rows: evidence } = await db.query(
      `WITH served AS (
         SELECT DISTINCT s.hour_start, s.member_id
           FROM chain_watch_signups s
          WHERE s.event_id = $1 AND s.removed_at IS NULL AND s.hour_start < now()
       )
       SELECT v.hour_start, (extract(epoch from v.hour_start) * 1000)::bigint AS hour_ms,
              v.member_id,
              coalesce(array_agg(DISTINCT a.last_action_epoch)
                       FILTER (WHERE a.last_action_epoch IS NOT NULL), '{}') AS last_actions,
              coalesce(array_agg(a.status_state ORDER BY a.sampled_at)
                       FILTER (WHERE a.status_state IS NOT NULL), '{}') AS states,
              count(a.id) > 0 AS sampled,
              (SELECT min(c.chain_timeout - extract(epoch from c.sampled_at))
                 FROM chain_samples c
                WHERE c.sampled_at >= v.hour_start
                  AND c.sampled_at < v.hour_start + interval '1 hour'
                  AND c.chain_timeout IS NOT NULL) AS min_timeout
         FROM served v
         LEFT JOIN member_activity_samples a
           ON a.member_id = v.member_id
          AND a.sampled_at >= v.hour_start
          AND a.sampled_at < v.hour_start + interval '1 hour'
        GROUP BY v.hour_start, v.member_id`, [id])

    const flags = new Map<string, { flag: string; reason: string }>()
    for (const e of evidence) {
      const hourStart = Number(e.hour_ms)
      const ev: HourEvidence = {
        hourStart,
        // Torn's last_action is epoch SECONDS; the flag rules work in ms.
        lastActions: (e.last_actions ?? []).map((n: string) => Number(n) * 1000),
        states: e.states ?? [],
        minTimeoutSeconds: e.min_timeout == null ? null : Number(e.min_timeout),
        sampled: e.sampled === true,
      }
      const flag = flagFor(ev)
      if (flag) flags.set(`${hourStart}:${e.member_id}`, { flag, reason: FLAG_REASON[flag] })
    }
    for (const row of rows) {
      const key = `${Number(row.hour_ms)}:${row.member_id}`
      const hit = flags.get(key)
      row.flag = hit?.flag ?? null
      row.flag_reason = hit?.reason ?? null
      // ⚠️ Abroad is the one finding that is not a judgment call: a watcher
      // overseas could not have hit anything, so the slot was not served.
      // Everything else stays payable until a leader says otherwise.
      if (hit?.flag === 'abroad') row.is_payable = false
    }

    // ⚠️ Where the chain is going, from the chain COUNTER — not from a count of
    // attacks. Only qualifying attacks advance a chain, so counting rows
    // measures effort while the delta in `chain` measures the thing itself.
    const { rows: readings } = await db.query(
      `SELECT chain, extract(epoch from to_timestamp(started)) * 1000 AS at
         FROM faction_attacks
        WHERE chain IS NOT NULL AND started IS NOT NULL
          AND to_timestamp(started) >= $1::timestamptz
        ORDER BY started`, [event.starts_at])
    const projection = projectChain(
      readings.map((r): ChainReading => ({ chain: Number(r.chain), at: Number(r.at) })),
      Date.now())

    // ⚠️ The client decides which hours have elapsed, and it must not do that
    // from its own clock: a viewer with a skewed system time would be shown
    // still-claimable hours as past, or worse, offered a claim on an hour that
    // has gone. That viewer is the half-asleep person at 3am this page exists
    // for. The server's now travels with the payload.
    // ⚠️ A dropped chain gets a post-mortem, not just a smaller payout. Two
    // watchers per hour exist precisely so this should not happen; when it
    // does, who was on must not depend on anybody's memory.
    let finalHourWatchers: Array<{ member_id: string; member_name: string | null }> = []
    if (outcome.state === 'ended') {
      const { rows: onWatch } = await db.query(
        `SELECT s.member_id, m.member_name
           FROM chain_watch_signups s
           LEFT JOIN members m ON m.member_id = s.member_id
          WHERE s.event_id = $1 AND s.removed_at IS NULL
            AND s.hour_start = date_trunc('hour', $2::timestamptz)
          ORDER BY s.slot_index`, [id, new Date(outcome.endedAt).toISOString()])
      finalHourWatchers = onWatch
    }

    const { rows: clock } = await db.query('SELECT now() AS server_now')
    return {
      event, signups: rows, removed, projection,
      outcome: { ...outcome, derivedEnd, finalHourWatchers },
      server_now: clock[0].server_now,
    }
  })

  // ── The event ──────────────────────────────────────────────────────────────

  app.post('/api/chain-events', LEAD, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>
    const title = typeof b.title === 'string' ? b.title.trim() : ''
    const days = Number(b.days ?? 3)
    if (!title || title.length > TITLE_MAX) return reply.status(400).send({ error: 'title required' })
    if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
      return reply.status(400).send({ error: `days must be 1..${MAX_DAYS}` })
    }
    if (typeof b.starts_at !== 'string') return reply.status(400).send({ error: 'starts_at required' })

    // ⚠️ A number of DAYS, not an end date, and the end is derived in SQL so
    // the start hour is preserved. The 2025 event ran 10:00 → 16:00 TCT;
    // snapping to midnight would be wrong at both ends.
    // ⚠️ Every placeholder is cast. Postgres cannot infer a parameter's type
    // inside `coalesce($n, ...)` or `$n || text` when the value arrives NULL,
    // and the error it raises looks exactly like bad user input.
    try {
      const { rows } = await db.query(
        `INSERT INTO chain_events
           (title, starts_at, ends_at, slots_per_hour, payout_per_slot,
            bonus_hours, bonus_multiplier, bonus_applies_to, created_by, updated_by)
         VALUES ($1::text, $2::timestamptz,
                 $2::timestamptz + ($3::int * interval '1 day'),
                 coalesce($4::int, 2), coalesce($5::bigint, 1500000),
                 coalesce($6::int[], '{5,6}'::int[]), coalesce($7::int, 2),
                 coalesce($8::text, 'tickets'), $9::text, $9::text)
         RETURNING *`,
        [title, b.starts_at, days, b.slots_per_hour ?? null, b.payout_per_slot ?? null,
         b.bonus_hours ?? null, b.bonus_multiplier ?? null, b.bonus_applies_to ?? null, actor(req)],
      )
      return reply.status(201).send(rows[0])
    } catch (err) {
      // Only a genuinely unparseable timestamp is the caller's fault. Anything
      // else is ours and must not be disguised as a validation error — that is
      // what made 34 failing tests all report "400" and say nothing.
      const code = (err as { code?: string })?.code
      if (code === '22007' || code === '22008') {
        return reply.status(400).send({ error: 'starts_at is not a valid timestamp' })
      }
      throw err
    }
  })

  app.patch('/api/chain-events/:id', LEAD, async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    const b = (req.body ?? {}) as Record<string, unknown>
    if (b.bonus_applies_to !== undefined && !APPLIES_TO.has(String(b.bonus_applies_to))) {
      return reply.status(400).send({ error: 'bonus_applies_to must be tickets|payout|both' })
    }
    if (b.status !== undefined && !STATUSES.has(String(b.status))) {
      return reply.status(400).send({ error: 'status must be draft|open|closed' })
    }
    if (b.bonus_hours !== undefined) {
      const hrs = b.bonus_hours
      if (!Array.isArray(hrs) || hrs.some((h) => !Number.isInteger(h) || h < 0 || h > 23)) {
        return reply.status(400).send({ error: 'bonus_hours must be hours 0..23' })
      }
    }

    const sets: string[] = []
    const vals: unknown[] = []
    for (const col of ['title', 'slots_per_hour', 'payout_per_slot', 'bonus_hours',
                       'bonus_multiplier', 'bonus_applies_to', 'status', 'actually_ended_at']) {
      if (b[col] !== undefined) { vals.push(b[col]); sets.push(`${col} = $${vals.length}`) }
    }
    if (sets.length === 0) return reply.status(400).send({ error: 'nothing to update' })
    vals.push(actor(req)); const who = `$${vals.length}`
    vals.push(id)

    const { rows } = await db.query(
      `UPDATE chain_events SET ${sets.join(', ')}, updated_by = ${who}, updated_at = now()
        WHERE id = $${vals.length} RETURNING *`, vals)
    if (!rows[0]) return reply.status(404).send({ error: 'No such event' })
    return rows[0]
  })

  /**
   * Nix (or restore) a member's pay for a whole event (#773 follow-up).
   *
   * ⚠️ **A blanket switch over the per-slot decisions**, not a separate field.
   * `pay_decision` already decides what is paid, and adding a second mechanism
   * beside it would give two answers to "is this slot money" — which is exactly
   * the drift that made the spreadsheet pay 59 slots where 31 were marked.
   *
   * ⚠️ Restoring sets `null`, NOT 'paid'. Null is undecided-and-payable, the
   * default state; 'paid' would override a genuine flag and quietly pay an hour
   * somebody was abroad for.
   *
   * ⚠️ It OVERWRITES per-slot calls, and that is what "blanket" means. A leader
   * who had ruled on individual hours and then flips the member switch has
   * replaced those rulings — the response says how many rows moved so the
   * sheet can say so too.
   */
  app.patch('/api/chain-events/:id/members/:memberId/eligibility', LEAD, async (req, reply) => {
    const p = req.params as { id: string; memberId: string }
    const body = (req.body ?? {}) as { eligible?: unknown }
    if (typeof body.eligible !== 'boolean') {
      return reply.status(400).send({ error: 'eligible must be true or false' })
    }
    const decision = body.eligible ? null : 'unpaid'
    const { rows } = await db.query(
      `UPDATE chain_watch_signups
          SET pay_decision = $3, decided_by = $4, decided_at = now()
        WHERE event_id = $1 AND member_id = $2 AND removed_at IS NULL
        RETURNING id`,
      [Number(p.id), p.memberId, decision, actor(req)])
    if (rows.length === 0) {
      return reply.status(404).send({ error: 'That member holds no slots on this event' })
    }
    return { member_id: p.memberId, eligible: body.eligible, slots_changed: rows.length }
  })

  app.delete('/api/chain-events/:id', LEAD, async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    const { rowCount } = await db.query('DELETE FROM chain_events WHERE id = $1', [id])
    if (!rowCount) return reply.status(404).send({ error: 'No such event' })
    return reply.status(204).send()
  })

  // ── Growing and shrinking the window ───────────────────────────────────────

  // ⚠️ Its own route, not a PATCH of `ends_at`. The event opens short (3 days)
  // and grows as the chain proves it has legs, so append is the most frequent
  // leadership action on the page. Letting the client compute the new boundary
  // and send an absolute timestamp is how two leaders clicking at once produce
  // a window that jumped two days or none.
  app.post('/api/chain-events/:id/days', LEAD, async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    const { rows } = await db.query(
      `UPDATE chain_events
          SET ends_at = ends_at + interval '24 hours', updated_by = $2, updated_at = now()
        WHERE id = $1 RETURNING *`, [id, actor(req)])
    if (!rows[0]) return reply.status(404).send({ error: 'No such event' })
    return rows[0]
  })

  app.delete('/api/chain-events/:id/days/last', LEAD, async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    const event = await loadEvent(db, id)
    if (!event) return reply.status(404).send({ error: 'No such event' })

    // ⚠️ The guard is HERE, not on the button. A client-side check reads the
    // grid and then deletes; somebody claiming an hour in that gap loses their
    // slot with no record of it. Leadership that really means it clears the
    // slots first, which is a visible act.
    const { rows: held } = await db.query(
      `SELECT s.hour_start, s.member_id, m.member_name
         FROM chain_watch_signups s
         LEFT JOIN members m ON m.member_id = s.member_id
        WHERE s.event_id = $1 AND s.removed_at IS NULL
          AND s.hour_start >= (SELECT ends_at - interval '24 hours' FROM chain_events WHERE id = $1)
        ORDER BY s.hour_start`, [id])
    if (held.length > 0) {
      return reply.status(409).send({
        error: 'The last day still has watchers on it',
        held: held.map((h) => ({
          hour_start: h.hour_start, member_id: h.member_id, member_name: h.member_name,
        })),
      })
    }

    const { rows } = await db.query(
      `UPDATE chain_events
          SET ends_at = ends_at - interval '24 hours', updated_by = $2, updated_at = now()
        WHERE id = $1 AND ends_at - interval '24 hours' > starts_at
        RETURNING *`, [id, actor(req)])
    if (!rows[0]) return reply.status(409).send({ error: 'An event cannot shrink below one day' })
    return rows[0]
  })

  // ── Sign-ups ───────────────────────────────────────────────────────────────

  /** Shared validation: the slot must exist, in an open event, on the hour. */
  /**
   * ⚠️ **The boundary is the hour's END, not its start.** Claiming the hour you
   * are currently in is legitimate — you are watching it. Claiming one that has
   * finished is not: nothing you do now can have covered it.
   *
   * ⚠️ **Leadership is exempt, deliberately** (MonChoon, 2026-10-01). Slots have
   * to be corrected after the fact — somebody watched but could not claim, or a
   * no-show needs removing. `created_by` and `created_at` already record who
   * did it and when, so the back-fill is auditable rather than invisible.
   *
   * ⚠️ Until this existed, ANY member could back-fill every elapsed hour of an
   * open event and be paid for each: `checkSlot` only asked whether the hour was
   * inside the event, and `is_payable` only asks whether it fell before the
   * chain ended — neither asked whether the claim came before the hour ran.
   */
  async function hourHasRun(hour: unknown) {
    const { rows } = await db.query(
      `SELECT $1::timestamptz + interval '1 hour' <= now() AS has_run`, [hour])
    return rows[0]?.has_run === true
  }

  async function checkSlot(reply: FastifyReply, id: number, hour: unknown, slot: number) {
    const event = await loadEvent(db, id)
    if (!event) return reply.status(404).send({ error: 'No such event' })
    if (event.status === 'closed') return reply.status(409).send({ error: 'Sign-ups are closed' })
    if (!Number.isInteger(slot) || slot < 0 || slot >= event.slots_per_hour) {
      return reply.status(400).send({ error: `slot_index must be 0..${event.slots_per_hour - 1}` })
    }
    const { rows } = await db.query(
      `SELECT $1::timestamptz = date_trunc('hour', $1::timestamptz) AS on_hour,
              $1::timestamptz >= starts_at AND $1::timestamptz < ends_at AS in_window
         FROM chain_events WHERE id = $2`, [hour, id])
    if (!rows[0]?.on_hour) return reply.status(400).send({ error: 'hour_start must be on the hour' })
    if (!rows[0]?.in_window) return reply.status(400).send({ error: 'hour_start is outside the event' })
    return null
  }

  app.post('/api/chain-events/:id/signups', MEMBER, async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    const b = (req.body ?? {}) as Record<string, unknown>
    const slot = Number(b.slot_index)
    const me = actor(req)

    // Naming somebody else is a leadership act; claiming for yourself is not.
    const target = b.member_id === undefined ? me : String(b.member_id)
    if (target !== me && !isLead(req)) {
      return reply.status(403).send({ error: 'Only leadership can sign up another member' })
    }

    const bad = await checkSlot(reply, id, b.hour_start, slot)
    if (bad) return bad

    if (!isLead(req) && await hourHasRun(b.hour_start)) {
      return reply.status(409).send({
        error: 'That hour has already finished — only leadership can change it now.',
      })
    }

    try {
      const { rows } = await db.query(
        `INSERT INTO chain_watch_signups (event_id, hour_start, slot_index, member_id, created_by)
         VALUES ($1, $2::timestamptz, $3, $4, $5) RETURNING *`,
        [id, b.hour_start, slot, target, me])
      return reply.status(201).send(rows[0])
    } catch (err) {
      const c = conflictFor(err)
      if (c) return reply.status(c.status).send({ error: c.error })
      throw err
    }
  })

  app.delete('/api/chain-events/:id/signups/:hour/:slot', MEMBER, async (req, reply) => {
    const p = req.params as { id: string; hour: string; slot: string }
    const id = Number(p.id)
    const hour = decodeURIComponent(p.hour)
    const reason = String(((req.body ?? {}) as { reason?: unknown }).reason ?? '').slice(0, REASON_MAX)
    const me = actor(req)

    const { rows: found } = await db.query(
      `SELECT s.id, s.member_id, s.hour_start <= now() AS started
         FROM chain_watch_signups s
        WHERE s.event_id = $1 AND s.hour_start = $2::timestamptz
          AND s.slot_index = $3 AND s.removed_at IS NULL`, [id, hour, Number(p.slot)])
    const row = found[0]
    if (!row) return reply.status(404).send({ error: 'Nobody holds that slot' })

    if (!isLead(req)) {
      if (row.member_id !== me) {
        return reply.status(403).send({ error: 'Only leadership can remove another member' })
      }
      // ⚠️ Dropping your own slot is always allowed UP TO the hour starting —
      // someone who knows at 22:00 that they will not make 04:00 must be able
      // to say so while there is still time to refill it. Forcing them to ask
      // a leader makes the silent no-show the path of least resistance, and a
      // silent no-show is what costs the chain.
      //
      // Once the hour has begun it is refused: you cannot un-work an hour, and
      // the slot is a payout record by then. Corrections go through leadership,
      // where they are attributed.
      if (row.started) {
        return reply.status(409).send({ error: 'That hour has already started — ask leadership' })
      }
    }

    const { rows } = await db.query(
      `UPDATE chain_watch_signups
          SET removed_at = now(), removed_by = $2, removed_reason = nullif($3, '')
        WHERE id = $1 RETURNING *`, [row.id, me, reason])
    return rows[0]
  })

  /**
   * A leader's answer to a flag (#773).
   *
   * ⚠️ The app never decides. #774 records what it saw — absent, absent while
   * the chain was at risk, abroad — and this is where the human's verdict
   * lands. `null` clears it back to undecided, which is not the same as
   * 'unpaid': an undecided flag still counts as payable, because the flag asks
   * a question rather than withholding money on its own.
   */
  app.patch('/api/chain-events/:id/signups/:hour/:slot/decision', LEAD, async (req, reply) => {
    const p = req.params as { id: string; hour: string; slot: string }
    const decision = ((req.body ?? {}) as { decision?: unknown }).decision ?? null
    if (decision !== null && decision !== 'paid' && decision !== 'unpaid') {
      return reply.status(400).send({ error: 'decision must be paid, unpaid or null' })
    }
    const { rows } = await db.query(
      `UPDATE chain_watch_signups
          SET pay_decision = $4, decided_by = $5,
              decided_at = CASE WHEN $4::text IS NULL THEN NULL ELSE now() END
        WHERE event_id = $1 AND hour_start = $2::timestamptz AND slot_index = $3
          AND removed_at IS NULL
        RETURNING *`,
      [Number(p.id), decodeURIComponent(p.hour), Number(p.slot), decision, actor(req)])
    if (!rows[0]) return reply.status(404).send({ error: 'Nobody holds that slot' })
    return rows[0]
  })

  // ⚠️ One call, one transaction. Remove-then-add leaves the slot briefly
  // empty, and a member refreshing at that moment can claim it out from under
  // the swap.
  app.put('/api/chain-events/:id/signups/:hour/:slot', LEAD, async (req, reply) => {
    const p = req.params as { id: string; hour: string; slot: string }
    const id = Number(p.id)
    const hour = decodeURIComponent(p.hour)
    const slot = Number(p.slot)
    const b = (req.body ?? {}) as Record<string, unknown>
    if (typeof b.member_id !== 'string') return reply.status(400).send({ error: 'member_id required' })

    const bad = await checkSlot(reply, id, hour, slot)
    if (bad) return bad

    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `UPDATE chain_watch_signups
            SET removed_at = now(), removed_by = $4, removed_reason = 'replaced'
          WHERE event_id = $1 AND hour_start = $2::timestamptz AND slot_index = $3
            AND removed_at IS NULL`, [id, hour, slot, actor(req)])
      const { rows } = await client.query(
        `INSERT INTO chain_watch_signups (event_id, hour_start, slot_index, member_id, created_by)
         VALUES ($1, $2::timestamptz, $3, $4, $5) RETURNING *`,
        [id, hour, slot, b.member_id, actor(req)])
      await client.query('COMMIT')
      return rows[0]
    } catch (err) {
      await client.query('ROLLBACK')
      const c = conflictFor(err)
      if (c) return reply.status(c.status).send({ error: c.error })
      throw err
    } finally {
      client.release()
    }
  })
}
