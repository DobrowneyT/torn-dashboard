// Chain Watch, slice 1 (#771): the schema and the API under it.
//
// The whole epic replaces a Google Sheet that worked. What it could not do is
// what these tests are about:
//
//   • It matched on DISPLAY NAME, so a rename silently zeroed someone's pay.
//     Every sign-up here keys on the Torn player ID.
//   • Its bonus was pinned to spreadsheet COLUMNS H:I, which are 05:00-07:00
//     TCT on one block and 17:00-19:00 on the next — 28 slots drew a bonus
//     nobody intended. Bonus hours here are hours-of-day on the event, and are
//     DERIVED at read time so leadership can correct them mid-event.
//   • Its window was generated once and the chain outran it. The window grows
//     a day at a time, server-side.
//
// Black-box HTTP against the templated Postgres, like calendar.test.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'

let stack: TestStack
let lead: string
let member: string
let other: string
let visitor: string

async function loginAs(key: string, id: string, inFaction = true) {
  stack.torn.addKey(key, { id, factionId: inFaction ? TEST_FACTION.tornFactionId : null })
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
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

/** The 2025 event's real shape — starts at 10:00 TCT, not midnight — moved to
 *  a future year so "that hour has already started" does not fire on every
 *  member release. The 10:00 offset is the part that matters. */
const START = '2027-10-25T10:00:00Z'

/**
 * ⚠️ The API serves Postgres' own timestamptz text, which carries a BARE
 * two-digit offset ("2027-10-25T05:00:00-05"). That is not valid ISO 8601 and
 * `Date.parse` returns NaN on it — the #140 trap, and the reason the frontend
 * has `parseDbTime`. Compare instants, never strings.
 */
function at(v: string): number {
  const ms = Date.parse(/[+-]\d{2}$/.test(v) ? `${v}:00` : v)
  expect(Number.isNaN(ms)).toBe(false)
  return ms
}
const utc = (iso: string) => Date.parse(iso)

async function newEvent(over: Record<string, unknown> = {}) {
  const res = await api('POST', '/api/chain-events', lead, {
    title: 'Halloween 100k', starts_at: START, days: 3, ...over,
  })
  expect(res.status).toBe(201)
  return res.body as any
}

const claim = (id: number, h: string, slot: number, token: string, body: Record<string, unknown> = {}) =>
  api('POST', `/api/chain-events/${id}/signups`, token, { hour_start: h, slot_index: slot, ...body })

const release = (id: number, h: string, slot: number, token: string, body?: Record<string, unknown>) =>
  api('DELETE', `/api/chain-events/${id}/signups/${encodeURIComponent(h)}/${slot}`, token, body)

beforeAll(async () => {
  stack = await startTestStack()
  await stack.db.query(`INSERT INTO role_assignments (torn_user_id, role) VALUES (9100, 'leadership')`)
  await stack.db.query(`INSERT INTO role_assignments (torn_user_id, role) VALUES (9400, 'visitor')`)
  lead    = await loginAs('CWLEAD9100XXXXXX', '9100')
  member  = await loginAs('CWMEMBER9200XXXX', '9200')
  other   = await loginAs('CWOTHER9300XXXXX', '9300')
  visitor = await loginAs('CWVISITOR9400XXX', '9400', false)
  await stack.db.query(
    `INSERT INTO members (member_id, member_name, is_current) VALUES
       ('9200','Watcher One',true), ('9300','Watcher Two',true), ('9100','The Lead',true)
     ON CONFLICT (member_id) DO UPDATE SET member_name = EXCLUDED.member_name`,
  )
}, 120_000)

afterAll(async () => { await stack?.close() })

describe('the event window', () => {
  it('is created from a number of days and keeps the start hour', async () => {
    // ⚠️ The 2025 event ran 25 Oct 10:00 → 1 Nov 16:00 TCT. Nothing here may
    // assume midnight: the generator script that built the sheet did not.
    const ev = await newEvent()
    expect(at(ev.starts_at)).toBe(utc('2027-10-25T10:00:00Z'))
    expect(at(ev.ends_at)).toBe(utc('2027-10-28T10:00:00Z'))
  })

  it('grows by exactly 24h per append, server-side', async () => {
    const ev = await newEvent()
    const a = await api('POST', `/api/chain-events/${ev.id}/days`, lead)
    expect(a.status).toBe(200)
    expect(at(a.body.ends_at)).toBe(utc('2027-10-29T10:00:00Z'))
    const b = await api('POST', `/api/chain-events/${ev.id}/days`, lead)
    // ⚠️ Two appends are two consecutive 24h steps — not a snap to midnight,
    // which would have added 14h on the first click for a 10:00 event.
    expect(at(b.body.ends_at)).toBe(utc('2027-10-30T10:00:00Z'))
  })

  it('leaves existing sign-ups untouched when a day is appended', async () => {
    const ev = await newEvent()
    const h = '2027-10-26T04:00:00Z'
    expect((await claim(ev.id, h, 0, member)).status).toBe(201)
    await api('POST', `/api/chain-events/${ev.id}/days`, lead)
    const after = await api('GET', `/api/chain-events/${ev.id}`, member)
    const kept = after.body.signups.find(
      (s: any) => s.slot_index === 0 && at(s.hour_start) === utc(h))
    expect(kept?.member_id).toBe('9200')
  })

  it('⚠️ refuses to trim a trailing day that holds a sign-up, and says who', async () => {
    // The guard is here, not on the button: a client-side check reads the grid
    // and THEN deletes, and somebody claiming in that gap loses their slot
    // with no record of it.
    const ev = await newEvent()
    const h = '2027-10-27T22:00:00Z'  // inside the final day of a 3-day window
    await claim(ev.id, h, 0, member)
    const bad = await api('DELETE', `/api/chain-events/${ev.id}/days/last`, lead)
    expect(bad.status).toBe(409)
    expect(JSON.stringify(bad.body)).toMatch(/Watcher One|9200/)

    await release(ev.id, h, 0, member)
    const ok = await api('DELETE', `/api/chain-events/${ev.id}/days/last`, lead)
    expect(ok.status).toBe(200)
    expect(at(ok.body.ends_at)).toBe(utc('2027-10-27T10:00:00Z'))
  })
})

describe('claiming a slot', () => {
  it('lets a member take a free slot for themselves', async () => {
    const ev = await newEvent()
    const res = await claim(ev.id, '2027-10-26T03:00:00Z', 0, member)
    expect(res.status).toBe(201)
    expect(res.body.member_id).toBe('9200')
  })

  it('⚠️ rejects a second claim on the same slot distinctly from other failures', async () => {
    // Two people racing for the last graveyard slot is the NORMAL case. The UI
    // says "somebody just took that" and refreshes — it can only do that if
    // this is separable from a validation error.
    const ev = await newEvent()
    const h = '2027-10-26T05:00:00Z'
    expect((await claim(ev.id, h, 0, member)).status).toBe(201)
    const dup = await claim(ev.id, h, 0, other)
    expect(dup.status).toBe(409)
    expect(dup.body.error).toMatch(/taken/i)
  })

  it('⚠️ refuses one member in BOTH slots of an hour, and not as "slot taken"', async () => {
    // Two watchers exist so that one of them can fail. The same person twice is
    // that redundancy gone while the grid still reads as covered. The 2025
    // sheet never did it — 0 of 211 served hours — so this codifies practice.
    const ev = await newEvent()
    const h = '2027-10-26T06:00:00Z'
    expect((await claim(ev.id, h, 0, member)).status).toBe(201)
    const both = await claim(ev.id, h, 1, member)
    expect(both.status).toBe(409)
    expect(both.body.error).toMatch(/already watching/i)
    // ⚠️ Distinguishable: the UI disables that name in the picker with a
    // reason, rather than showing "taken" on an empty slot.
    expect(both.body.error).not.toMatch(/taken/i)
  })

  it('allows the same member on consecutive hours', async () => {
    // Sanityloss worked four straight in the last run. The constraint is per
    // hour, not per person per day.
    const ev = await newEvent()
    for (const h of ['2027-10-26T08:00:00Z', '2027-10-26T09:00:00Z', '2027-10-26T10:00:00Z']) {
      expect((await claim(ev.id, h, 0, member)).status).toBe(201)
    }
  })

  it('refuses a slot_index at or above the event slots_per_hour', async () => {
    const ev = await newEvent()
    const res = await claim(ev.id, '2027-10-26T11:00:00Z', 2, member)
    expect(res.status).toBe(400)
  })

  it('refuses an hour outside the window', async () => {
    const ev = await newEvent()
    expect((await claim(ev.id, '2027-10-25T09:00:00Z', 0, member)).status).toBe(400)
    expect((await claim(ev.id, '2027-10-28T10:00:00Z', 0, member)).status).toBe(400)
  })

  it('refuses any write once the event is closed', async () => {
    const ev = await newEvent()
    await api('PATCH', `/api/chain-events/${ev.id}`, lead, { status: 'closed' })
    expect((await claim(ev.id, '2027-10-26T12:00:00Z', 0, member)).status).toBe(409)
  })
})

describe('releasing and removing', () => {
  it('⚠️ keeps the row when a slot is given up, never a hard DELETE', async () => {
    // A sign-up drives money. Deleting the row destroys the only evidence that
    // someone held the hour.
    const ev = await newEvent()
    const h = '2027-10-26T13:00:00Z'
    await claim(ev.id, h, 0, member)
    expect((await release(ev.id, h, 0, member)).status).toBe(200)
    const { rows } = await stack.db.query(
      `SELECT member_id, removed_by FROM chain_watch_signups
        WHERE event_id = $1 AND hour_start = $2 AND slot_index = 0`, [ev.id, h])
    expect(rows).toHaveLength(1)
    expect(rows[0].member_id).toBe('9200')
  })

  it('⚠️ distinguishes "I dropped it" from "I was dropped"', async () => {
    const ev = await newEvent()
    const h1 = '2027-10-26T14:00:00Z', h2 = '2027-10-26T15:00:00Z'
    await claim(ev.id, h1, 0, member)
    await release(ev.id, h1, 0, member)                                  // self
    await claim(ev.id, h2, 0, member)
    await release(ev.id, h2, 0, lead, { reason: 'swapped for cover' })   // kicked

    const { rows } = await stack.db.query(
      `SELECT hour_start, removed_by, removed_reason FROM chain_watch_signups
        WHERE event_id = $1 AND removed_at IS NOT NULL ORDER BY hour_start`, [ev.id])
    expect(rows[0].removed_by).toBe('9200')
    expect(rows[1].removed_by).toBe('9100')
    expect(rows[1].removed_reason).toBe('swapped for cover')
  })

  it('⚠️ lets someone else take a released slot while the old row stays readable', async () => {
    // The partial unique index doing its job: a plain one would let the dead
    // row block the freed slot forever.
    const ev = await newEvent()
    const h = '2027-10-26T16:00:00Z'
    await claim(ev.id, h, 0, member)
    await release(ev.id, h, 0, member)
    expect((await claim(ev.id, h, 0, other)).status).toBe(201)
    const { rows } = await stack.db.query(
      `SELECT member_id, removed_at FROM chain_watch_signups
        WHERE event_id = $1 AND hour_start = $2 AND slot_index = 0
        ORDER BY created_at`, [ev.id, h])
    expect(rows).toHaveLength(2)
    expect(rows.filter((r: any) => r.removed_at === null)).toHaveLength(1)
  })

  it('⚠️ lets a member drop their own slot before it starts, and refuses after', async () => {
    // Someone who knows at 22:00 they will not make 04:00 must be able to say
    // so while there is still time to refill it. Forcing them to ask a leader
    // makes the SILENT NO-SHOW the path of least resistance.
    const ev = await newEvent({ starts_at: new Date(Date.now() - 2 * 3600_000).toISOString() })
    // ⚠️ The hour that is RUNNING, not one that finished. A member may claim
    // the hour they are in (the claim boundary is the hour's END), and may not
    // release it once it has begun — the two rules meet here, so the fixture
    // has to sit between them.
    const started = new Date(Math.floor(Date.now() / 3600_000) * 3600_000).toISOString()
    const ahead = new Date(Math.floor((Date.now() + 3600_000) / 3600_000) * 3600_000).toISOString()
    await claim(ev.id, started, 0, member)
    await claim(ev.id, ahead, 0, member)
    expect((await release(ev.id, ahead, 0, member)).status).toBe(200)
    expect((await release(ev.id, started, 0, member)).status).toBe(409)
  })

  it('refuses to release someone else’s slot without leadership', async () => {
    const ev = await newEvent()
    const h = '2027-10-26T17:00:00Z'
    await claim(ev.id, h, 0, member)
    expect((await release(ev.id, h, 0, other)).status).toBe(403)
  })
})

describe('leadership editing slots', () => {
  it('places a named member into a free slot', async () => {
    const ev = await newEvent()
    const res = await claim(ev.id, '2027-10-26T18:00:00Z', 0, lead, { member_id: '9300' })
    expect(res.status).toBe(201)
    expect(res.body.member_id).toBe('9300')
    expect(res.body.created_by).toBe('9100')
  })

  it('refuses a plain member naming somebody else', async () => {
    const ev = await newEvent()
    const res = await claim(ev.id, '2027-10-26T19:00:00Z', 0, member, { member_id: '9300' })
    expect(res.status).toBe(403)
  })

  it('⚠️ swaps a holder in ONE call, leaving no window to race into', async () => {
    // Remove-then-add leaves the slot briefly empty and a member refreshing at
    // that moment can claim it out from under the swap.
    const ev = await newEvent()
    const h = '2027-10-26T20:00:00Z'
    await claim(ev.id, h, 0, member)
    const put = await api('PUT', `/api/chain-events/${ev.id}/signups/${encodeURIComponent(h)}/0`,
      lead, { member_id: '9300' })
    expect(put.status).toBe(200)
    expect(put.body.member_id).toBe('9300')
    const { rows } = await stack.db.query(
      `SELECT member_id, removed_at FROM chain_watch_signups
        WHERE event_id = $1 AND hour_start = $2 AND slot_index = 0`, [ev.id, h])
    expect(rows.filter((r: any) => r.removed_at === null).map((r: any) => r.member_id)).toEqual(['9300'])
    expect(rows.filter((r: any) => r.removed_at !== null).map((r: any) => r.member_id)).toEqual(['9200'])
  })

  it('⚠️ can still edit an hour that has already run', async () => {
    // Corrections surface after the fact. The endpoint must not refuse on the
    // grounds that the hour has passed — that is exactly when a leader is
    // reconciling the payout.
    const ev = await newEvent({ starts_at: new Date(Date.now() - 4 * 3600_000).toISOString() })
    const past = new Date(Math.floor((Date.now() - 2 * 3600_000) / 3600_000) * 3600_000).toISOString()
    // ⚠️ Placed BY the lead. A member can no longer claim a finished hour, so a
    // fixture that did so was describing a state the app will not produce.
    // This is the real shape of the scenario: a leader reconciling the payout,
    // putting somebody in and taking somebody out after the fact.
    expect((await claim(ev.id, past, 0, lead, { member_id: '9200' })).status).toBe(201)
    expect((await release(ev.id, past, 0, lead, { reason: 'no-show' })).status).toBe(200)
  })
})

describe('what the bonus and the end date mean', () => {
  it('⚠️ re-derives the bonus when leadership changes the hours mid-event', async () => {
    // The sheet froze its bonus into a COLUMN POSITION and 28 slots drew one
    // nobody intended. Here the bonus is hours-of-day, read at query time, so a
    // correction applies to hours already served.
    const ev = await newEvent({ bonus_hours: [5, 6] })
    await claim(ev.id, '2027-10-26T05:00:00Z', 0, member)
    await claim(ev.id, '2027-10-26T21:00:00Z', 0, member)

    const before = await api('GET', `/api/chain-events/${ev.id}`, lead)
    expect(before.body.signups.filter((s: any) => s.is_bonus)).toHaveLength(1)

    await api('PATCH', `/api/chain-events/${ev.id}`, lead, { bonus_hours: [5, 6, 21] })
    const after = await api('GET', `/api/chain-events/${ev.id}`, lead)
    expect(after.body.signups.filter((s: any) => s.is_bonus)).toHaveLength(2)
  })

  it('⚠️ stops paying at the real end while still showing the hour', async () => {
    // The grid is built out past the expected end on purpose; the chain may
    // finish early. An hour that never happened is not a shift served — but it
    // must not vanish either, or the member cannot see why they were not paid.
    const ev = await newEvent()
    const late = '2027-10-27T09:00:00Z'
    await claim(ev.id, late, 0, member)
    await api('PATCH', `/api/chain-events/${ev.id}`, lead,
      { actually_ended_at: '2027-10-26T23:00:00Z' })

    const res = await api('GET', `/api/chain-events/${ev.id}`, lead)
    const row = res.body.signups.find((s: any) => at(s.hour_start) === utc(late))
    expect(row).toBeDefined()          // still visible
    expect(row.is_payable).toBe(false) // but not a shift served
  })
})

describe('the review flags, end to end (#774)', () => {
  // ⚠️ `member_activity_samples` and `chain_samples` are NOT scoped to an
  // event — they are one faction-wide series. Two cases that pick the same
  // hour therefore read each other's samples, which is how three of these
  // first passed against evidence the test never wrote. Each case takes its
  // own hour.
  let hourCursor = 2

  /** A served hour in the past, with samples around it and nothing else's. */
  async function servedHour(opts: {
    actions?: number[]; states?: string[]; timeoutAt?: number | null
  }) {
    const back = hourCursor++
    const ev = await newEvent({
      starts_at: new Date(Date.now() - (back + 2) * 3600_000).toISOString(),
      days: 3,
    })
    const hourMs = Math.floor((Date.now() - back * 3600_000) / 3600_000) * 3600_000
    const hour = new Date(hourMs).toISOString()
    await claim(ev.id, hour, 0, lead, { member_id: '9200' })

    for (const [i, state] of (opts.states ?? ['Okay']).entries()) {
      await stack.db.query(
        `INSERT INTO member_activity_samples (sampled_at, member_id, last_action_epoch, status_state)
         VALUES ($1::timestamptz, '9200', $2, $3)`,
        [new Date(hourMs + (i + 1) * 600_000).toISOString(),
         // Relative to the HOUR, not to now: an action "10 minutes in" has to
         // mean that whichever hour the case happens to draw.
         opts.actions?.[i] ?? null, state])
    }
    if (opts.timeoutAt !== undefined && opts.timeoutAt !== null) {
      await stack.db.query(
        `INSERT INTO chain_samples (sampled_at, chain_current, chain_timeout)
         VALUES ($1::timestamptz, 5000, $2)`,
        [new Date(hourMs + 900_000).toISOString(),
         Math.floor(hourMs / 1000) + 900 + opts.timeoutAt])
    }
    const res = await api('GET', `/api/chain-events/${ev.id}`, lead)
    return res.body.signups.find((x: any) => at(x.hour_start) === hourMs)
  }


  it('⚠️ does NOT flag a watcher who was around but made no hits', async () => {
    // The case the whole design turns on: during a healthy chain, zero attacks
    // means nothing needed doing.
    const row = await servedHour({
      actions: [Math.floor(Math.floor((Date.now() - hourCursor * 3600_000) / 3600_000) * 3600_000 / 1000) + 600],
      states: ['Okay'], timeoutAt: 600,
    })
    expect(row.flag).toBeNull()
    expect(row.is_payable).toBe(true)
  })

  it('flags an absent watcher, and escalates when the chain was at risk', async () => {
    const quiet = await servedHour({ states: ['Okay'], timeoutAt: 600 })
    expect(quiet.flag).toBe('absent')
    const risky = await servedHour({ states: ['Okay'], timeoutAt: 30 })
    expect(risky.flag).toBe('absent-at-risk')
  })

  it('⚠️ marks an hour spent abroad as not payable, and says why', async () => {
    const row = await servedHour({ states: ['Abroad', 'Abroad'], timeoutAt: 600 })
    expect(row.flag).toBe('abroad')
    expect(row.is_payable).toBe(false)
    expect(row.flag_reason).toMatch(/not paid/i)
  })

  it('⚠️ keeps two flagged hours for one member apart', async () => {
    // The evidence is keyed by hour. Parsing `hour_start` in JS returns NaN on
    // Postgres' bare "-05" offset (#140), every hour stringifies to the same
    // "NaN:9200" key, and one member's hours collapse into each other — which
    // is how the first version of this endpoint produced a flag computed
    // against an invalid date and applied it to the wrong row.
    const quiet = await servedHour({ states: ['Okay'], timeoutAt: 600 })
    const away = await servedHour({ states: ['Abroad'], timeoutAt: 600 })
    expect(quiet.flag).toBe('absent')
    expect(away.flag).toBe('abroad')
    expect(quiet.hour_start).not.toBe(away.hour_start)
  })

  it('⚠️ says nothing about an hour it never sampled', async () => {
    // "We were not looking" must not render as "they were not there".
    const row = await servedHour({ states: [], timeoutAt: null })
    expect(row.flag).toBeNull()
    expect(row.is_payable).toBe(true)
  })
})

describe('a leader\'s answer to a flag (#773)', () => {
  async function flaggedSlot() {
    const ev = await newEvent({ starts_at: new Date(Date.now() - 6 * 3600_000).toISOString() })
    const hourMs = Math.floor((Date.now() - 5 * 3600_000) / 3600_000) * 3600_000
    const hour = new Date(hourMs).toISOString()
    await claim(ev.id, hour, 0, lead, { member_id: '9200' })
    return { id: ev.id, hour, hourMs }
  }
  const decide = (id: number, hour: string, decision: unknown) =>
    api('PATCH', `/api/chain-events/${id}/signups/${encodeURIComponent(hour)}/0/decision`,
      lead, { decision })

  it('records paid and unpaid, with who decided', async () => {
    const { id, hour } = await flaggedSlot()
    const paid = await decide(id, hour, 'paid')
    expect(paid.status).toBe(200)
    expect(paid.body.pay_decision).toBe('paid')
    expect(paid.body.decided_by).toBe('9100')
    expect((await decide(id, hour, 'unpaid')).body.pay_decision).toBe('unpaid')
  })

  it('⚠️ clears back to UNDECIDED, which is not the same as unpaid', async () => {
    // An undecided flag still counts as payable: the flag asks a question, it
    // does not withhold money on its own.
    const { id, hour } = await flaggedSlot()
    await decide(id, hour, 'unpaid')
    const cleared = await decide(id, hour, null)
    expect(cleared.body.pay_decision).toBeNull()
    expect(cleared.body.decided_at).toBeNull()
  })

  it('refuses a decision that is neither', async () => {
    const { id, hour } = await flaggedSlot()
    expect((await decide(id, hour, 'maybe')).status).toBe(400)
  })

  it('is leadership only', async () => {
    const { id, hour } = await flaggedSlot()
    const res = await api('PATCH',
      `/api/chain-events/${id}/signups/${encodeURIComponent(hour)}/0/decision`,
      member, { decision: 'paid' })
    expect(res.status).toBe(403)
  })
})

describe('reading the end of the chain back (#773)', () => {
  it('⚠️ derives the end from the samples and stops paying past it', async () => {
    // Nobody pressed a button: the cooldown transition is read back out of
    // chain_samples hours later, which is the whole reason that series is
    // append-only rather than a singleton.
    const ev = await newEvent({ starts_at: new Date(Date.now() - 5 * 3600_000).toISOString() })
    const endedMs = Math.floor((Date.now() - 3 * 3600_000) / 3600_000) * 3600_000
    const afterMs = endedMs + 2 * 3600_000
    await claim(ev.id, new Date(endedMs - 3600_000).toISOString(), 0, lead, { member_id: '9200' })
    await claim(ev.id, new Date(afterMs).toISOString(), 0, lead, { member_id: '9300' })

    await stack.db.query(
      `INSERT INTO chain_samples (sampled_at, chain_current, chain_cooldown) VALUES
         ($1::timestamptz, 61204, NULL), ($2::timestamptz, 61204, $3)`,
      [new Date(endedMs - 1800_000).toISOString(), new Date(endedMs).toISOString(),
       Math.floor(endedMs / 1000) + 1800])

    const res = await api('GET', `/api/chain-events/${ev.id}`, lead)
    expect(res.body.outcome.state).toBe('ended')
    expect(res.body.outcome.dropped).toBe(true)     // 61,204 is short of 100k
    const before = res.body.signups.find((x: any) => at(x.hour_start) === endedMs - 3600_000)
    const after = res.body.signups.find((x: any) => at(x.hour_start) === afterMs)
    expect(before.is_payable).toBe(true)
    expect(after.is_payable).toBe(false)            // an hour that never happened
  })
})

describe('the chain projection (#774)', () => {
  it('refuses to project from less than a day of chain', async () => {
    const ev = await newEvent({ starts_at: new Date(Date.now() - 6 * 3600_000).toISOString() })
    const res = await api('GET', `/api/chain-events/${ev.id}`, lead)
    expect(res.body.projection.measured).toBe(false)
    expect(['too-early', 'no-readings']).toContain(res.body.projection.reason)
  })
})

describe('the clock the client renders against', () => {
  it('⚠️ travels with the payload, so "elapsed" is not the browser\'s opinion', async () => {
    // A viewer with a skewed system clock would otherwise see still-claimable
    // hours as past — or be offered a claim on an hour that has gone.
    const ev = await newEvent()
    const res = await api('GET', `/api/chain-events/${ev.id}`, member)
    expect(res.body.server_now).toBeTruthy()
    expect(Math.abs(at(res.body.server_now) - Date.now())).toBeLessThan(60_000)
  })
})

describe('⚠️ every mutation is gated, one route at a time', () => {
  // Written per route rather than as a loop, so a route added later without a
  // guard fails a test that names it. The bonus fields matter most: the bonus
  // is DERIVED, so editing bonus_hours retroactively changes what every member
  // is owed. That is a route that moves money.
  const cases: Array<[string, (id: number, t: string) => Promise<{ status: number }>]> = [
    ['create an event',    (_id, t) => api('POST', '/api/chain-events', t, { title: 'x', starts_at: START, days: 1 })],
    ['delete an event',    (id, t) => api('DELETE', `/api/chain-events/${id}`, t)],
    ['append a day',       (id, t) => api('POST', `/api/chain-events/${id}/days`, t)],
    ['trim a day',         (id, t) => api('DELETE', `/api/chain-events/${id}/days/last`, t)],
    ['set bonus_hours',      (id, t) => api('PATCH', `/api/chain-events/${id}`, t, { bonus_hours: [3] })],
    ['set bonus_multiplier', (id, t) => api('PATCH', `/api/chain-events/${id}`, t, { bonus_multiplier: 3 })],
    ['set bonus_applies_to', (id, t) => api('PATCH', `/api/chain-events/${id}`, t, { bonus_applies_to: 'payout' })],
    ['set actually_ended_at',(id, t) => api('PATCH', `/api/chain-events/${id}`, t, { actually_ended_at: START })],
    ['set status',           (id, t) => api('PATCH', `/api/chain-events/${id}`, t, { status: 'closed' })],
    ['set payout_per_slot',  (id, t) => api('PATCH', `/api/chain-events/${id}`, t, { payout_per_slot: 9 })],
  ]

  for (const [name, call] of cases) {
    it(`refuses a plain member: ${name}`, async () => {
      const ev = await newEvent()
      expect((await call(ev.id, member)).status).toBe(403)
    })
  }

  it('refuses a visitor even the things a member may do', async () => {
    const ev = await newEvent()
    expect((await claim(ev.id, '2027-10-26T22:00:00Z', 0, visitor)).status).toBe(403)
    expect((await api('POST', `/api/chain-events/${ev.id}/days`, visitor)).status).toBe(403)
  })

  it('lets any member, and a visitor, read', async () => {
    const ev = await newEvent()
    expect((await api('GET', `/api/chain-events/${ev.id}`, member)).status).toBe(200)
    expect((await api('GET', '/api/chain-events', visitor)).status).toBe(200)
  })
})

// ── a finished hour is read-only for members (MonChoon, 2026-10-01) ─────────
//
// ⚠️ The hole this closes was a PAYOUT hole, not a UI annoyance. `checkSlot`
// only asked whether an hour was inside the event window, and `is_payable` only
// asks whether it fell before the chain ended — neither asked whether the claim
// came BEFORE the hour ran. Any member could back-fill every elapsed hour of an
// open event and be paid `payout_per_slot` for each.
describe('claiming an hour that has already run', () => {
  // An event that started well in the past, so its early hours are finished.
  const PAST_START = new Date(Date.now() - 48 * 3600_000).toISOString().slice(0, 13) + ':00:00.000Z'
  const hourAt = (startIso: string, n: number) =>
    new Date(Date.parse(startIso) + n * 3600_000).toISOString()

  it('refuses a member, naming the hour as the reason', async () => {
    const ev = await newEvent({ starts_at: PAST_START, days: 3 })
    const past = hourAt(PAST_START, 1)
    const res = await claim(ev.id, past, 0, member)
    expect(res.status).toBe(409)
    expect(String(res.body.error)).toMatch(/already finished/i)
  })

  it('⚠️ still allows leadership, who have to correct slots after the fact', async () => {
    // Somebody watched but could not claim, or a no-show needs removing. The
    // back-fill is auditable rather than blocked: created_by and created_at
    // record who did it and when.
    const ev = await newEvent({ starts_at: PAST_START, days: 3 })
    const past = hourAt(PAST_START, 2)
    const res = await claim(ev.id, past, 0, lead, { member_id: '9200' })
    expect(res.status).toBe(201)
    expect(res.body.created_by).toBe('9100')
    expect(res.body.member_id).toBe('9200')
  })

  it('⚠️ allows a member the hour they are IN — the boundary is the END', async () => {
    // You are watching it; nothing about that claim is retrospective.
    const nowHour = new Date(Date.now()).toISOString().slice(0, 13) + ':00:00.000Z'
    const ev = await newEvent({
      starts_at: new Date(Date.parse(nowHour) - 3600_000).toISOString(), days: 2,
    })
    const res = await claim(ev.id, nowHour, 0, member)
    expect(res.status).toBe(201)
  })

  it('allows a member a future hour', async () => {
    const ev = await newEvent({ starts_at: PAST_START, days: 4 })
    const future = new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 13) + ':00:00.000Z'
    const res = await claim(ev.id, future, 0, member)
    expect(res.status).toBe(201)
  })

  it('reports when each slot was claimed, as an epoch number', async () => {
    // ⚠️ `created_ms`, not `created_at`. The timestamptz arrives with a bare
    // two-digit offset that `new Date()` reads as NaN (#140), so the grid
    // cannot show "claimed at" without this.
    const ev = await newEvent({ starts_at: PAST_START, days: 4 })
    const future = new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 13) + ':00:00.000Z'
    expect((await claim(ev.id, future, 0, member)).status).toBe(201)
    const res = await api('GET', `/api/chain-events/${ev.id}`, member)
    // ⚠️ Found by slot id rather than by matching the timestamp string: the
    // server serves timestamptz with a bare offset and `db.ts` rewrites the
    // space to a T process-wide, so string matching here is testing the
    // serialiser rather than the field under test.
    const signup = (res.body as any).signups.find((s: any) => String(s.member_id) === '9200')
    expect(signup).toBeTruthy()
    expect(Number.isFinite(Number(signup.created_ms))).toBe(true)
    expect(Number(signup.created_ms)).toBeGreaterThan(Date.now() - 60_000)
  })
})
