// Self-service stat export (#867), black-box HTTP against a real templated
// Postgres.
//
// ⚠️ The theme is ISOLATION, and it is the whole feature. `member_daily_stats`
// holds every member's data and stays `role: 'leadership'`; this route is a
// separate, narrower door. So the tests are weighted towards "can a member
// reach somebody else's rows" rather than towards the CSV shape, which the
// leadership export already covers.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'

let stack: TestStack
let aliceToken: string
let bobToken: string
let leadToken: string

const ALICE = '9101'
const BOB = '9102'
const LEAD = '9103'

async function loginAs(key: string, id: string) {
  stack.torn.addKey(key, { id, factionId: TEST_FACTION.tornFactionId })
  const res = await fetch(`${stack.baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey: key }),
  })
  expect(res.status).toBe(200)
  return ((await res.json()) as any).token as string
}

async function mine(token: string, query = '?from=2026-08-01&to=2026-08-20') {
  const res = await fetch(`${stack.baseUrl}/api/export/me/stats.csv${query}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  return { status: res.status, text: await res.text() }
}

/** Data rows only — no header, no completion marker. */
const dataRows = (csv: string) =>
  csv.trim().split('\n').slice(1).filter((l) => l && !l.startsWith('#'))

beforeAll(async () => {
  stack = await startTestStack()
  await stack.db.query(`INSERT INTO role_assignments (torn_user_id, role) VALUES (${LEAD}, 'leadership')`)
  aliceToken = await loginAs('SELFEXPALICE1234', ALICE)
  bobToken = await loginAs('SELFEXPBOB123456', BOB)
  leadToken = await loginAs('SELFEXPLEAD12345', LEAD)

  for (const [id, name] of [[ALICE, 'Alice'], [BOB, 'Bob']]) {
    await stack.db.query(
      `INSERT INTO members (member_id, member_name, is_current, is_fallen)
       VALUES ($1, $2, true, false) ON CONFLICT (member_id) DO NOTHING`,
      [id, name]
    )
    for (const d of ['2026-08-05', '2026-08-06', '2026-08-07']) {
      await stack.db.query(
        `INSERT INTO member_daily_stats (member_id, snapshot_date, personalstats)
         VALUES ($1, $2, $3) ON CONFLICT (member_id, snapshot_date) DO NOTHING`,
        [id, d, JSON.stringify({ xantaken: id === ALICE ? 10 : 99 })]
      )
    }
  }
})
afterAll(async () => { await stack?.close() })

describe('a member exports their own stats', () => {
  it('returns a CSV of their own rows', async () => {
    const { status, text } = await mine(aliceToken)
    expect(status).toBe(200)
    expect(dataRows(text)).toHaveLength(3)
  })

  it('⚠️ contains NOBODY else — the isolation this route exists for', async () => {
    const { text } = await mine(aliceToken)
    expect(text).toContain(ALICE)
    expect(text).not.toContain(BOB)
    // Alice's payload value, never Bob's.
    expect(text).toContain('10')
    expect(text).not.toContain('99')
  })

  it('two sessions each get only their own rows', async () => {
    const [a, b] = await Promise.all([mine(aliceToken), mine(bobToken)])
    expect(a.text).toContain(ALICE)
    expect(a.text).not.toContain(BOB)
    expect(b.text).toContain(BOB)
    expect(b.text).not.toContain(ALICE)
  })

  it('⚠️ a member parameter cannot reach the filter at all', async () => {
    // Not "is refused" — there is no parameter to refuse. The route takes the
    // id from the session, so anything in the query string is inert. A route
    // that merely CHECKED a supplied id would be one refactor away from an
    // IDOR; this one has nothing to check.
    for (const q of [
      `?from=2026-08-01&to=2026-08-20&member=${BOB}`,
      `?from=2026-08-01&to=2026-08-20&member_id=${BOB}`,
      `?from=2026-08-01&to=2026-08-20&table=faction_attacks`,
    ]) {
      const { status, text } = await mine(aliceToken, q)
      expect(status).toBe(200)
      expect(text).not.toContain(BOB)
      expect(dataRows(text)).toHaveLength(3)
    }
  })

  it('honours the time window', async () => {
    const { text } = await mine(aliceToken, '?from=2026-08-06&to=2026-08-06')
    expect(dataRows(text)).toHaveLength(1)
    expect(text).toContain('2026-08-06')
  })

  it('rejects a missing or inverted window rather than dumping everything', async () => {
    expect((await mine(aliceToken, '')).status).toBe(400)
    expect((await mine(aliceToken, '?from=2026-08-20&to=2026-08-01')).status).toBe(400)
  })

  it('requires a session', async () => {
    const res = await fetch(`${stack.baseUrl}/api/export/me/stats.csv?from=2026-08-01&to=2026-08-20`)
    expect(res.status).toBe(401)
  })

  it('carries the completion marker, so a truncated file is detectable', async () => {
    // The status line goes out with the headers, so a mid-stream failure still
    // looks like a 200. The trailer is the only difference.
    const { text } = await mine(aliceToken)
    expect(text.trim().split('\n').pop()).toMatch(/^#/)
  })
})

describe('⚠️ the leadership door is untouched', () => {
  it('a member still cannot export the whole table', async () => {
    const res = await fetch(
      `${stack.baseUrl}/api/export/member_daily_stats/csv?from=2026-08-01&to=2026-08-20`,
      { headers: { authorization: `Bearer ${aliceToken}` } }
    )
    expect(res.status).toBe(403)
  })

  it('leadership still exports everybody', async () => {
    const res = await fetch(
      `${stack.baseUrl}/api/export/member_daily_stats/csv?from=2026-08-01&to=2026-08-20`,
      { headers: { authorization: `Bearer ${leadToken}` } }
    )
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain(ALICE)
    expect(text).toContain(BOB)
  })

  it('the registry role is still leadership', async () => {
    // Relaxing this would hand the whole roster to anyone with a session —
    // the thing #867 explicitly must not do.
    const { EXPORT_TABLES } = await import('../src/exportRegistry.js')
    expect(EXPORT_TABLES.member_daily_stats.role).toBe('leadership')
  })

  it('the self-service route is not advertised as an exportable table', async () => {
    const res = await fetch(`${stack.baseUrl}/api/export/tables`, {
      headers: { authorization: `Bearer ${aliceToken}` },
    })
    const body = (await res.json()) as any
    const names = (body.tables ?? []).map((t: any) => t.table ?? t.name ?? t)
    expect(names).not.toContain('member_daily_stats')
  })
})
