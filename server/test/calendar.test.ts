// Faction calendar (#395): aggregation across five tables plus the two the
// ticket adds. Black-box HTTP against the templated Postgres.
//
// The theme: the calendar is mostly a VIEW. What it aggregates must be
// complete and must not be mutable from here; what it owns must be editable
// and genuinely deletable.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'

let stack: TestStack
let leadToken: string
let memberToken: string

async function loginAs(key: string, id: string) {
  stack.torn.addKey(key, { id, factionId: TEST_FACTION.tornFactionId })
  const res = await fetch(`${stack.baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey: key }),
  })
  expect(res.status).toBe(200)
  return ((await res.json()) as any).token as string
}

async function api(method: string, path: string, token: string, payload?: unknown) {
  const res = await fetch(`${stack.baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

const WINDOW = '?from=2026-08-01T00:00:00Z&to=2026-08-31T23:59:59Z'
const epoch = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m - 1, d) / 1000)

beforeAll(async () => {
  stack = await startTestStack()
  await stack.db.query(`INSERT INTO role_assignments (torn_user_id, role) VALUES (8100, 'leadership')`)
  leadToken = await loginAs('CALLEAD8100XXXXX', '8100')
  memberToken = await loginAs('CALMEMBER8200XXX', '8200')

  // Logging in already creates the roster row; just give it a name to read back.
  await stack.db.query(
    `INSERT INTO members (member_id, member_name, is_current) VALUES ('8200', 'Birthday Haver', true)
     ON CONFLICT (member_id) DO UPDATE SET member_name = EXCLUDED.member_name, is_current = true`
  )
  await stack.db.query(
    `INSERT INTO ranked_wars (id, start_at, end_at, opponent_id, opponent_name)
     VALUES (900, $1, $2, 77, 'Bad Company')`,
    [epoch(2026, 8, 5), epoch(2026, 8, 8)]
  )
  await stack.db.query(
    `INSERT INTO competitions (name, metric_id, window_start, window_end)
     VALUES ('Gym Grind', 'strength', '2026-08-03T00:00:00Z', '2026-08-10T00:00:00Z')`
  )
  await stack.db.query(
    `INSERT INTO oc_payout_weeks (week_start, week_end) VALUES ('2026-08-10', '2026-08-16')`
  )
  await stack.db.query(
    `INSERT INTO crimes (crime_id, name, difficulty, status, expired_at, total_slots, filled_slots)
     VALUES ('c900', 'Break the Bank', 8, 'Recruiting', $1, 5, 3)`,
    [epoch(2026, 8, 20)]
  )
  await stack.db.query(
    `INSERT INTO member_daily_stats (member_id, snapshot_date, profile)
     VALUES ('8200', '2026-08-11', '{"signup":"2015-08-14 05:39:32"}'::jsonb)`
  )
}, 30000)

afterAll(async () => { await stack?.close() })

describe('GET /api/calendar', () => {
  it('aggregates every source with nobody having entered anything', async () => {
    const res = await api('GET', `/api/calendar${WINDOW}`, memberToken)
    expect(res.status).toBe(200)
    expect(res.body.wars).toHaveLength(1)
    expect(res.body.competitions).toHaveLength(1)
    expect(res.body.payout_weeks).toHaveLength(1)
    expect(res.body.expiring_crimes).toHaveLength(1)
    // The acceptance criterion: useful on day one, before any manual entry.
    expect(res.body.events).toEqual([])
  })

  it('serves each source in its own native time representation', async () => {
    // ⚠️ Four shapes reach the client and the adapters depend on knowing which
    // is which. If this ever silently changes, the frontend reads NaN.
    const res = await api('GET', `/api/calendar${WINDOW}`, memberToken)
    expect(Number(res.body.wars[0].start_at)).toBe(epoch(2026, 8, 5)) // epoch SECONDS
    expect(String(res.body.competitions[0].window_start)).toMatch(/^\d{4}-\d{2}-\d{2}/)
    expect(String(res.body.payout_weeks[0].week_start)).toMatch(/^2026-08-10/)
  })

  it('carries how full an expiring crime is, so the warning means something', async () => {
    const res = await api('GET', `/api/calendar${WINDOW}`, memberToken)
    expect(res.body.expiring_crimes[0]).toMatchObject({ slots_filled: 3, slots_total: 5 })
  })

  it('derives Torn anniversaries from the profile blob we already hold', async () => {
    const res = await api('GET', `/api/calendar${WINDOW}`, memberToken)
    const row = res.body.anniversaries.find((a: any) => a.member_id === '8200')
    expect(row.signup).toBe('2015-08-14 05:39:32')
  })

  it('⚠️ keeps a war that started before the window but is still running', async () => {
    // Filtering on start alone hides the war you are currently in.
    await stack.db.query(
      `INSERT INTO ranked_wars (id, start_at, end_at, opponent_name) VALUES (901, $1, NULL, 'Ongoing')`,
      [epoch(2026, 7, 28)]
    )
    const res = await api('GET', `/api/calendar${WINDOW}`, memberToken)
    expect(res.body.wars.map((w: any) => w.opponent_name)).toContain('Ongoing')
    await stack.db.query('DELETE FROM ranked_wars WHERE id = 901')
  })

  it('rejects a nonsense window instead of guessing', async () => {
    expect((await api('GET', '/api/calendar?from=nope&to=2026-08-31', memberToken)).status).toBe(400)
    expect((await api('GET', '/api/calendar?from=2026-08-31T00:00:00Z&to=2026-08-01T00:00:00Z', memberToken)).status).toBe(400)
    // ⚠️ A decade-wide window expands ten occurrences of every recurring event
    // and scans every war ever fought.
    expect((await api('GET', '/api/calendar?from=2000-01-01T00:00:00Z&to=2030-01-01T00:00:00Z', memberToken)).status).toBe(400)
  })

  it('defaults to a window around today when none is given', async () => {
    const res = await api('GET', '/api/calendar', memberToken)
    expect(res.status).toBe(200)
    expect(res.body.from).toBeTruthy()
  })
})

describe('calendar events — typed-in entries and Torn events', () => {
  let eventId: number

  it('leadership creates a Torn event with yearly recurrence', async () => {
    const res = await api('POST', '/api/calendar/events', leadToken, {
      source: 'torn_event', title: 'Christmas Town', note: 'Runs most of December',
      starts_at: '2026-12-01T00:00:00Z', ends_at: '2026-12-31T23:59:00Z', recurrence: 'yearly',
    })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ source: 'torn_event', recurrence: 'yearly' })
    eventId = res.body.id
  })

  it('⚠️ returns a recurring entry even for a window years away from its date', async () => {
    // A yearly row created for 2026 is what makes December 2029 correct.
    // Filtering it out by starts_at drops the rows recurrence exists for.
    const res = await api('GET', '/api/calendar?from=2029-12-01T00:00:00Z&to=2029-12-31T00:00:00Z', memberToken)
    expect(res.body.events.map((e: any) => e.title)).toContain('Christmas Town')
  })

  it('a plain member can read it but not write one', async () => {
    const read = await api('GET', `/api/calendar${WINDOW}`, memberToken)
    expect(read.status).toBe(200)
    const write = await api('POST', '/api/calendar/events', memberToken, {
      title: 'Chain night', starts_at: '2026-08-14T20:00:00Z',
    })
    expect(write.status).toBe(403)
  })

  it('leadership edits and then deletes it', async () => {
    const put = await api('PUT', `/api/calendar/events/${eventId}`, leadToken, {
      source: 'torn_event', title: 'Christmas Town 2026', starts_at: '2026-12-02T00:00:00Z', recurrence: 'none',
    })
    expect(put.status).toBe(200)
    expect(put.body.title).toBe('Christmas Town 2026')
    expect(put.body.recurrence).toBe('none')

    expect((await api('DELETE', `/api/calendar/events/${eventId}`, leadToken)).status).toBe(200)
    expect((await api('DELETE', `/api/calendar/events/${eventId}`, leadToken)).status).toBe(404)
  })

  it('rejects the ways a hand-typed entry goes wrong', async () => {
    const bad = async (payload: any) => (await api('POST', '/api/calendar/events', leadToken, payload)).status
    expect(await bad({ title: '', starts_at: '2026-08-14T20:00:00Z' })).toBe(400)
    expect(await bad({ title: 'x', starts_at: 'not a date' })).toBe(400)
    expect(await bad({ title: 'x', starts_at: '2026-08-14T20:00:00Z', source: 'war' })).toBe(400)
    expect(await bad({ title: 'x', starts_at: '2026-08-14T20:00:00Z', recurrence: 'monthly' })).toBe(400)
    // An end before its start stores an event that vanishes from every window
    // filter rather than showing up wrong — worse than a rejection.
    expect(await bad({ title: 'x', starts_at: '2026-08-14T20:00:00Z', ends_at: '2026-08-13T20:00:00Z' })).toBe(400)
    expect(await bad({ title: 'x'.repeat(200), starts_at: '2026-08-14T20:00:00Z' })).toBe(400)
  })

  it('⚠️ offers no way to delete an aggregated war from the calendar', async () => {
    // The delete route only touches calendar_events. An aggregated entry is a
    // view onto another table; a delete there either does nothing or deletes
    // the war. This asserts the war survives an id collision attempt.
    const res = await api('DELETE', '/api/calendar/events/900', leadToken)
    expect(res.status).toBe(404)
    const wars = await stack.db.query('SELECT id FROM ranked_wars WHERE id = 900')
    expect(wars.rowCount).toBe(1)
  })
})

describe('birthdays', () => {
  it('a member sets their own, and it comes back on the calendar', async () => {
    const put = await api('PUT', '/api/calendar/birthdays/8200', memberToken, { birth_month: 8, birth_day: 14 })
    expect(put.status).toBe(200)
    expect(put.body).toMatchObject({ birth_month: 8, birth_day: 14, birth_year: null })

    const cal = await api('GET', `/api/calendar${WINDOW}`, memberToken)
    expect(cal.body.birthdays[0]).toMatchObject({ member_id: '8200', member_name: 'Birthday Haver' })
  })

  it('stores the year only when it is given', async () => {
    // Month/day are what the faction uses. A year is a fuller piece of personal
    // data and stays opt-in within the opt-in.
    const put = await api('PUT', '/api/calendar/birthdays/8200', memberToken, { birth_month: 8, birth_day: 14, birth_year: 1990 })
    expect(put.body.birth_year).toBe(1990)
  })

  it('a member cannot set someone else\'s', async () => {
    expect((await api('PUT', '/api/calendar/birthdays/9999', memberToken, { birth_month: 1, birth_day: 1 })).status).toBe(403)
  })

  it('leadership can maintain the list for anyone', async () => {
    expect((await api('PUT', '/api/calendar/birthdays/8200', leadToken, { birth_month: 9, birth_day: 2 })).status).toBe(200)
  })

  it('rejects a date that does not exist', async () => {
    const bad = async (payload: any) => (await api('PUT', '/api/calendar/birthdays/8200', memberToken, payload)).status
    expect(await bad({ birth_month: 13, birth_day: 1 })).toBe(400)
    expect(await bad({ birth_month: 2, birth_day: 31 })).toBe(400)
    expect(await bad({ birth_month: 4, birth_day: 31 })).toBe(400)
    expect(await bad({ birth_month: 8, birth_day: 14, birth_year: 1200 })).toBe(400)
  })

  it('accepts 29 February, which is a real birthday', async () => {
    expect((await api('PUT', '/api/calendar/birthdays/8200', memberToken, { birth_month: 2, birth_day: 29 })).status).toBe(200)
  })

  it('⚠️ withdrawal deletes the row rather than hiding it', async () => {
    expect((await api('DELETE', '/api/calendar/birthdays/8200', memberToken)).status).toBe(200)
    const rows = await stack.db.query('SELECT * FROM member_birthdays WHERE member_id = $1', ['8200'])
    expect(rows.rowCount).toBe(0)
  })
})
