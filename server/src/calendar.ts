// Faction calendar (#395).
//
// One read endpoint returning RAW rows per source, and CRUD for the two things
// that have no other home. The normalising into a single event shape happens in
// `frontend/src/utils/calendarSources.js`, deliberately:
//
//   • Five wire formats meet here — epoch seconds, timestamptz, DATE, month/day
//     integers, and whatever Torn puts in `signup`. Normalising in SQL would
//     mean five casts nobody can test in isolation; normalising in pure
//     frontend adapters means a source is a function with a test file.
//   • The client still makes ONE request. Splitting the fetch per source was
//     the alternative and it is worse for both.
//
// Reads are open to any session, visitors included. Writes are leadership/admin
// — except a member's own birthday, which they own.
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { requireAuth, requireNotVisitor, requireRole } from './authz.js'
import { rolesFromClaims } from './auth.js'

const TITLE_MAX = 120
const NOTE_MAX = 1000
const SOURCES = new Set(['manual', 'torn_event'])
const RECURRENCES = new Set(['none', 'yearly'])

/** A window is required to be sane; a bad one is a 400, never a silent default. */
function parseWindow(query: unknown): { from: Date; to: Date } | null {
  const q = (query ?? {}) as { from?: string; to?: string }
  const now = Date.now()
  const from = q.from ? new Date(q.from) : new Date(now - 45 * 86_400_000)
  const to = q.to ? new Date(q.to) : new Date(now + 45 * 86_400_000)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null
  if (to <= from) return null
  // ⚠️ A ten-year window would expand ten occurrences of every recurring event
  // and scan every war we have ever fought. The grid never needs more than a
  // month at a time; this is the ceiling, not the expectation.
  if (to.getTime() - from.getTime() > 400 * 86_400_000) return null
  return { from, to }
}

export function registerCalendarRoutes(app: FastifyInstance, db: pg.Pool) {
  app.get('/api/calendar', { preHandler: requireAuth() }, async (req, reply) => {
    const win = parseWindow(req.query)
    if (!win) return reply.status(400).send({ error: 'invalid from/to window' })

    const fromIso = win.from.toISOString()
    const toIso = win.to.toISOString()
    const fromEpoch = Math.floor(win.from.getTime() / 1000)
    const toEpoch = Math.floor(win.to.getTime() / 1000)

    const [wars, competitions, payoutWeeks, events, birthdays, anniversaries] =
      await Promise.all([
        // Overlap, not containment: a war that started last month is still
        // being fought, and that is precisely when someone opens the calendar.
        //
        // ⚠️ `end_at IS NULL` means STILL RUNNING, so it must not collapse to
        // the start via COALESCE — that is the exact case this clause exists
        // for, and coalescing drops the war you are currently in.
        //
        // The `war_payouts` join is what puts an "RW Payout" marker on the
        // war's last day. ⚠️ It must stay a LEFT join reporting a nullable id:
        // a marker on every finished war would link to nothing for any war
        // leadership has not paid out yet, and one dead link teaches people to
        // stop trusting the ones that work.
        db.query(
          `SELECT w.id, w.start_at, w.end_at, w.opponent_id, w.opponent_name,
                  wp.id AS payout_id
             FROM ranked_wars w
             LEFT JOIN LATERAL (
               SELECT id FROM war_payouts WHERE war_id = w.id ORDER BY created_at DESC LIMIT 1
             ) wp ON true
            WHERE w.start_at <= $2 AND (w.end_at IS NULL OR w.end_at >= $1)
            ORDER BY w.start_at`,
          [fromEpoch, toEpoch]
        ),
        db.query(
          `SELECT id, name, window_start, window_end
             FROM competitions
            WHERE window_start IS NOT NULL
              AND window_start <= $2::timestamptz
              AND COALESCE(window_end, window_start) >= $1::timestamptz
            ORDER BY window_start`,
          [fromIso, toIso]
        ),
        // ⚠️ The window is widened by a day at the near end on purpose. The
        // calendar marks a payout week on `week_end + 1` (the day the money
        // moves), so a week that closed the day before the grid opens still
        // has its marker on the grid's first cell.
        db.query(
          `SELECT id, week_start, week_end
             FROM oc_payout_weeks
            WHERE week_start <= $2::date AND week_end >= ($1::date - 1)
            ORDER BY week_start`,
          [fromIso, toIso]
        ),
        // ⚠️ Recurring rows are fetched regardless of their own date. A yearly
        // entry created in 2024 is what makes December 2027 correct, and a
        // window filter on starts_at would drop exactly the rows recurrence
        // exists for.
        db.query(
          `SELECT id, source, title, note, starts_at, ends_at, recurrence, created_by, updated_at
             FROM calendar_events
            WHERE recurrence = 'yearly'
               OR (starts_at <= $2::timestamptz AND COALESCE(ends_at, starts_at) >= $1::timestamptz)
            ORDER BY starts_at`,
          [fromIso, toIso]
        ),
        db.query(
          `SELECT b.member_id, b.birth_month, b.birth_day, b.birth_year, m.member_name
             FROM member_birthdays b
             LEFT JOIN members m ON m.member_id = b.member_id
            WHERE m.is_current IS DISTINCT FROM false`
        ),
        // Torn account anniversaries, derived from the profile blob we already
        // snapshot daily — no new scraping, and no new consent surface, because
        // this is data we hold already.
        db.query(
          `SELECT DISTINCT ON (m.member_id)
                  m.member_id, m.member_name, s.profile->>'signup' AS signup
             FROM members m
             JOIN member_daily_stats s
               ON s.member_id = m.member_id AND s.profile ? 'signup'
            WHERE m.is_current = true
            ORDER BY m.member_id, s.snapshot_date DESC`
        ),
      ])

    return {
      from: fromIso,
      to: toIso,
      wars: wars.rows,
      competitions: competitions.rows,
      payout_weeks: payoutWeeks.rows,
      events: events.rows,
      birthdays: birthdays.rows,
      anniversaries: anniversaries.rows,
    }
  })

  /* ── Typed-in entries: manual and Torn's own events ────────────────────── */

  const readEventBody = (body: unknown) => {
    const b = (body ?? {}) as Record<string, unknown>
    const title = typeof b.title === 'string' ? b.title.trim() : ''
    const source = typeof b.source === 'string' ? b.source : 'manual'
    const recurrence = typeof b.recurrence === 'string' ? b.recurrence : 'none'
    const note = typeof b.note === 'string' && b.note.trim() !== '' ? b.note.trim() : null
    const startsAt = typeof b.starts_at === 'string' ? new Date(b.starts_at) : null
    const endsAt = typeof b.ends_at === 'string' && b.ends_at !== '' ? new Date(b.ends_at) : null

    if (title === '') return { error: 'title is required' as const }
    if (title.length > TITLE_MAX) return { error: `title too long (max ${TITLE_MAX})` as const }
    if (note && note.length > NOTE_MAX) return { error: `note too long (max ${NOTE_MAX})` as const }
    if (!SOURCES.has(source)) return { error: 'invalid source' as const }
    if (!RECURRENCES.has(recurrence)) return { error: 'invalid recurrence' as const }
    if (!startsAt || Number.isNaN(startsAt.getTime())) return { error: 'invalid starts_at' as const }
    if (endsAt && Number.isNaN(endsAt.getTime())) return { error: 'invalid ends_at' as const }
    // An end before its start is a typo, and stored it makes the event vanish
    // from every window filter rather than showing up wrong.
    if (endsAt && endsAt < startsAt) return { error: 'ends_at is before starts_at' as const }
    return { title, source, recurrence, note, startsAt, endsAt }
  }

  app.post(
    '/api/calendar/events',
    { preHandler: [requireNotVisitor(), requireRole('leadership', 'admin')] },
    async (req, reply) => {
      const parsed = readEventBody(req.body)
      if ('error' in parsed) return reply.status(400).send({ error: parsed.error })
      const who = String(req.session!.torn_user_id)
      const res = await db.query(
        `INSERT INTO calendar_events (source, title, note, starts_at, ends_at, recurrence, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
         RETURNING id, source, title, note, starts_at, ends_at, recurrence, created_by, updated_at`,
        [parsed.source, parsed.title, parsed.note, parsed.startsAt, parsed.endsAt, parsed.recurrence, who]
      )
      return reply.status(201).send(res.rows[0])
    }
  )

  app.put(
    '/api/calendar/events/:id',
    { preHandler: [requireNotVisitor(), requireRole('leadership', 'admin')] },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      if (!/^\d+$/.test(id)) return reply.status(400).send({ error: 'invalid id' })
      const parsed = readEventBody(req.body)
      if ('error' in parsed) return reply.status(400).send({ error: parsed.error })
      const res = await db.query(
        `UPDATE calendar_events
            SET source = $2, title = $3, note = $4, starts_at = $5, ends_at = $6,
                recurrence = $7, updated_by = $8, updated_at = now()
          WHERE id = $1
        RETURNING id, source, title, note, starts_at, ends_at, recurrence, created_by, updated_at`,
        [id, parsed.source, parsed.title, parsed.note, parsed.startsAt, parsed.endsAt,
         parsed.recurrence, String(req.session!.torn_user_id)]
      )
      if (res.rowCount === 0) return reply.status(404).send({ error: 'not found' })
      return res.rows[0]
    }
  )

  // ⚠️ Only rows in THIS table are deletable, and that is the point. Everything
  // else on the calendar is a view onto another table; a delete control there
  // would either do nothing or delete the war.
  app.delete(
    '/api/calendar/events/:id',
    { preHandler: [requireNotVisitor(), requireRole('leadership', 'admin')] },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      if (!/^\d+$/.test(id)) return reply.status(400).send({ error: 'invalid id' })
      const res = await db.query('DELETE FROM calendar_events WHERE id = $1', [id])
      if (res.rowCount === 0) return reply.status(404).send({ error: 'not found' })
      return { deleted: Number(id) }
    }
  )

  /* ── Real birthdays ────────────────────────────────────────────────────── */

  // Torn holds no date of birth anywhere, so this is typed in. Who may type it
  // is a privacy question, not a convenience one: a member owns their own, and
  // leadership can maintain the list for people who asked them to.
  const mayEditBirthday = (req: { session: any; params: unknown }) => {
    const memberId = (req.params as { memberId: string }).memberId
    const roles = rolesFromClaims(req.session)
    if (roles.includes('leadership') || roles.includes('admin')) return true
    return String(req.session.torn_user_id) === memberId
  }

  app.put(
    '/api/calendar/birthdays/:memberId',
    { preHandler: [requireNotVisitor()] },
    async (req, reply) => {
      const { memberId } = req.params as { memberId: string }
      if (!/^\d+$/.test(memberId)) return reply.status(400).send({ error: 'invalid member id' })
      if (!mayEditBirthday(req as any)) return reply.status(403).send({ error: 'Forbidden' })

      const b = (req.body ?? {}) as Record<string, unknown>
      const month = Number(b.birth_month)
      const day = Number(b.birth_day)
      // The year stays optional and separate. A faction needs the date, not
      // someone's age — asking for data you will not use is how you end up
      // holding data you should not have.
      const year = b.birth_year == null || b.birth_year === '' ? null : Number(b.birth_year)

      if (!Number.isInteger(month) || month < 1 || month > 12) {
        return reply.status(400).send({ error: 'birth_month must be 1-12' })
      }
      if (!Number.isInteger(day) || day < 1 || day > 31) {
        return reply.status(400).send({ error: 'birth_day must be 1-31' })
      }
      if (year !== null && (!Number.isInteger(year) || year < 1900 || year > 2100)) {
        return reply.status(400).send({ error: 'birth_year must be 1900-2100' })
      }
      // 31 February is a typo, and the CHECK constraints cannot catch it.
      const daysInMonth = new Date(Date.UTC(year ?? 2024, month, 0)).getUTCDate()
      if (day > daysInMonth) return reply.status(400).send({ error: 'that day does not exist in that month' })

      const res = await db.query(
        `INSERT INTO member_birthdays (member_id, birth_month, birth_day, birth_year, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (member_id) DO UPDATE SET
           birth_month = EXCLUDED.birth_month, birth_day = EXCLUDED.birth_day,
           birth_year = EXCLUDED.birth_year, updated_by = EXCLUDED.updated_by, updated_at = now()
         RETURNING member_id, birth_month, birth_day, birth_year, updated_at`,
        [memberId, month, day, year, String(req.session!.torn_user_id)]
      )
      return res.rows[0]
    }
  )

  // Withdrawal deletes. It does not hide.
  app.delete(
    '/api/calendar/birthdays/:memberId',
    { preHandler: [requireNotVisitor()] },
    async (req, reply) => {
      const { memberId } = req.params as { memberId: string }
      if (!/^\d+$/.test(memberId)) return reply.status(400).send({ error: 'invalid member id' })
      if (!mayEditBirthday(req as any)) return reply.status(403).send({ error: 'Forbidden' })
      await db.query('DELETE FROM member_birthdays WHERE member_id = $1', [memberId])
      return { deleted: memberId }
    }
  )
}
