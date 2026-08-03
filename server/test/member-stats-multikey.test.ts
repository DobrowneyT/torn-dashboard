// #228: member-stats fans out across several pooled keys, retries a member on
// another key when one fails, and drops+disables a bad key — no member is left
// out after a single failed attempt. Job seam against the fake Torn fixture,
// with key-aware handlers (the fixture sees the key in the request URL).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, type TestStack } from './harness.js'
import { createKeyPool } from '../src/scraper/keyPool.js'
import { createTornClient } from '../src/scraper/tornClient.js'

let stack: TestStack
const ENCRYPTION_KEY = 'd'.repeat(64)
const GOOD_KEY = 'GOODKEY0000000001'
const BAD_KEY = 'BADKEY00000000002'

function deps() {
  return {
    db: stack.db,
    pool: createKeyPool({ db: stack.db, encryptionKey: ENCRYPTION_KEY }),
    client: createTornClient({ baseUrl: stack.tornBaseUrl, budget: { requests: 200, perMs: 1000 } }),
  }
}

// Handlers keyed on the request's `key`: BAD_KEY fails with `code`, GOOD_KEY
// succeeds. Gym is key-agnostic. Members 1..3 already have all backfill days, so
// only the today calls run.
function armFixture(badCode: number) {
  for (const mid of [1, 2, 3]) {
    stack.torn.setHandler(`/v2/user/${mid}/personalstats`, (url) => {
      if (url.searchParams.get('key') === BAD_KEY) return { error: { code: badCode, error: 'boom' } }
      return { personalstats: { drugs: { xanax: 10 * mid } } }
    })
  }
  stack.torn.setHandler('/v2/faction/contributors', () => ({ contributors: [] }))
}

beforeAll(async () => {
  stack = await startTestStack()
  await stack.db.query(`
    INSERT INTO members (member_id, member_name, is_current) VALUES
      ('1','One',true),('2','Two',true),('3','Three',true)
  `)
  const pool = createKeyPool({ db: stack.db, encryptionKey: ENCRYPTION_KEY })
  await pool.store('1', GOOD_KEY, { consentVersion: 'v2' })
  await pool.store('2', BAD_KEY, { consentVersion: 'v2' })
  // Pre-seed all backfill days so a run makes only the today calls.
  const today = new Date()
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  for (const mid of ['1', '2', '3']) {
    for (let i = 1; i <= 30; i++) {
      await stack.db.query(
        `INSERT INTO member_daily_stats (member_id, snapshot_date, personalstats)
         VALUES ($1, $2, '{"seeded":true}') ON CONFLICT DO NOTHING`,
        [mid, iso(new Date(today.getTime() - i * 86400_000))]
      )
    }
  }
}, 30000)

afterAll(async () => { await stack?.close() })

describe('member-stats multi-key fan-out (#228)', () => {
  it('retries a member on another key when one key rate-limits, so every member still lands', async () => {
    armFixture(5) // 5 = too many requests — transient, key stays in rotation
    const { memberStatsJob } = await import('../src/scraper/jobs/memberStats.js')
    await memberStatsJob(deps())

    // All three members got a today sample despite BAD_KEY failing every call.
    const landed = await stack.db.query(
      `SELECT DISTINCT member_id FROM member_stat_samples ORDER BY member_id`
    )
    expect(landed.rows.map((r) => r.member_id)).toEqual(['1', '2', '3'])
    // A transient error does NOT disable the key.
    const bad = await stack.db.query(`SELECT disabled FROM member_secrets WHERE member_id = '2'`)
    expect(bad.rows[0].disabled).toBe(false)
  })

  it('drops and disables a key that returns a bad-key error, finishing on the survivors', async () => {
    await stack.db.query(`DELETE FROM member_stat_samples`)
    armFixture(2) // 2 = incorrect key — the key is bad, disable + drop it
    const { memberStatsJob } = await import('../src/scraper/jobs/memberStats.js')
    await memberStatsJob(deps())

    // Every member still lands (via the good key)…
    const landed = await stack.db.query(
      `SELECT DISTINCT member_id FROM member_stat_samples ORDER BY member_id`
    )
    expect(landed.rows.map((r) => r.member_id)).toEqual(['1', '2', '3'])
    // …and the bad key is taken out of the pool.
    const bad = await stack.db.query(`SELECT disabled, last_error FROM member_secrets WHERE member_id = '2'`)
    expect(bad.rows[0].disabled).toBe(true)
    expect(bad.rows[0].last_error).toMatch(/Torn error 2/)
  })

  it('captureBoundarySamples writes a sample per member stamped at the boundary instant (#230)', async () => {
    await stack.db.query(`DELETE FROM member_stat_samples`)
    for (const mid of [1, 2, 3]) {
      stack.torn.setHandler(`/v2/user/${mid}/personalstats`, () => ({ personalstats: { drugs: { xanax: 7 * mid } } }))
    }
    stack.torn.setHandler('/v2/faction/contributors', (url) => {
      const base = url.searchParams.get('stat') === 'gymenergy' ? 5 : 0
      return { contributors: [{ id: 1, value: base * 100 }] }
    })

    const { captureBoundarySamples } = await import('../src/scraper/sampleCapture.js')
    const at = new Date('2026-09-01T18:00:00.000Z')
    const n = await captureBoundarySamples(deps(), at)

    expect(n).toBe(3)
    // Every sample is stamped at exactly the boundary instant (not now()).
    const atBoundary = await stack.db.query(
      `SELECT count(*)::int AS n FROM member_stat_samples WHERE captured_at = $1`, [at]
    )
    expect(atBoundary.rows[0].n).toBe(3)
    const rows = await stack.db.query(
      `SELECT member_id, stats, gym_energy FROM member_stat_samples ORDER BY member_id`
    )
    expect(rows.rows.map((r) => r.member_id)).toEqual(['1', '2', '3'])
    expect(rows.rows.find((r) => r.member_id === '1')!.stats).toEqual({ drugs: { xanax: 7 } })
    expect(rows.rows.find((r) => r.member_id === '1')!.gym_energy).toBe(500)
  })
})
