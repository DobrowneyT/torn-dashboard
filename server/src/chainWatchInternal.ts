// The Discord bot's view of Chain Watch (#782, part of #775).
//
// One read-only endpoint, polled by `torn-discord-bot`, so the board in Discord
// and the page at /members/chain-watch are the same facts.
//
// ⚠️ **Nothing is derived here that is not already derived elsewhere.** The
// projection comes from `projectChain`, the horizon from `chainHorizon`, the
// travel state from the same `member_activity_samples` series the flags read.
// Two implementations of "is this slot at risk" will drift, and the one that
// drifts is the one nobody is looking at — the whole reason #775 asks for one
// endpoint rather than letting the bot assemble its own picture.
//
// ⚠️ **Time leaves here as epoch milliseconds, never as a timestamp string.**
// Postgres serves timestamptz with a bare two-digit offset ("...-05") which
// `new Date` parses to NaN — the #140 trap, which I already walked into once
// inside chainWatch.ts. Python is not immune either: `datetime.fromisoformat`
// rejects a bare two-digit offset outright on older runtimes. A number crosses
// both boundaries intact.
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { bearerFrom, tokenMatches } from './fleetMetricsAuth.js'
import { projectChain, CHAIN_TARGET, type ChainReading } from './chain/chainProjection.js'
import { GAP_HORIZON_HOURS } from './chain/chainHorizon.js'
import { isAway, isTravelling } from './chain/travelLatch.js'

/**
 * How far ahead the board looks.
 *
 * ⚠️ Not the gap horizon. The board shows a day so somebody can plan around it;
 * the horizon is the much shorter window an EMPTY slot is worth a ping about.
 * Conflating them either spams the channel with tomorrow's gaps or hides the
 * board's afternoon.
 */
export const BOARD_HORIZON_HOURS = 24

/** Hours of history kept on the board, so a just-finished shift is still visible. */
export const BOARD_LOOKBACK_HOURS = 1

const HOUR_MS = 3600_000

export interface TravelView {
  state: string
  description: string | null
  destination: string | null
  /** Torn's own plane sprite — the bot maps this to a flight class. */
  plane_image_type: string | null
  /**
   * When we witnessed take-off, or null when we did not.
   *
   * ⚠️ Null is load-bearing and is NOT "they just left". Torn publishes no
   * arrival time for a traveller, so every ETA counts from a departure we had
   * to see ourselves; `latchDeparture` returns null when the previous sample
   * was too old to trust the edge (#774, rule from #330). The bot must render
   * "in the air, arrival unknown" rather than computing from `now` — a
   * confidently wrong arrival time is worse than an absent one, because a lead
   * waits on it.
   */
  departed_at: number | null
}

export interface WatcherView {
  member_id: string
  name: string | null
  travel: TravelView | null
}

export interface MemberView {
  member_id: string
  name: string
}

export interface HourView {
  hour_start: number
  bonus: boolean
  slots_per_hour: number
  watchers: WatcherView[]
  /** Empty slots on this hour — `slots_per_hour` minus the live sign-ups. */
  open_slots: number
}

/**
 * The newest activity sample per member, which is where travel state lives.
 *
 * ⚠️ `DISTINCT ON` rather than a max/join: the series is append-only and a
 * member has one row per sweep, so the newest row IS the current state. Joining
 * on `max(sampled_at)` would duplicate a member sampled twice in the same
 * millisecond, and duplicate watchers on a board read as two people covering an
 * hour that one person is covering.
 */
const LATEST_ACTIVITY = `
  SELECT DISTINCT ON (member_id)
         member_id, status_state, status_description, plane_image_type,
         (extract(epoch from travel_departed_at) * 1000)::bigint AS departed_ms
    FROM member_activity_samples
   ORDER BY member_id, sampled_at DESC`

/**
 * Where this member is headed, from Torn's own status text.
 *
 * ⚠️ **Torn writes "Traveling from Torn to UAE", not "Traveling to UAE".**
 * This was written against the second form, which Torn never sends, so every
 * traveller rendered as "somewhere" on the board — and it looked like a data
 * problem rather than a parsing one. Observed forms, from live `/v2/faction/members`:
 *
 *     Traveling from Torn to UAE            → UAE       (outbound)
 *     Traveling from UAE to Torn            → Torn      (coming home)
 *     Traveling from Torn to South Africa   → South Africa
 *     In Switzerland                        → Switzerland (landed)
 *
 * ⚠️ On the way home the destination is **Torn**, not the country being left.
 * Reporting the country would tell a lead somebody is flying OUT at the exact
 * moment they are flying back in. (The country still matters for the flight
 * TIME, which is the bot's job and reads `description` itself.)
 */
export function destinationFrom(description: string | null | undefined): string | null {
  if (!description) return null
  const leg = /Traveling from\s+(.+?)\s+to\s+(.+)$/i.exec(description)
  if (leg) return leg[2].trim()
  const abroad = /^In\s+(.+)$/i.exec(description.trim())
  if (abroad) return abroad[1].trim()
  // Older/other phrasings, kept because they cost nothing and a silent null
  // here is a board that says "somewhere".
  const to = /Traveling to\s+(.+)$/i.exec(description)
  if (to) return to[1].trim()
  if (/Returning to Torn/i.test(description)) return 'Torn'
  return null
}

function travelViewFor(row: {
  status_state: string | null
  status_description: string | null
  plane_image_type: string | null
  departed_ms: string | null
} | undefined): TravelView | null {
  if (!row || !isAway(row.status_state)) return null
  return {
    state: row.status_state as string,
    description: row.status_description ?? null,
    destination: destinationFrom(row.status_description),
    // Only meaningful mid-flight; someone already Abroad has landed.
    plane_image_type: isTravelling(row.status_state) ? (row.plane_image_type ?? null) : null,
    departed_at: isTravelling(row.status_state) && row.departed_ms != null
      ? Number(row.departed_ms)
      : null,
  }
}

/**
 * Build the whole payload.
 *
 * Exported so it can be tested without standing up auth, and so the shape has
 * exactly one author.
 */
export async function collectChainWatch(db: pg.Pool, nowMs: number = Date.now()) {
  const memberView = (r: { member_id: string; member_name: string }): MemberView =>
    ({ member_id: r.member_id, name: r.member_name })

  // ⚠️ The roster, for the bot's identity auto-match (#784) — NOT for the board.
  //
  // Without it the only link the bot can make is a Discord nickname that
  // literally contains "Name [123456]", and everyone else falls to the manual
  // `/chain link` escape hatch. Linking ~100 people by hand is the chore that
  // does not get done, and a half-populated map produces pings that reach some
  // people and not others — worse than none, because nobody can tell which.
  //
  // ⚠️ Current members only. A member who left should stop being pinged; the
  // bot keeps their LINK (people rejoin) but must not treat them as roster.
  // Nothing here is new exposure: these ids and names already ride in
  // `hours[].watchers`, and both are public Torn data.
  const { rows: roster } = await db.query(
    `SELECT member_id, member_name
       FROM members
      WHERE is_current IS TRUE AND member_name IS NOT NULL
      ORDER BY member_name`)

  // The event the bot should be talking about: open, and not yet finished.
  // ⚠️ `actually_ended_at` wins over the planned end. A chain that hit 100k on
  // day nine of a twelve-day sheet must go quiet immediately — an empty-slot
  // ping for an event that is over wakes somebody at 3am for nothing, which is
  // how a channel learns to mute the bot.
  const { rows: events } = await db.query(
    `SELECT id, title, slots_per_hour, payout_per_slot, bonus_hours,
            bonus_multiplier, bonus_applies_to, status,
            (extract(epoch from starts_at) * 1000)::bigint          AS starts_ms,
            (extract(epoch from ends_at) * 1000)::bigint            AS ends_ms,
            (extract(epoch from actually_ended_at) * 1000)::bigint  AS ended_ms
       FROM chain_events
      WHERE status = 'open'
        AND actually_ended_at IS NULL
        AND ends_at > $1::timestamptz
      ORDER BY starts_at
      LIMIT 1`,
    [new Date(nowMs).toISOString()])

  const event = events[0]
  // ⚠️ A 200 with a null event, never a 404. "Nothing is running" is a normal
  // answer most of the year; an error status would look like an outage and put
  // the bot into a retry loop over a question that was answered correctly.
  if (!event) {
    return {
      server_now: nowMs,
      event: null,
      chain: null,
      projection: null,
      gap_horizon_hours: GAP_HORIZON_HOURS,
      hours: [] as HourView[],
      // ⚠️ Served even with no event running. The identity map is standing
      // state, not per-event — a bot booting in the quiet season should still
      // be able to link people, so the first chain of the year does not begin
      // with an empty map and pings that reach nobody.
      members: roster.map(memberView),
    }
  }

  const from = Math.floor(nowMs / HOUR_MS) * HOUR_MS - BOARD_LOOKBACK_HOURS * HOUR_MS
  const to = Math.floor(nowMs / HOUR_MS) * HOUR_MS + BOARD_HORIZON_HOURS * HOUR_MS

  const { rows: signups } = await db.query(
    `SELECT (extract(epoch from s.hour_start) * 1000)::bigint AS hour_ms,
            s.slot_index, s.member_id, m.member_name,
            (extract(hour from s.hour_start at time zone 'UTC')::int
               = ANY (e.bonus_hours)) AS is_bonus,
            a.status_state, a.status_description, a.plane_image_type, a.departed_ms
       FROM chain_watch_signups s
       JOIN chain_events e ON e.id = s.event_id
       LEFT JOIN members m ON m.member_id = s.member_id
       LEFT JOIN (${LATEST_ACTIVITY}) a ON a.member_id = s.member_id
      WHERE s.event_id = $1 AND s.removed_at IS NULL
        AND s.hour_start >= $2::timestamptz AND s.hour_start < $3::timestamptz
      ORDER BY s.hour_start, s.slot_index`,
    [event.id, new Date(from).toISOString(), new Date(to).toISOString()])

  const slotsPerHour = Number(event.slots_per_hour)
  const bonusHours: number[] = event.bonus_hours ?? []
  const byHour = new Map<number, WatcherView[]>()
  for (const r of signups) {
    const hour = Number(r.hour_ms)
    if (!byHour.has(hour)) byHour.set(hour, [])
    byHour.get(hour)!.push({
      member_id: r.member_id,
      name: r.member_name ?? null,
      travel: travelViewFor(r),
    })
  }

  // ⚠️ Every hour in the window, including the ones nobody signed up for.
  // Emitting only hours that HAVE sign-ups would make a completely empty 3am —
  // the single most important thing on the board — indistinguishable from an
  // hour outside the event. The gaps are the payload.
  const startMs = Number(event.starts_ms)
  const endMs = Number(event.ends_ms)
  const hours: HourView[] = []
  for (let t = Math.max(from, startMs); t < Math.min(to, endMs); t += HOUR_MS) {
    const watchers = byHour.get(t) ?? []
    hours.push({
      hour_start: t,
      // ⚠️ Derived from the event's CURRENT bonus_hours, never stamped at
      // sign-up — the spreadsheet froze its bonus into a column position and
      // paid 28 slots nobody intended (#771).
      bonus: bonusHours.includes(new Date(t).getUTCHours()),
      slots_per_hour: slotsPerHour,
      watchers,
      open_slots: Math.max(0, slotsPerHour - watchers.length),
    })
  }

  const { rows: latestChain } = await db.query(
    `SELECT chain_current, (extract(epoch from sampled_at) * 1000)::bigint AS at
       FROM chain_samples
      WHERE chain_current IS NOT NULL
      ORDER BY sampled_at DESC
      LIMIT 1`)

  const { rows: readings } = await db.query(
    `SELECT chain, extract(epoch from to_timestamp(started)) * 1000 AS at
       FROM faction_attacks
      WHERE chain IS NOT NULL AND started IS NOT NULL
        AND to_timestamp(started) >= $1::timestamptz
      ORDER BY started`,
    [new Date(startMs).toISOString()])

  return {
    server_now: nowMs,
    event: {
      id: event.id,
      title: event.title,
      slots_per_hour: slotsPerHour,
      payout_per_slot: Number(event.payout_per_slot),
      starts_at: startMs,
      ends_at: endMs,
      actually_ended_at: event.ended_ms == null ? null : Number(event.ended_ms),
      bonus_hours: bonusHours,
      bonus_multiplier: Number(event.bonus_multiplier),
      bonus_applies_to: event.bonus_applies_to,
      status: event.status,
    },
    chain: latestChain[0]
      ? {
          current: Number(latestChain[0].chain_current),
          target: CHAIN_TARGET,
          at: Number(latestChain[0].at),
        }
      : null,
    // ⚠️ A band with a `measured` flag, passed through untouched — including
    // `measured: false` and its reason. An eleven-day projection stated to the
    // hour is false precision somebody will plan around, so the bot is handed
    // the uncertainty rather than a number it would render as fact.
    projection: projectChain(
      readings.map((r): ChainReading => ({ chain: Number(r.chain), at: Number(r.at) })),
      nowMs),
    gap_horizon_hours: GAP_HORIZON_HOURS,
    hours,
    members: roster.map(memberView),
  }
}

export function registerChainWatchInternalRoutes(
  app: FastifyInstance, db: pg.Pool, expectedToken: string,
) {
  app.get('/api/internal/chain-watch', async (req, reply) => {
    const presented = bearerFrom(req.headers.authorization)
    // ⚠️ One message for a missing token and a wrong one, matching
    // /api/internal/fleet-metrics. Distinguishing them tells a prober which
    // half they have already solved. `tokenMatches` length-checks before
    // timingSafeEqual, which throws on a length mismatch — so a short token
    // returns 401 here rather than 500, and 500-vs-401 is itself an oracle.
    if (presented === null || !tokenMatches(presented, expectedToken)) {
      return reply.status(401).send({ error: 'Authentication required' })
    }
    return collectChainWatch(db)
  })
}
