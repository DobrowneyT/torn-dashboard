// #247: member-stats writes each backfilled (member, date) snapshot as it is
// fetched, so an interruption during the long backfill phase keeps the days
// already captured — the next run only fetches the still-missing days. Job seam
// against the fake Torn fixture, with a db that fails part-way to simulate a
// crash mid-backfill.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, type TestStack } from './harness.js'
import { createKeyPool } from '../src/scraper/keyPool.js'
import { createTornClient } from '../src/scraper/tornClient.js'

let stack: TestStack
const ENCRYPTION_KEY = 'f'.repeat(64)

function pool() {
  return createKeyPool({ db: stack.db, encryptionKey: ENCRYPTION_KEY })
}
function client() {
  return createTornClient({ baseUrl: stack.tornBaseUrl, budget: { requests: 500, perMs: 1000 } })
}

beforeAll(async () => {
  stack = await startTestStack()
  await stack.db.query(`
    INSERT INTO members (member_id, member_name, is_current) VALUES ('1','One',true),('2','Two',true)
  `)
  const p = pool()
  await p.store('1', 'INCRKEY0000000001', { consentVersion: 'v2' })
  await p.store('2', 'INCRKEY0000000002', { consentVersion: 'v2' })
  for (const mid of [1, 2]) {
    stack.torn.setHandler(`/v2/user/${mid}/personalstats`, () => ({ personalstats: { drugs: { xanax: 5 } } }))
  }
  stack.torn.setHandler('/v2/faction/contributors', () => ({ contributors: [] }))
}, 30000)

afterAll(async () => { await stack?.close() })

describe('member-stats incremental backfill (#247)', () => {
  it('persists a member\'s backfilled days before a later crash loses the run', async () => {
    // Fail the SECOND member\'s existing-days check to simulate a crash after
    // member 1\'s backfill but before the run completes.
    let existingChecks = 0
    const db = {
      query: (text: string, params?: unknown[]) => {
        if (typeof text === 'string' && text.includes('SELECT snapshot_date FROM member_daily_stats')) {
          existingChecks += 1
          if (existingChecks === 2) return Promise.reject(new Error('simulated crash during backfill'))
        }
        return (stack.db.query as any)(text, params)
      },
    }

    const { memberStatsJob } = await import('../src/scraper/jobs/memberStats.js')
    await expect(memberStatsJob({ db, pool: pool(), client: client() } as any)).rejects.toThrow(/simulated crash/)

    // Member 1's 30 backfilled days were written as they were fetched — they
    // survive the crash (old buffer-to-the-end code would have persisted none).
    const one = await stack.db.query(`SELECT count(*)::int AS n FROM member_daily_stats WHERE member_id = '1'`)
    expect(one.rows[0].n).toBe(30)
    const two = await stack.db.query(`SELECT count(*)::int AS n FROM member_daily_stats WHERE member_id = '2'`)
    expect(two.rows[0].n).toBe(0)
  })

  it('a resumed run only fetches the still-missing days', async () => {
    // Fresh member with no history; a clean run writes 30 backfill days + today.
    await stack.db.query(`INSERT INTO members (member_id, member_name, is_current) VALUES ('3','Three',true)`)
    stack.torn.setHandler('/v2/user/3/personalstats', () => ({ personalstats: { drugs: { xanax: 9 } } }))

    const calls: string[] = []
    const countingClient = {
      fetch: (path: string, key: string) => { calls.push(path); return client().fetch(path, key) },
    }
    const { memberStatsJob } = await import('../src/scraper/jobs/memberStats.js')
    await memberStatsJob({ db: stack.db, pool: pool(), client: countingClient as any })

    const backfillFirst = calls.filter((p) => p.includes('/v2/user/3/') && p.includes('timestamp=')).length
    expect(backfillFirst).toBe(30)

    // Second run: member 3's days are all present now → no backfill calls for them.
    calls.length = 0
    await memberStatsJob({ db: stack.db, pool: pool(), client: countingClient as any })
    const backfillSecond = calls.filter((p) => p.includes('/v2/user/3/') && p.includes('timestamp=')).length
    expect(backfillSecond).toBe(0)
  })
})
