// The mailbox Choonbot drains, end to end against real Postgres (#942).
//
// ⚠️ The pure rules live in `member-threads.test.ts`. This file is for the
// parts only a database can get wrong: the first-run watermark, claim/release
// semantics, and the registry write that must happen before a row is marked
// posted.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, TEST_KEY_ENCRYPTION_KEY, type TestStack } from './harness.js'
import { memberThreadSweepJob, INSTALL_KEY } from '../src/scraper/jobs/memberThreadSweep.js'
import { createKeyPool } from '../src/scraper/keyPool.js'
import { createTornClient } from '../src/scraper/tornClient.js'

let stack: TestStack
const TOKEN = 'member-threads-test-token'

const deps = () => ({
  db: stack.db,
  pool: createKeyPool({ db: stack.db, encryptionKey: TEST_KEY_ENCRYPTION_KEY }),
  client: createTornClient({ baseUrl: stack.tornBaseUrl }),
}) as any

async function reset() {
  await stack.db.query('DELETE FROM member_thread_outbox')
  await stack.db.query('DELETE FROM member_threads')
  await stack.db.query('DELETE FROM member_faction_stints')
  await stack.db.query(`DELETE FROM faction_settings WHERE key = $1`, [INSTALL_KEY])
}

const addStint = (memberId: string, joinedSql: string, leftSql = 'NULL') =>
  stack.db.query(
    `INSERT INTO member_faction_stints (member_id, joined_at, left_at)
     VALUES ($1, ${joinedSql}, ${leftSql}) RETURNING id`,
    [memberId],
  )

const api = (path: string, body?: unknown, token = TOKEN) =>
  fetch(`${stack.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body ?? {}),
  })

beforeAll(async () => {
  stack = await startTestStack(undefined, {}, { memberThreadsToken: TOKEN })
}, 30000)

afterAll(async () => { await stack?.close() })

describe('the install watermark', () => {
  /**
   * ⚠️ THE no-backfill rule, at the layer that enforces it. The roster at
   * install is ~94 people whose real join dates nobody recorded, and the first
   * run is the one that would queue every one of them.
   */
  it('the first run queues nothing and only records the watermark', async () => {
    await reset()
    await stack.db.query(
      `INSERT INTO members (member_id, member_name, is_current) VALUES ('900', 'Existing', true)
       ON CONFLICT (member_id) DO NOTHING`,
    )
    await addStint('900', "now() - interval '30 days'")

    const res = await memberThreadSweepJob(deps())
    expect(res.details).toMatchObject({ installed: true })
    const out = await stack.db.query('SELECT count(*)::int AS n FROM member_thread_outbox')
    expect(out.rows[0].n).toBe(0)
  })

  it('a member who joins after install is queued', async () => {
    await addStint('901', "now() + interval '1 second'")
    const res = await memberThreadSweepJob(deps())
    expect(res.rows).toBe(1)
    const out = await stack.db.query(
      `SELECT member_id, kind FROM member_thread_outbox`,
    )
    expect(out.rows).toEqual([{ member_id: '901', kind: 'joined' }])
  })

  it('⚠️ the pre-existing member is STILL not queued on a later run', async () => {
    // The watermark never moves, so a second pass cannot quietly pick up the
    // roster it deliberately skipped.
    const out = await stack.db.query(
      `SELECT count(*)::int AS n FROM member_thread_outbox WHERE member_id = '900'`,
    )
    expect(out.rows[0].n).toBe(0)
  })

  it('a repeated sweep queues nothing new', async () => {
    const res = await memberThreadSweepJob(deps())
    expect(res.rows).toBe(0)
  })
})

describe('claiming and finishing', () => {
  it('requires the token', async () => {
    expect((await api('/api/internal/member-threads/claim', {}, 'wrong')).status).toBe(401)
    const bare = await fetch(`${stack.baseUrl}/api/internal/member-threads/claim`, { method: 'POST' })
    expect(bare.status).toBe(401)
  })

  it('the scope is its own, not one of the read-only bot tokens', async () => {
    // ⚠️ This is the one credential of the bot's that WRITES — it marks rows
    // posted against a permanent per-member record. Reusing chain-watch's or
    // war-overview's would mean a leak of a read-only board credential also
    // confers that (#609).
    const { memberThreadsScope } = await import('../../db/memberThreadsTokenLib.mjs')
    expect(memberThreadsScope('forge')).toBe('member-threads:forge')
    expect(memberThreadsScope('forge')).not.toContain('chain-watch')
    expect(memberThreadsScope('forge')).not.toContain('war-overview')
  })

  it('hands out the pending rows and the registry', async () => {
    const res = await api('/api/internal/member-threads/claim')
    const body = await res.json() as any
    expect(res.status).toBe(200)
    expect(body.pending.length).toBeGreaterThan(0)
    // ⚠️ The registry comes with it, so the bot knows which members still need
    // a thread CREATED rather than discovering it one failure at a time.
    expect(body).toHaveProperty('threads')
    // ⚠️ And the forum channel does NOT, because the bot owns it. Chain Watch
    // settles this: "which channel things land in" is the bot's, editable from
    // Discord per tenant, while the dashboard owns facts about the faction.
    // Two authoritative copies of one channel id is how they drift.
    expect(body).not.toHaveProperty('forum_channel_id')
  })

  it('⚠️ a second claim does not hand out the same row', async () => {
    // Two drains overlapping would otherwise post the same note twice into a
    // permanent thread.
    const body = await (await api('/api/internal/member-threads/claim')).json() as any
    expect(body.pending).toEqual([])
  })

  it('recording a post creates the registry row and marks it done', async () => {
    const pending = await stack.db.query(
      `SELECT id, member_id FROM member_thread_outbox WHERE posted_at IS NULL LIMIT 1`,
    )
    const { id, member_id } = pending.rows[0]
    const res = await api('/api/internal/member-threads/posted', {
      id, thread_id: '555000111', channel_id: '1286415074835038331', message_id: '999',
    })
    expect(res.status).toBe(200)

    const reg = await stack.db.query(
      `SELECT thread_id, channel_id FROM member_threads WHERE member_id = $1`, [member_id],
    )
    expect(reg.rows[0]).toMatchObject({ thread_id: '555000111' })
    const row = await stack.db.query(
      `SELECT posted_at, message_id FROM member_thread_outbox WHERE id = $1`, [id],
    )
    expect(row.rows[0].posted_at).toBeTruthy()
    expect(row.rows[0].message_id).toBe('999')
  })

  it('a posted row is never handed out again', async () => {
    const body = await (await api('/api/internal/member-threads/claim')).json() as any
    expect(body.pending).toEqual([])
  })

  it('rejects an unknown outbox id rather than silently succeeding', async () => {
    expect((await api('/api/internal/member-threads/posted', { id: 99999 })).status).toBe(404)
    expect((await api('/api/internal/member-threads/posted', {})).status).toBe(400)
  })
})

describe('failure releases the row', () => {
  /**
   * ⚠️ Released and RECORDED, not silently retried forever. #944 needs a
   * deleted or renamed thread to fail visibly, and a queue that hides its own
   * failures is exactly what would bury it.
   */
  it('a reported failure frees the row and keeps the reason', async () => {
    await addStint('902', "now() + interval '1 second'")
    await memberThreadSweepJob(deps())
    const claimed = await (await api('/api/internal/member-threads/claim')).json() as any
    const row = claimed.pending.find((p: any) => p.member_id === '902')
    expect(row).toBeTruthy()

    expect((await api('/api/internal/member-threads/failed', {
      id: row.id, error: 'thread 123 not found',
    })).status).toBe(200)

    const after = await stack.db.query(
      `SELECT claimed_at, last_error, attempts FROM member_thread_outbox WHERE id = $1`, [row.id],
    )
    expect(after.rows[0].claimed_at).toBeNull()
    expect(after.rows[0].last_error).toContain('not found')
    expect(Number(after.rows[0].attempts)).toBeGreaterThan(0)

    // And it comes back on the next poll.
    const again = await (await api('/api/internal/member-threads/claim')).json() as any
    expect(again.pending.map((p: any) => p.id)).toContain(row.id)
  })

  it('refuses to fail a row that was already posted', async () => {
    const posted = await stack.db.query(
      `SELECT id FROM member_thread_outbox WHERE posted_at IS NOT NULL LIMIT 1`,
    )
    const res = await api('/api/internal/member-threads/failed', { id: posted.rows[0].id })
    expect(res.status).toBe(404)
  })
})

describe('leaves and rejoins', () => {
  it('queues a leave note, and a rejoin as a separate note', async () => {
    await reset()
    await memberThreadSweepJob(deps())        // establish the watermark
    // ⚠️ Explicit offsets rather than bare `now()`. The watermark and an event
    // can truncate to the SAME millisecond, which the planner deliberately
    // reads as pre-existing — correct in production, where the gap is minutes,
    // but it makes a test that races the clock flaky rather than wrong.
    const first = await addStint('903', "now() + interval '1 second'")
    await memberThreadSweepJob(deps())
    await stack.db.query(
      `UPDATE member_faction_stints SET left_at = now() + interval '2 seconds' WHERE id = $1`,
      [first.rows[0].id],
    )
    await addStint('903', "now() + interval '3 seconds'")
    await memberThreadSweepJob(deps())

    const rows = await stack.db.query(
      `SELECT kind, subject FROM member_thread_outbox WHERE member_id = '903'
        ORDER BY queued_at, id`,
    )
    // ⚠️ Chronological — the order the events actually happened, which is
    // what a permanent log has to say. An earlier version grouped joins
    // first and wrote 'joined · joined · left' for a rejoin.
    expect(rows.rows.map((r: any) => r.kind)).toEqual(['joined', 'left', 'joined'])
    // ⚠️ Two stints, two subjects — keyed on the stint so a rejoin is not
    // swallowed as a duplicate of the first join.
    expect(new Set(rows.rows.map((r: any) => r.subject)).size).toBe(2)
  })
})

// #943 — a correction has to reach the bot as an EDIT, not a second post.
describe('a re-opened entry', () => {
  it('⚠️ comes back from claim WITH its message id', async () => {
    // ⚠️ Self-contained: `claim` takes rows for ten minutes, so a test that
    // claims shared fixture rows starves whichever test runs next. This one
    // makes its own row and releases everything it touched.
    await reset()
    const stint = await addStint('950', "now() - interval '1 hour'")
    await stack.db.query(
      `INSERT INTO member_thread_outbox (member_id, kind, subject, payload, message_id)
       VALUES ('950', 'war_report', 'war:42', '{"war_id":42}'::jsonb, '4242')`,
      [],
    )
    void stint

    const body = await (await api('/api/internal/member-threads/claim')).json() as any
    const row = body.pending.find((r: any) => r.subject === 'war:42')
    expect(row).toBeDefined()
    // Without this field the bot cannot tell a correction from a first post,
    // and would add a second embed to the thread for the same war.
    expect(row.message_id).toBe('4242')
  })
})
