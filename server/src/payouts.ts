// Weekly OC payout flow: window reads for the calculator, saved-week reads,
// and the leadership-gated save (upsert week by window, replace member rows,
// link crimes) — same semantics the admin-db edge function had.
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { requireAuth, requireRole } from './authz.js'

const THREE_WEEKS_SECONDS = 604800 * 3

// Columns the client may set on oc_payout_weeks — everything else is server-stamped.
const WEEK_COLUMNS = new Set([
  'week_start', 'week_end', 'week_start_timestamp', 'week_end_timestamp',
  'total_money_reward', 'total_item_reward', 'total_item_cost', 'net_item_value',
  'faction_cut_percent', 'faction_cut_amount', 'member_payout_total',
  'total_member_payout', 'member_count', 'crimes_processed', 'total_time_spent',
  'average_time_spent', 'total_adjusted_tickets', 'total_time_spent_percent',
  'min_time_for_full_tickets', 'min_time_for_any_payout', 'payout_mode',
  // #871 — what the sheet showed at save time, so reopening it renders the
  // week that was PAID rather than re-pricing it at today's market.
  'item_breakdown', 'crime_values',
])
const MEMBER_COLUMNS = new Set([
  'member_id', 'member_name', 'tier', 'base_tickets', 'sit_out_penalty',
  'adjusted_tickets', 'time_spent', 'time_spent_percent', 'share_percent',
  // ⚠️ Ticket-qualifying time (0066) — see the migration. Without it a
  // reopened EQUAL week cannot work out who its participants were.
  'ticket_time_spent',
  'payout', 'theoretical_payout', 'crimes_count', 'crimes_participated',
  // ⚠️ Manual pay eligibility (0065). Persisted with the week so reopening a
  // saved payout shows the same decisions — otherwise a leader who withheld
  // somebody's pay, saved, and came back would find them paid again, with the
  // sheet's totals silently different from what was handed out.
  'is_eligible',
])

function pick(obj: Record<string, unknown>, allowed: Set<string>) {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => allowed.has(k)))
}

export function registerPayoutRoutes(app: FastifyInstance, db: pg.Pool) {
  app.get('/api/payouts/weeks', { preHandler: requireAuth() }, async (req) => {
    const q = req.query as { limit?: string; week_start?: string; week_end?: string }
    // Exact-window lookup (used to detect an already-saved week) — must not
    // be limited to the newest page.
    if (q.week_start && q.week_end) {
      const res = await db.query(
        'SELECT * FROM oc_payout_weeks WHERE week_start = $1 AND week_end = $2',
        [q.week_start, q.week_end]
      )
      return { weeks: res.rows }
    }
    const limit = clamp(q.limit, 20, 100)
    const res = await db.query(
      'SELECT * FROM oc_payout_weeks ORDER BY week_end DESC LIMIT $1',
      [limit]
    )
    return { weeks: res.rows }
  })

  app.get('/api/payouts/weeks/:id', { preHandler: requireAuth() }, async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!/^\d+$/.test(id)) return reply.status(404).send({ error: 'Payout week not found' })
    const res = await db.query('SELECT * FROM oc_payout_weeks WHERE id = $1', [id])
    if (res.rows.length === 0) return reply.status(404).send({ error: 'Payout week not found' })
    return { week: res.rows[0] }
  })

  // Delete a saved OC payout week: unlink its crimes (the FK forbids dropping
  // the week while they point at it), then remove its member rows and the week.
  // The self-hosted replacement for the old DataManagement single-delete tool.
  app.delete('/api/payouts/weeks/:id', { preHandler: [requireRole('leadership', 'admin')] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!/^\d+$/.test(id)) return reply.status(400).send({ error: 'valid payout week id required' })
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const existing = await client.query('SELECT id FROM oc_payout_weeks WHERE id = $1', [id])
      if (existing.rows.length === 0) {
        await client.query('ROLLBACK')
        return reply.status(404).send({ error: 'Payout week not found' })
      }
      await client.query('UPDATE crimes SET payout_week_id = NULL WHERE payout_week_id = $1', [id])
      await client.query('DELETE FROM oc_payout_members WHERE week_id = $1', [id])
      await client.query('DELETE FROM oc_payout_weeks WHERE id = $1', [id])
      await client.query('COMMIT')
      return { ok: true, deleted_week_id: Number(id) }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })

  app.get('/api/payouts/members', { preHandler: requireAuth() }, async () => {
    const res = await db.query(
      'SELECT * FROM oc_payout_members ORDER BY week_end DESC, payout DESC'
    )
    return { members: res.rows }
  })

  app.get('/api/payouts/weeks/:id/members', { preHandler: requireAuth() }, async (req) => {
    const { id } = req.params as { id: string }
    const res = await db.query(
      'SELECT * FROM oc_payout_members WHERE week_id = $1 ORDER BY payout DESC',
      [id]
    )
    return { members: res.rows }
  })

  /**
   * A saved payout week's crimes — WITH their slots (#391).
   *
   * Slots were omitted here, so the Crime Statistics panel reported
   * "0 participants" for every archived week and the expand showed "no data".
   * The live calculator path (/api/payouts/crime-data) always returned them,
   * which is why the panel worked while building a payout and broke the moment
   * you reopened one — i.e. exactly when someone is auditing who was in what.
   *
   * Slots are returned flat, keyed by crime_id, matching the live path's shape
   * so the client can share one shaper across both.
   *
   * user_name is resolved by joining `members`, NOT read straight off the slot:
   * Torn's faction/crimes payload gives a slot's user an id and no name, so
   * crime_slots.user_name is NULL for every row we hold. The live path hides
   * this by fetching the roster client-side and mapping ids to names; this
   * endpoint had no such join, so participants rendered as "User 4422276".
   * Same COALESCE as /api/crimes/:id/slots.
   */
  app.get('/api/payouts/weeks/:id/crimes', { preHandler: requireAuth() }, async (req) => {
    const { id } = req.params as { id: string }
    const res = await db.query(
      'SELECT * FROM crimes WHERE payout_week_id = $1 ORDER BY executed_at DESC',
      [id]
    )
    const crimeIds = res.rows.map((c: any) => c.crime_id)
    const slots = crimeIds.length > 0
      ? await db.query(
          // No is_current filter: a saved week is history, and its participants
          // have often left the faction since. `members` retains them.
          `SELECT s.*, COALESCE(s.user_name, m.member_name) AS user_name
             FROM crime_slots s
             LEFT JOIN members m ON m.member_id = s.user_id
            WHERE s.crime_id = ANY($1)`,
          [crimeIds]
        )
      : { rows: [] }
    return { crimes: res.rows, slots: slots.rows }
  })

  // The calculator's input: crimes relevant to a payout window (the four
  // categories the Sheets-era algorithm used) plus their slots and items.
  app.get('/api/payouts/crime-data', { preHandler: requireAuth() }, async (req, reply) => {
    const q = req.query as { from?: string; to?: string }
    const from = Number(q.from)
    const to = Number(q.to)
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      return reply.status(400).send({ error: 'from and to (unix seconds, to > from) are required' })
    }
    const lookbackFrom = from - THREE_WEEKS_SECONDS

    const crimes = await db.query(
      `SELECT DISTINCT ON (crime_id) * FROM (
         -- 1. executed within the window
         SELECT * FROM crimes WHERE executed_at >= $1 AND executed_at < $2
         UNION ALL
         -- 2. created in the 3-week lookback before the window
         SELECT * FROM crimes WHERE created_at >= $3 AND created_at < $1
         UNION ALL
         -- 3. still in progress
         SELECT * FROM crimes WHERE status IN ('Planning', 'Recruiting')
         UNION ALL
         -- 4. created inside the window but executed after it
         SELECT * FROM crimes WHERE created_at >= $1 AND created_at < $2 AND executed_at >= $2
       ) u ORDER BY crime_id`,
      [from, to, lookbackFrom]
    )
    const crimeIds = crimes.rows.map((c) => c.crime_id)

    // #168: left-early participation stints overlapping the window — time a
    // member banked in a crime they left before it executed, which the slot
    // rows (refilled by the next occupant) no longer show. `completed = false`
    // excludes crimes they finished; the window overlap is independent of the
    // crime union above so it catches crimes not otherwise in the payout set.
    const participation = await db.query(
      `SELECT p.crime_id, p.member_id, p.joined_at, p.left_at, c.name AS crime_name
       FROM crime_participation_v2 p
       JOIN crimes c ON c.crime_id = p.crime_id
       WHERE p.completed = false AND p.left_at IS NOT NULL
         AND p.joined_at < $2 AND p.left_at > $1`,
      [from, to]
    )

    // #389 part 2: observed occupancy stints overlapping the window, plus the
    // poll heartbeats that say whether we were watching.
    //
    // Independent of the crime union above, deliberately: a stint belongs to
    // the window if the member was IN a crime during it, regardless of whether
    // that crime is one the payout counts rewards for. The two questions —
    // "which crimes paid out" and "who was occupied when" — are different, and
    // conflating them is how the legacy path ended up deriving time from crime
    // status in the first place.
    const [occupancy, polls] = await Promise.all([
      db.query(
        `SELECT crime_id, member_id, position_id, torn_joined_at,
                first_seen_at, last_seen_at, closed
           FROM crime_occupancy
          WHERE COALESCE(torn_joined_at, first_seen_at) < $2 AND last_seen_at > $1
          ORDER BY member_id, first_seen_at`,
        [from, to]
      ),
      // Heartbeats only — the counters are diagnostics, and a week of
      // per-minute rows is 10k values the client would never look at.
      db.query(
        'SELECT polled_at FROM crime_occupancy_polls WHERE polled_at >= $1 AND polled_at <= $2 ORDER BY polled_at',
        [from, to]
      ),
    ])

    if (crimeIds.length === 0) {
      return {
        crimes: [], slots: [], reward_items: [], required_items: [],
        participation: participation.rows,
        occupancy: occupancy.rows,
        occupancy_polls: polls.rows,
      }
    }

    const [slots, rewards, required] = await Promise.all([
      db.query('SELECT * FROM crime_slots WHERE crime_id = ANY($1)', [crimeIds]),
      db.query('SELECT * FROM crime_reward_items WHERE crime_id = ANY($1)', [crimeIds]),
      db.query('SELECT * FROM crime_required_items WHERE crime_id = ANY($1)', [crimeIds]),
    ])
    return {
      crimes: crimes.rows,
      slots: slots.rows,
      reward_items: rewards.rows,
      required_items: required.rows,
      participation: participation.rows,
      occupancy: occupancy.rows,
      occupancy_polls: polls.rows,
    }
  })

  // Item name/price lookup for the payout item breakdown.
  app.get('/api/items/lookup', { preHandler: requireAuth() }, async (req, reply) => {
    const raw = (req.query as { ids?: string }).ids ?? ''
    const ids = raw.split(',').map((s) => s.trim()).filter((s) => /^\d+$/.test(s))
    if (ids.length === 0) return reply.status(400).send({ error: 'ids (comma-separated item ids) is required' })
    const [items, inventoryPrices] = await Promise.all([
      db.query('SELECT id, name, sell_price, market_price FROM items WHERE id = ANY($1::int[]) ORDER BY id', [ids]),
      db.query(
        'SELECT item_id, weighted_avg_price FROM inventory_items_with_prices WHERE item_id = ANY($1) ORDER BY item_id',
        [ids]
      ),
    ])
    return { items: items.rows, inventory_prices: inventoryPrices.rows }
  })

  // Item name search for the competition prize picker (#241): up to ~20
  // catalogue matches by name (ILIKE), auth-gated. Empty query → no results.
  app.get('/api/items/search', { preHandler: requireAuth() }, async (req) => {
    const q = ((req.query as { q?: string }).q ?? '').trim()
    if (!q) return { items: [] }
    const rows = await db.query(
      'SELECT id, name, market_price FROM items WHERE name ILIKE $1 ORDER BY name LIMIT 20',
      [`%${q}%`]
    )
    return { items: rows.rows }
  })

  // Full member rows + all CPR rows: the calculator's roster input.
  app.get('/api/members/with-cpr', { preHandler: requireAuth() }, async () => {
    const [members, cpr] = await Promise.all([
      db.query('SELECT * FROM members ORDER BY member_id'),
      db.query('SELECT member_id, crime_name, position_label, difficulty, cpr_value FROM member_cpr_v2'),
    ])
    return { members: members.rows, cpr: cpr.rows }
  })

  // Save a computed payout week. Visitors get the explicit read-only message
  // (they can run the whole flow, only the save is blocked); everyone else
  // needs leadership/admin.
  app.post('/api/payouts/weeks', { preHandler: [requireRole('leadership', 'admin')] }, async (req, reply) => {
    const body = req.body as { week?: Record<string, unknown>; members?: Record<string, unknown>[]; crime_ids?: string[] } | null
    if (!body?.week || !Array.isArray(body.members) || body.members.length === 0) {
      return reply.status(400).send({ error: 'week and members are required' })
    }
    const savedBy = req.session!.torn_user_id
    const crimeIds = Array.isArray(body.crime_ids) ? body.crime_ids.map(String) : []
    // crime_ids on the week row is server-stamped from the ids actually
    // linked below, so the two can never disagree.
    const week = { ...pick(body.week, WEEK_COLUMNS), crime_ids: crimeIds }
    if (!week.week_start || !week.week_end) {
      return reply.status(400).send({ error: 'week.week_start and week.week_end are required' })
    }
    for (const raw of body.members) {
      const m = pick(raw, MEMBER_COLUMNS)
      if (!m.member_id || !m.member_name || m.tier == null) {
        return reply.status(400).send({ error: 'each member requires member_id, member_name, and tier' })
      }
    }

    const client = await db.connect()
    try {
      await client.query('BEGIN')

      const existing = await client.query(
        'SELECT id FROM oc_payout_weeks WHERE week_start = $1 AND week_end = $2',
        [week.week_start, week.week_end]
      )

      const weekCols = Object.keys(week)
      let weekId: number
      if (existing.rows.length > 0) {
        weekId = existing.rows[0].id
        const sets = weekCols.map((c, i) => `"${c}" = $${i + 1}`).join(', ')
        await client.query(
          `UPDATE oc_payout_weeks SET ${sets}, saved_by = $${weekCols.length + 1},
                  saved_at = now(), updated_at = now()
           WHERE id = $${weekCols.length + 2}`,
          [...weekCols.map((c) => week[c]), savedBy, weekId]
        )
        await client.query('DELETE FROM oc_payout_members WHERE week_id = $1', [weekId])
      } else {
        const placeholders = weekCols.map((_, i) => `$${i + 1}`).join(', ')
        const inserted = await client.query(
          `INSERT INTO oc_payout_weeks (${weekCols.map((c) => `"${c}"`).join(', ')}, saved_by, saved_at, updated_at)
           VALUES (${placeholders}, $${weekCols.length + 1}, now(), now())
           RETURNING id`,
          [...weekCols.map((c) => week[c]), savedBy]
        )
        weekId = inserted.rows[0].id
      }

      for (const raw of body.members) {
        const m = pick(raw, MEMBER_COLUMNS)
        const cols = ['week_id', 'week_start', 'week_end', ...Object.keys(m)]
        const vals = [weekId, week.week_start, week.week_end, ...Object.keys(m).map((c) => m[c])]
        await client.query(
          `INSERT INTO oc_payout_members (${cols.map((c) => `"${c}"`).join(', ')})
           VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
          vals
        )
      }

      if (crimeIds.length > 0) {
        await client.query('UPDATE crimes SET payout_week_id = $1 WHERE crime_id = ANY($2)', [weekId, crimeIds])
      }

      await client.query('COMMIT')
      return { week_id: weekId, member_count: body.members.length }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })
}

function clamp(raw: string | undefined, fallback: number, max: number): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) return fallback
  return Math.min(n, max)
}
