// Signing up for Chain Watch from the Discord board (#1007, PRD #1006).
//
// Choonbot's Sign up / Drop my slot buttons land here. The bot works out WHO
// clicked from the `[id]` in their server nickname; everything else is decided
// here, by the same rules as the website's member sign-up.
//
// ⚠️ **The bot is trusted with identity and nothing else.** It sends a member id
// and an hour. Whether that id is on THIS faction's roster, whether the event is
// open, whether the hour has run, whether there is room — all of that is checked
// here, so a bot bug cannot sign up an outsider or back-fill a finished hour.
//
// ⚠️ **Every refusal carries a stable `code`.** The bot phrases the message for
// Discord; it must not parse English to decide what happened.
//
// ⚠️ **The member does not choose a slot number.** The first free one is
// assigned in the INSERT itself and a lost race is retried, so two people
// clicking the last place at once get one success and one `hour_full` — never
// two people in one slot (the unique index forbids it) and never a 500.
import type { FastifyInstance, FastifyReply } from 'fastify'
import type pg from 'pg'
import { bearerFrom, tokenMatches } from './fleetMetricsAuth.js'
import { notifyBoardChanged } from './chainWatchNotify.js'

export type SignupCode =
  | 'bad_request' | 'not_member' | 'no_event' | 'outside_event'
  | 'not_on_hour' | 'hour_finished' | 'already_signed_up' | 'hour_full'
  | 'not_signed_up' | 'hour_started'

const STATUS: Record<SignupCode, number> = {
  bad_request: 400,
  not_member: 403,
  no_event: 404,
  outside_event: 400,
  not_on_hour: 400,
  hour_finished: 409,
  already_signed_up: 409,
  hour_full: 409,
  not_signed_up: 404,
  hour_started: 409,
}

/** How many times a lost race for a slot is retried before calling it full. */
const SLOT_RACE_RETRIES = 3

function refuse(reply: FastifyReply, code: SignupCode, error: string) {
  return reply.status(STATUS[code]).send({ ok: false, code, error })
}

interface Body { member_id?: unknown; hour_start?: unknown }

/** `{member_id, hour_start}` with hour_start in epoch ms, or null. */
function parse(body: unknown): { memberId: string; hourIso: string } | null {
  const b = (body ?? {}) as Body
  const memberId = b.member_id == null ? '' : String(b.member_id).trim()
  const ms = Number(b.hour_start)
  if (!/^\d{1,10}$/.test(memberId) || !Number.isFinite(ms) || ms <= 0) return null
  return { memberId, hourIso: new Date(ms).toISOString() }
}

/**
 * The event the board is showing — open and not finished.
 *
 * ⚠️ The same choice `collectChainWatch` makes, so the button always acts on
 * the event whose hours the member is looking at.
 */
async function boardEvent(db: pg.Pool) {
  const { rows } = await db.query(
    `SELECT id, status, slots_per_hour FROM chain_events
      WHERE status = 'open' AND actually_ended_at IS NULL AND ends_at > now()
      ORDER BY starts_at LIMIT 1`)
  return rows[0] ?? null
}

async function isCurrentMember(db: pg.Pool, memberId: string) {
  const { rows } = await db.query(
    `SELECT member_name FROM members
      WHERE member_id = $1 AND is_current IS TRUE AND is_fallen IS NOT TRUE`, [memberId])
  return rows[0] ? { name: rows[0].member_name as string | null } : null
}

export function registerChainWatchSignupInternalRoutes(
  app: FastifyInstance, db: pg.Pool, expectedToken: string, factionSlug = '',
) {
  const authed = (authorization: string | undefined) => {
    const presented = bearerFrom(authorization)
    return presented !== null && tokenMatches(presented, expectedToken)
  }

  app.post('/api/internal/chain-watch/signups', async (req, reply) => {
    if (!authed(req.headers.authorization)) return reply.status(401).send({ error: 'Authentication required' })
    const p = parse(req.body)
    if (!p) return refuse(reply, 'bad_request', 'member_id and hour_start (epoch ms) are required')

    // ⚠️ Roster FIRST, before anything about the event is revealed: a member of
    // another faction pressing this board's button learns only that they are
    // not in it.
    const member = await isCurrentMember(db, p.memberId)
    if (!member) return refuse(reply, 'not_member', 'Not a current member of this faction')

    const event = await boardEvent(db)
    if (!event) return refuse(reply, 'no_event', 'There is no open Chain Watch event')

    const { rows: [hour] } = await db.query(
      `SELECT $1::timestamptz = date_trunc('hour', $1::timestamptz) AS on_hour,
              $1::timestamptz >= starts_at AND $1::timestamptz < ends_at AS in_window,
              $1::timestamptz + interval '1 hour' <= now() AS has_run
         FROM chain_events WHERE id = $2`, [p.hourIso, event.id])
    if (!hour?.on_hour) return refuse(reply, 'not_on_hour', 'hour_start must be on the hour')
    if (!hour.in_window) return refuse(reply, 'outside_event', 'That hour is outside the event')
    // The website's rule for members: the hour you are in is fine, a finished one is not.
    if (hour.has_run) return refuse(reply, 'hour_finished', 'That hour has already finished')

    for (let attempt = 0; attempt < SLOT_RACE_RETRIES; attempt++) {
      try {
        const { rows } = await db.query(
          `INSERT INTO chain_watch_signups (event_id, hour_start, slot_index, member_id, created_by, via)
           SELECT $1, $2::timestamptz, gs.i, $3, $3, 'discord'
             FROM generate_series(0, $4::int - 1) AS gs(i)
            WHERE NOT EXISTS (
              SELECT 1 FROM chain_watch_signups s
               WHERE s.event_id = $1 AND s.hour_start = $2::timestamptz
                 AND s.slot_index = gs.i AND s.removed_at IS NULL)
            ORDER BY gs.i LIMIT 1
           RETURNING id, slot_index, (extract(epoch FROM hour_start) * 1000)::bigint AS hour_start`,
          [event.id, p.hourIso, p.memberId, Number(event.slots_per_hour)])
        if (rows.length === 0) return refuse(reply, 'hour_full', 'Every place in that hour is taken')
        if (factionSlug) void notifyBoardChanged(factionSlug)
        return reply.status(201).send({
          ok: true,
          event_id: Number(event.id),
          hour_start: Number(rows[0].hour_start),
          slot_index: Number(rows[0].slot_index),
          member_name: member.name,
        })
      } catch (err) {
        const constraint = (err as { constraint?: string })?.constraint
        if (constraint === 'chain_watch_signups_member_hour_live') {
          return refuse(reply, 'already_signed_up', 'Already signed up for that hour')
        }
        // Somebody took the slot between our look and our insert: look again.
        if (constraint === 'chain_watch_signups_slot_live') continue
        throw err
      }
    }
    return refuse(reply, 'hour_full', 'Every place in that hour is taken')
  })

  app.post('/api/internal/chain-watch/signups/drop', async (req, reply) => {
    if (!authed(req.headers.authorization)) return reply.status(401).send({ error: 'Authentication required' })
    const p = parse(req.body)
    if (!p) return refuse(reply, 'bad_request', 'member_id and hour_start (epoch ms) are required')

    const member = await isCurrentMember(db, p.memberId)
    if (!member) return refuse(reply, 'not_member', 'Not a current member of this faction')

    const event = await boardEvent(db)
    if (!event) return refuse(reply, 'no_event', 'There is no open Chain Watch event')

    // ⚠️ The website's rule: your own slot, and only until the hour starts.
    // After that it is a payout record and corrections go through leadership.
    const { rows: [held] } = await db.query(
      `SELECT id, hour_start <= now() AS started
         FROM chain_watch_signups
        WHERE event_id = $1 AND hour_start = $2::timestamptz
          AND member_id = $3 AND removed_at IS NULL`, [event.id, p.hourIso, p.memberId])
    if (!held) return refuse(reply, 'not_signed_up', 'Not signed up for that hour')
    if (held.started) return refuse(reply, 'hour_started', 'That hour has already started — ask leadership')

    await db.query(
      `UPDATE chain_watch_signups
          SET removed_at = now(), removed_by = $2, removed_reason = 'Dropped from Discord'
        WHERE id = $1`, [held.id, p.memberId])
    if (factionSlug) void notifyBoardChanged(factionSlug)
    return { ok: true, event_id: Number(event.id), hour_start: Date.parse(p.hourIso) }
  })
}
