// The wrap-up job end to end against real Postgres (#945).
//
// ⚠️ What only a database and real sequencing can get wrong: the retry clock
// being measured from first sight rather than from the current run, the roster
// insert not double-queuing on a re-run, and dibs-summary running AFTER the
// attack scrape rather than beside it.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startTestStack, TEST_KEY_ENCRYPTION_KEY, type TestStack } from './harness.js'
import { warWrapUpJob } from '../src/scraper/jobs/warWrapUp.js'
import { WRAP_UP_SETTING } from '../src/warWrapUp.js'
import { createKeyPool } from '../src/scraper/keyPool.js'
import { createTornClient } from '../src/scraper/tornClient.js'

let stack: TestStack
const WAR = 5150
const START = 1_791_000_000
const END = START + 7200

/** Records the order jobs were driven in, so sequencing can be asserted. */
let ran: string[] = []

const deps = (over: Record<string, unknown> = {}) => ({
  db: stack.db,
  pool: createKeyPool({ db: stack.db, encryptionKey: TEST_KEY_ENCRYPTION_KEY }),
  client: createTornClient({ baseUrl: stack.tornBaseUrl }),
  runJob: async (name: string) => { ran.push(name) },
  ...over,
}) as any

async function setDibsJob(enabled: boolean) {
  await stack.db.query(
    `INSERT INTO scraper_jobs (job_name, cron_schedule, enabled) VALUES ('dibs-summary', NULL, $1)
     ON CONFLICT (job_name) DO UPDATE SET enabled = $1`, [enabled])
}

async function addWar(id = WAR, over: Record<string, unknown> = {}) {
  await stack.db.query(
    `INSERT INTO ranked_wars (id, opponent_id, opponent_name, start_at, end_at,
                              our_score, opponent_score, report_unavailable)
     VALUES ($1, 20747, 'Them', $2, $3, 10, 5, $4)
     ON CONFLICT (id) DO UPDATE SET end_at = EXCLUDED.end_at,
                                    report_unavailable = EXCLUDED.report_unavailable`,
    [id, START, over.end_at === null ? null : END, over.report_unavailable ?? false])
}

async function addContributions(warId = WAR, n = 3) {
  for (let i = 0; i < n; i++) {
    await stack.db.query(
      `INSERT INTO war_member_contributions (war_id, member_id, member_name, score)
       VALUES ($1, $2, $3, 100) ON CONFLICT DO NOTHING`,
      [warId, 500 + i, `M${i}`])
  }
}

async function addAttack() {
  await stack.db.query(
    `INSERT INTO faction_attacks (attack_id, started, result, attacker_id, is_ranked_war)
     VALUES ($1, $2, 'Attacked', 501, true) ON CONFLICT DO NOTHING`,
    [Math.floor(Math.random() * 1e12), START + 10])
}

beforeAll(async () => {
  stack = await startTestStack()
  for (let i = 0; i < 4; i++) {
    await stack.db.query(
      `INSERT INTO members (member_id, member_name, is_current) VALUES ($1, $2, true)
       ON CONFLICT (member_id) DO NOTHING`, [String(600 + i), `Member${i}`])
  }
  // One former member, who must NOT be queued.
  await stack.db.query(
    `INSERT INTO members (member_id, member_name, is_current) VALUES ('699', 'Gone', false)
     ON CONFLICT (member_id) DO NOTHING`)
}, 30000)

afterAll(async () => { await stack?.close() })

beforeEach(async () => {
  ran = []
  await stack.db.query('DELETE FROM member_thread_outbox')
  await stack.db.query('DELETE FROM war_wrap_up_state')
  await stack.db.query('DELETE FROM war_dibs_summary_state')
  await stack.db.query('DELETE FROM war_member_contributions')
  await stack.db.query('DELETE FROM faction_attacks')
  await stack.db.query('DELETE FROM ranked_wars')
  await stack.db.query(`DELETE FROM faction_settings WHERE key = $1`, [WRAP_UP_SETTING])
  await setDibsJob(false)
})

describe('a war that has not ended', () => {
  it('is not touched at all', async () => {
    await addWar(WAR, { end_at: null })
    const res = await warWrapUpJob(deps())
    expect(res.details).toMatchObject({ wars: 0 })
    const state = await stack.db.query('SELECT count(*)::int AS n FROM war_wrap_up_state')
    expect(state.rows[0].n).toBe(0)
  })
})

describe('driving the other jobs', () => {
  it('⚠️ runs dibs-summary AFTER the attack scrape, never beside it', async () => {
    // dibs-summary classifies a claim by finding the attack that explains it.
    // Run first, it records real conversions as "no swing" — permanently, in
    // threads with members' names on them.
    await setDibsJob(true)
    await addWar(); await addContributions(); await addAttack()
    await stack.db.query(
      `INSERT INTO war_dibs_summary_state (war_id, claims_seen, grace_seconds)
       VALUES ($1, 0, 120)`, [WAR])
    await warWrapUpJob(deps())
    expect(ran.indexOf('dibs-summary')).toBeGreaterThan(ran.indexOf('attacks-sync'))
  })

  it('does not run dibs-summary at all when it is disabled', async () => {
    await addWar(); await addContributions(); await addAttack()
    await warWrapUpJob(deps())
    expect(ran).toContain('attacks-sync')
    expect(ran).not.toContain('dibs-summary')
  })

  it('drives attacks, revives and wars-sync', async () => {
    await addWar(); await addContributions(); await addAttack()
    await warWrapUpJob(deps())
    expect(ran).toEqual(['attacks-sync', 'revives-sync', 'wars-sync'])
  })

  it('⚠️ a failing scrape does not abort the wrap-up', async () => {
    // The gate is "is the data there", not "did every scrape report success".
    await addWar(); await addContributions(); await addAttack()
    const res = await warWrapUpJob(deps({
      runJob: async (n: string) => { if (n === 'revives-sync') throw new Error('boom') },
    }))
    const state = await stack.db.query('SELECT state FROM war_wrap_up_state WHERE war_id = $1', [WAR])
    expect(state.rows[0].state).toBe('queued')
    expect(JSON.stringify(res.details)).toContain('revives-sync')
  })
})

describe('queueing the roster', () => {
  it('queues every CURRENT member, participants and not', async () => {
    await addWar(); await addContributions(WAR, 1); await addAttack()
    const res = await warWrapUpJob(deps())
    expect(res.rows).toBe(4)
    const rows = await stack.db.query(
      `SELECT member_id, kind, subject FROM member_thread_outbox ORDER BY member_id`)
    // ⚠️ Four current members, though only ONE has a contribution row. A zero
    // row is a keep/kick input, not padding.
    expect(rows.rows.map((r: any) => r.member_id)).toEqual(['600', '601', '602', '603'])
    expect(rows.rows[0].subject).toBe(`war:${WAR}`)
    expect(rows.rows[0].kind).toBe('war_report')
  })

  it('does not queue a former member', async () => {
    await addWar(); await addContributions(); await addAttack()
    await warWrapUpJob(deps())
    const gone = await stack.db.query(
      `SELECT count(*)::int AS n FROM member_thread_outbox WHERE member_id = '699'`)
    expect(gone.rows[0].n).toBe(0)
  })

  it('⚠️ a re-run does NOT double-queue, and does not re-open posted entries', async () => {
    // THE re-runnability rule. The admin route re-opens a posted entry on
    // purpose — that means "correct this one". A wrap-up re-run means "finish
    // what you could not finish", and re-opening there would re-post the whole
    // roster: ~94 edits nobody asked for.
    await addWar(); await addContributions(); await addAttack()
    await warWrapUpJob(deps())
    await stack.db.query(
      `UPDATE member_thread_outbox SET posted_at = now(), message_id = '1'`)
    // Force another pass over the same war.
    await stack.db.query(`UPDATE war_wrap_up_state SET state = 'waiting' WHERE war_id = $1`, [WAR])

    const again = await warWrapUpJob(deps())
    expect(again.rows).toBe(0)
    const rows = await stack.db.query(
      `SELECT count(*)::int AS n, count(posted_at)::int AS posted FROM member_thread_outbox`)
    expect(rows.rows[0].n).toBe(4)
    // Still posted: untouched.
    expect(rows.rows[0].posted).toBe(4)
  })

  it('a war that reached queued is never looked at again', async () => {
    await addWar(); await addContributions(); await addAttack()
    await warWrapUpJob(deps())
    ran = []
    const second = await warWrapUpJob(deps())
    expect(second.details).toMatchObject({ wars: 0 })
    expect(ran).toEqual([])
  })
})

describe('refusing to queue', () => {
  it('waits when contributions have not arrived', async () => {
    await addWar(); await addAttack()
    const res = await warWrapUpJob(deps())
    expect(res.rows).toBe(0)
    const state = await stack.db.query(
      'SELECT state, last_error FROM war_wrap_up_state WHERE war_id = $1', [WAR])
    expect(state.rows[0].state).toBe('waiting')
    expect(state.rows[0].last_error).toMatch(/contributions/)
    const out = await stack.db.query('SELECT count(*)::int AS n FROM member_thread_outbox')
    expect(out.rows[0].n).toBe(0)
  })

  it('⚠️ fails loudly on report_unavailable without waiting', async () => {
    await addWar(WAR, { report_unavailable: true }); await addAttack()
    await warWrapUpJob(deps())
    const state = await stack.db.query(
      'SELECT state, last_error FROM war_wrap_up_state WHERE war_id = $1', [WAR])
    expect(state.rows[0].state).toBe('failed')
    expect(state.rows[0].last_error).toMatch(/permanently unavailable/)
    const out = await stack.db.query('SELECT count(*)::int AS n FROM member_thread_outbox')
    expect(out.rows[0].n).toBe(0)
  })

  it('⚠️ the retry clock runs from FIRST SIGHT, not from this run', async () => {
    // Without a persisted first_seen_at, minutesWaiting is 0 on every pass and
    // the window never expires — a war waits for ever and nobody is told.
    await addWar(); await addAttack()
    await warWrapUpJob(deps())           // creates the state row, waits
    await stack.db.query(
      `UPDATE war_wrap_up_state SET first_seen_at = now() - interval '5 hours'
        WHERE war_id = $1`, [WAR])

    await warWrapUpJob(deps())
    const state = await stack.db.query(
      'SELECT state, attempts FROM war_wrap_up_state WHERE war_id = $1', [WAR])
    expect(state.rows[0].state).toBe('failed')
    expect(state.rows[0].attempts).toBeGreaterThan(1)
  })

  it('a failed war can be re-run once a human has fixed it', async () => {
    await addWar(); await addAttack()
    await stack.db.query(
      `INSERT INTO war_wrap_up_state (war_id, state, first_seen_at)
       VALUES ($1, 'waiting', now() - interval '5 hours')`, [WAR])
    await warWrapUpJob(deps())
    expect((await stack.db.query(
      'SELECT state FROM war_wrap_up_state WHERE war_id = $1', [WAR])).rows[0].state).toBe('failed')

    // The human supplies what was missing and re-opens it.
    await addContributions()
    await stack.db.query(`UPDATE war_wrap_up_state SET state = 'waiting' WHERE war_id = $1`, [WAR])
    const res = await warWrapUpJob(deps())
    expect(res.rows).toBe(4)
    expect((await stack.db.query(
      'SELECT state FROM war_wrap_up_state WHERE war_id = $1', [WAR])).rows[0].state).toBe('queued')
  })

  it('honours a configured retry window', async () => {
    await stack.db.query(
      `INSERT INTO faction_settings (key, value) VALUES ($1, '{"retry_window_minutes": 1}'::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [WRAP_UP_SETTING])
    await addWar(); await addAttack()
    await stack.db.query(
      `INSERT INTO war_wrap_up_state (war_id, first_seen_at)
       VALUES ($1, now() - interval '2 minutes')`, [WAR])
    const res = await warWrapUpJob(deps())
    expect(res.details).toMatchObject({ window_minutes: 1 })
    expect((await stack.db.query(
      'SELECT state FROM war_wrap_up_state WHERE war_id = $1', [WAR])).rows[0].state).toBe('failed')
  })
})
