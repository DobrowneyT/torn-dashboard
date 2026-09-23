// #782 — the Discord bot's read endpoint (part of #775).
//
// What these tests are really defending is that the bot and the page cannot
// disagree. The Google Sheet was replaced because it drifted from reality; a
// Discord board that drifts from the dashboard is the same failure wearing a
// different hat, and worse, because the channel is where leadership looks.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'
import { deriveTenantToken } from '../src/fleetMetricsAuth.js'
import { chainWatchScope } from '../../db/chainWatchTokenLib.mjs'
import { collectChainWatch, destinationFrom, BOARD_HORIZON_HOURS } from '../src/chainWatchInternal.js'
import { GAP_HORIZON_HOURS } from '../src/chain/chainHorizon.js'

const FLEET_SECRET = 'chain-watch-secret-for-tests'
const TOKEN = deriveTenantToken(FLEET_SECRET, chainWatchScope(TEST_FACTION.slug))
const HOUR = 3600_000

let stack: TestStack

/**
 * ⚠️ Anchored to the REAL clock, not a fixed date.
 *
 * The route calls collectChainWatch() with Date.now(), and the board window is
 * relative to it — so a fixture pinned to 2027 lands entirely outside the
 * window and every hour lookup silently returns undefined. (It did, for seven
 * of these tests, before this comment existed.) Unlike the sign-up routes there
 * is no "that hour has already started" guard to dodge here: this endpoint only
 * reads.
 */
const NOW = Date.now()
const top = (h: number) => NOW - (NOW % HOUR) + h * HOUR

async function get(token: string | null) {
  const res = await fetch(`${stack.baseUrl}/api/internal/chain-watch`, {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

async function makeEvent(over: Record<string, unknown> = {}) {
  await stack.db.query('DELETE FROM chain_watch_signups')
  await stack.db.query('DELETE FROM chain_events')
  const cols = {
    title: 'Halloween 100k Chain',
    starts_at: new Date(top(-2)).toISOString(),
    ends_at: new Date(top(40)).toISOString(),
    slots_per_hour: 2,
    bonus_hours: '{5,6}',
    status: 'open',
    ...over,
  } as Record<string, unknown>
  const keys = Object.keys(cols)
  const { rows } = await stack.db.query(
    `INSERT INTO chain_events (${keys.join(',')})
     VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
    keys.map((k) => cols[k]))
  return rows[0].id as number
}

async function signUp(eventId: number, hourMs: number, slot: number, memberId: string) {
  await stack.db.query(
    `INSERT INTO chain_watch_signups (event_id, hour_start, slot_index, member_id, created_by)
     VALUES ($1, $2::timestamptz, $3, $4, $4)`,
    [eventId, new Date(hourMs).toISOString(), slot, memberId])
}

beforeAll(async () => {
  stack = await startTestStack(undefined, {}, { chainWatchToken: TOKEN })
  await stack.db.query(`
    INSERT INTO members (member_id, member_name, tier, is_current) VALUES
      ('7001', 'Goosey', 3, true), ('7002', 'Muttley', 3, true),
      ('7003', 'CalliBee', 3, true)
    ON CONFLICT (member_id) DO NOTHING`)
}, 60000)

afterAll(async () => { await stack?.close() })

describe('auth', () => {
  it('serves the payload with the tenant token', async () => {
    await makeEvent()
    expect((await get(TOKEN)).status).toBe(200)
  })

  it('401s with no token, a wrong token, and a token for another faction', async () => {
    expect((await get(null)).status).toBe(401)
    expect((await get('f'.repeat(64))).status).toBe(401)
    // ⚠️ The scoping is the whole security argument for a second token.
    expect((await get(deriveTenantToken(FLEET_SECRET, chainWatchScope('someone-else')))).status).toBe(401)
  })

  it('⚠️ 401s on a SHORT token rather than 500ing', async () => {
    // timingSafeEqual throws on a length mismatch, so an unguarded compare
    // answers 500 here — and 500-vs-401 is itself an oracle telling a prober
    // their guess was the wrong LENGTH, which is a free bit.
    expect((await get('abc')).status).toBe(401)
    expect((await get('')).status).toBe(401)
  })

  it('⚠️ is NOT the fleet-metrics token', async () => {
    // Same secret, different scope. If these ever matched, handing the bot a
    // chain-watch token would hand it key-pool depth as well.
    expect((await get(deriveTenantToken(FLEET_SECRET, TEST_FACTION.slug))).status).toBe(401)
  })
})

describe('the payload', () => {
  it('carries the event, the horizon, and every hour in the window', async () => {
    const id = await makeEvent()
    await signUp(id, top(1), 0, '7001')
    await signUp(id, top(1), 1, '7002')
    const { body } = await get(TOKEN)

    expect(body.event.title).toBe('Halloween 100k Chain')
    expect(body.event.slots_per_hour).toBe(2)
    // ⚠️ The bot is forbidden its own copy of this (#785); if it stops being
    // served, the board and the page start disagreeing about "soon".
    expect(body.gap_horizon_hours).toBe(GAP_HORIZON_HOURS)
    expect(typeof body.server_now).toBe('number')

    const hour = body.hours.find((h: any) => h.hour_start === top(1))
    expect(hour.watchers.map((w: any) => w.name).sort()).toEqual(['Goosey', 'Muttley'])
    expect(hour.open_slots).toBe(0)
  })

  it('⚠️ emits hours NOBODY signed up for — the gaps are the payload', async () => {
    const id = await makeEvent()
    await signUp(id, top(1), 0, '7001')
    const { body } = await get(TOKEN)
    // Only-hours-with-signups would make a naked 3am indistinguishable from an
    // hour outside the event, which is the one thing the board exists to show.
    const naked = body.hours.find((h: any) => h.hour_start === top(3))
    expect(naked).toBeTruthy()
    expect(naked.watchers).toEqual([])
    expect(naked.open_slots).toBe(2)
    // and a half-covered hour reports the hole, not just the person
    expect(body.hours.find((h: any) => h.hour_start === top(1)).open_slots).toBe(1)
  })

  it('⚠️ returns every time as a NUMBER, never a timestamp string', async () => {
    // The #140 trap, which already bit chainWatch.ts once: Postgres serves
    // timestamptz with a bare two-digit offset that new Date() reads as NaN,
    // and Python's fromisoformat rejects outright. A number crosses both.
    const id = await makeEvent()
    await signUp(id, top(1), 0, '7001')
    const { body } = await get(TOKEN)
    for (const k of ['starts_at', 'ends_at']) {
      expect(typeof body.event[k]).toBe('number')
      expect(Number.isNaN(body.event[k])).toBe(false)
    }
    for (const h of body.hours) {
      expect(typeof h.hour_start).toBe('number')
      expect(Number.isNaN(h.hour_start)).toBe(false)
    }
  })

  it('derives the bonus from the event\'s CURRENT bonus_hours', async () => {
    // Stamped-at-signup is how the spreadsheet paid 28 slots nobody intended.
    const id = await makeEvent({ bonus_hours: '{5,6}' })
    await stack.db.query('UPDATE chain_events SET bonus_hours = $1 WHERE id = $2', ['{14}', id])
    const { body } = await get(TOKEN)
    const bonus = body.hours.filter((h: any) => h.bonus).map((h: any) => new Date(h.hour_start).getUTCHours())
    // ⚠️ Assert it actually found one. A 25-hour window always contains 14:00
    // UTC, so an empty result here means the filter matched nothing and the
    // Set comparison would still have to be wrong to notice.
    expect(bonus.length).toBeGreaterThan(0)
    expect(new Set(bonus)).toEqual(new Set([14]))
  })

  it('stops at the board horizon rather than serving the whole twelve days', async () => {
    await makeEvent({ ends_at: new Date(top(500)).toISOString() })
    const { body } = await get(TOKEN)
    expect(body.hours.length).toBeLessThanOrEqual(BOARD_HORIZON_HOURS + 2)
  })
})

describe('when nothing is running', () => {
  it('⚠️ answers 200 with a null event, never a 404', async () => {
    // "Nothing is running" is the correct answer most of the year. A 404 looks
    // like an outage and puts the bot into a retry loop over a right answer.
    await stack.db.query('DELETE FROM chain_watch_signups')
    await stack.db.query('DELETE FROM chain_events')
    const { status, body } = await get(TOKEN)
    expect(status).toBe(200)
    expect(body.event).toBeNull()
    expect(body.hours).toEqual([])
    // ⚠️ Still served, so a bot booting during the quiet season does not fall
    // back to a hardcoded horizon it would then keep using.
    expect(body.gap_horizon_hours).toBe(GAP_HORIZON_HOURS)
  })

  it('⚠️ goes quiet the moment the chain actually ends', async () => {
    // The sheet was built for twelve days and the chain finished on day nine.
    // An empty-slot ping for an event that is over wakes somebody at 3am for
    // nothing, and that is how a channel learns to mute the bot.
    const id = await makeEvent()
    await signUp(id, top(1), 0, '7001')
    expect((await get(TOKEN)).body.event).not.toBeNull()
    await stack.db.query(
      'UPDATE chain_events SET actually_ended_at = now() WHERE id = $1', [id])
    expect((await get(TOKEN)).body.event).toBeNull()
  })

  it('ignores a draft event', async () => {
    await makeEvent({ status: 'draft' })
    expect((await get(TOKEN)).body.event).toBeNull()
  })
})

describe('travel', () => {
  async function sample(memberId: string, state: string, opts: {
    description?: string; plane?: string; departedAt?: number | null
  } = {}) {
    await stack.db.query(
      `INSERT INTO member_activity_samples
         (member_id, sampled_at, status_state, status_description, plane_image_type, travel_departed_at)
       VALUES ($1, now(), $2, $3, $4, $5::timestamptz)`,
      [memberId, state, opts.description ?? null, opts.plane ?? null,
       opts.departedAt == null ? null : new Date(opts.departedAt).toISOString()])
  }

  it('reports a traveller with the facts, and an at-home watcher with none', async () => {
    await stack.db.query('DELETE FROM member_activity_samples')
    const id = await makeEvent()
    await signUp(id, top(2), 0, '7003')
    await signUp(id, top(2), 1, '7001')
    await sample('7003', 'Traveling', {
      description: 'Traveling to South Africa', plane: 'airliner', departedAt: NOW - 10 * 60_000,
    })
    await sample('7001', 'Okay')

    const hour = (await get(TOKEN)).body.hours.find((h: any) => h.hour_start === top(2))
    const flyer = hour.watchers.find((w: any) => w.name === 'CalliBee')
    expect(flyer.travel).toMatchObject({
      state: 'Traveling', destination: 'South Africa', plane_image_type: 'airliner',
    })
    expect(typeof flyer.travel.departed_at).toBe('number')
    expect(hour.watchers.find((w: any) => w.name === 'Goosey').travel).toBeNull()
  })

  it('⚠️ passes departed_at through as NULL when the edge was not witnessed', async () => {
    // Torn publishes no arrival time for a traveller, so an ETA counts from a
    // departure we saw ourselves. latchDeparture leaves this null after a
    // sampling gap; inventing one from `now` produces a confidently wrong
    // arrival that a lead then waits on — wrong is worse than absent (#330).
    await stack.db.query('DELETE FROM member_activity_samples')
    const id = await makeEvent()
    await signUp(id, top(2), 0, '7003')
    await sample('7003', 'Traveling', { description: 'Traveling to Japan', departedAt: null })
    const hour = (await get(TOKEN)).body.hours.find((h: any) => h.hour_start === top(2))
    const flyer = hour.watchers[0]
    expect(flyer.travel.state).toBe('Traveling')
    expect(flyer.travel.departed_at).toBeNull()
  })

  it('reports someone already Abroad, with no plane and no departure', async () => {
    await stack.db.query('DELETE FROM member_activity_samples')
    const id = await makeEvent()
    await signUp(id, top(2), 0, '7003')
    await sample('7003', 'Abroad', { description: 'In Switzerland', plane: 'airliner' })
    const t = (await get(TOKEN)).body.hours.find((h: any) => h.hour_start === top(2)).watchers[0].travel
    expect(t.state).toBe('Abroad')
    expect(t.destination).toBe('Switzerland')
    // Already landed — a plane sprite here would invite the bot to compute a
    // flight time for a journey that is over.
    expect(t.plane_image_type).toBeNull()
    expect(t.departed_at).toBeNull()
  })

  it('⚠️ uses only the NEWEST sample per member', async () => {
    // The series is append-only. Reading an old row would report somebody as
    // still in the air hours after they landed.
    await stack.db.query('DELETE FROM member_activity_samples')
    const id = await makeEvent()
    await signUp(id, top(2), 0, '7003')
    await stack.db.query(
      `INSERT INTO member_activity_samples (member_id, sampled_at, status_state, status_description)
       VALUES ('7003', now() - interval '30 minutes', 'Traveling', 'Traveling to Japan')`)
    await sample('7003', 'Okay')
    const hour = (await get(TOKEN)).body.hours.find((h: any) => h.hour_start === top(2))
    expect(hour.watchers[0].travel).toBeNull()
  })
})

describe('destinationFrom', () => {
  it('reads the place out of Torn\'s status text', () => {
    expect(destinationFrom('Traveling to South Africa')).toBe('South Africa')
    expect(destinationFrom('In Switzerland')).toBe('Switzerland')
    expect(destinationFrom(null)).toBeNull()
    expect(destinationFrom('Okay')).toBeNull()
  })

  it('⚠️ calls a return flight "Torn", not the country being left', () => {
    // "Returning to Torn from Canada" naively yields Canada, which tells a lead
    // somebody is flying OUT at the exact moment they are flying back in.
    expect(destinationFrom('Returning to Torn from Canada')).toBe('Torn')
  })
})

describe('projection', () => {
  it('passes the band through, including a refusal to guess', async () => {
    await makeEvent()
    const { body } = await get(TOKEN)
    // No attack readings in the fixture, so the honest answer is "cannot say" —
    // and it must arrive as that, not as a fabricated date.
    expect(body.projection.measured).toBe(false)
    expect(typeof body.projection.reason).toBe('string')
  })
})

describe('collectChainWatch', () => {
  it('is callable without auth so the shape has one author', async () => {
    await makeEvent()
    const payload = await collectChainWatch(stack.db, NOW)
    expect(payload.server_now).toBe(NOW)
    expect(payload.gap_horizon_hours).toBe(GAP_HORIZON_HOURS)
  })
})
