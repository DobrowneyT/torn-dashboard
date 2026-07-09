// Scraper core (slice #67): key pool, rate-limited Torn client, run logging,
// scheduler. Seam: the core's public TypeScript API against the Torn fixture
// and a real templated Postgres — no HTTP routes in this slice.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, type TestStack } from './harness.js'
import { createKeyPool } from '../src/scraper/keyPool.js'

let stack: TestStack

// 32 bytes, hex — the server-held key-encryption secret (env in production).
const ENCRYPTION_KEY = 'a'.repeat(64)

beforeAll(async () => {
  stack = await startTestStack()
  // member_secrets rows FK onto members.
  await stack.db.query(`
    INSERT INTO members (member_id, member_name, tier, is_current) VALUES
      ('100', 'PoolOne', 3, true),
      ('101', 'PoolTwo', 3, true),
      ('102', 'PoolThree', 3, true)
  `)
}, 30000)

afterAll(async () => {
  await stack?.close()
})

describe('key pool', () => {
  it('stores keys encrypted at rest and claims them in rotation', async () => {
    const pool = createKeyPool({ db: stack.db, encryptionKey: ENCRYPTION_KEY })
    await pool.store('100', 'AAAAKEY100AAAAAA', { keyLevel: 3, consentVersion: 'v2' })
    await pool.store('101', 'BBBBKEY101BBBBBB', { keyLevel: 3, consentVersion: 'v2' })

    // Rotation: two claims serve the two distinct keys before repeating.
    const first = await pool.claim()
    const second = await pool.claim()
    expect([first!.key, second!.key].sort()).toEqual(['AAAAKEY100AAAAAA', 'BBBBKEY101BBBBBB'])
    const third = await pool.claim()
    expect(third!.key).toBe(first!.key)

    // At rest the key bytes are ciphertext, not the plaintext key.
    const raw = await stack.db.query('SELECT cpr_api_key FROM member_secrets WHERE member_id = $1', ['100'])
    const stored = raw.rows[0].cpr_api_key as Buffer
    expect(stored.toString('utf8')).not.toContain('AAAAKEY100AAAAAA')
  })

  it('never serves disabled or non-consented keys', async () => {
    const pool = createKeyPool({ db: stack.db, encryptionKey: ENCRYPTION_KEY })
    await pool.store('102', 'CCCCKEY102CCCCCC', { keyLevel: 3, consentVersion: 'v2' })
    await pool.disable('102', 'key returned Torn error 2')
    // A row with no consent recorded must not be claimable either.
    await stack.db.query(
      `UPDATE member_secrets SET consent_at = NULL WHERE member_id = '101'`
    )

    const claims = new Set<string>()
    for (let i = 0; i < 4; i++) claims.add((await pool.claim())!.member_id)
    expect(claims).toEqual(new Set(['100']))
  })

  it('returns null when the pool is empty rather than throwing', async () => {
    await stack.db.query(`UPDATE member_secrets SET disabled = true`)
    const pool = createKeyPool({ db: stack.db, encryptionKey: ENCRYPTION_KEY })
    expect(await pool.claim()).toBeNull()
    await stack.db.query(`UPDATE member_secrets SET disabled = false`)
  })
})

describe('rate-limited Torn client', () => {
  it('holds the per-pool budget under parallel job load', async () => {
    stack.torn.setPath('/v2/faction/basic', { basic: { id: 53100 } })
    const { createTornClient } = await import('../src/scraper/tornClient.js')
    // Budget: 2 requests per 400ms window, shared by every caller.
    const client = createTornClient({ baseUrl: stack.tornBaseUrl, budget: { requests: 2, perMs: 400 } })

    const resolved: number[] = []
    await Promise.all(
      Array.from({ length: 6 }, () =>
        client.fetch('/v2/faction/basic', 'SOMEPOOLEDKEY16').then(() => resolved.push(Date.now()))
      )
    )
    resolved.sort((a, b) => a - b)

    // 6 requests at 2/window dispatch in three waves: ~0ms, ~400ms, ~800ms.
    expect(resolved).toHaveLength(6)
    expect(resolved[2] - resolved[0]).toBeGreaterThanOrEqual(350)
    expect(resolved[4] - resolved[0]).toBeGreaterThanOrEqual(750)
  })

  it('surfaces Torn error payloads as typed failures, not resolved data', async () => {
    stack.torn.setPath('/v2/faction/oops', { error: { code: 2, error: 'Incorrect key' } })
    const { createTornClient } = await import('../src/scraper/tornClient.js')
    const client = createTornClient({ baseUrl: stack.tornBaseUrl, budget: { requests: 10, perMs: 100 } })

    await expect(client.fetch('/v2/faction/oops', 'SOMEPOOLEDKEY16')).rejects.toMatchObject({
      tornCode: 2,
      message: expect.stringContaining('Incorrect key'),
    })
  })
})

describe('run logging', () => {
  it('records success with row counts and failure with the error, queryably', async () => {
    const { createRunLogger } = await import('../src/scraper/runLog.js')
    const runs = createRunLogger(stack.db)

    const ok = await runs.withRun('demo-sync', async () => {
      return { rows: 42, details: { pages: 3 } }
    })
    expect(ok.status).toBe('success')
    expect(ok.rows_written).toBe(42)
    expect(ok.finished_at).toBeTruthy()

    const bad = await runs.withRun('demo-sync', async () => {
      throw new Error('Torn API error 8: IP block')
    })
    expect(bad.status).toBe('failure')
    expect(bad.error).toContain('IP block')

    const recent = await runs.recentRuns(10)
    expect(recent.map((r) => r.status)).toEqual(['failure', 'success'])
    expect(recent[1].job_name).toBe('demo-sync')
    expect(recent[1].details).toEqual({ pages: 3 })
  })
})

describe('scheduler (end-to-end demo)', () => {
  it('a scheduled job claims a pooled key, writes rows, and logs a run; disabled jobs stay idle', async () => {
    stack.torn.setPath('/v2/faction/basic', { basic: { id: 9004, name: 'Demo Opponents', tag: 'DO' } })

    const { createKeyPool: mkPool } = await import('../src/scraper/keyPool.js')
    const { createTornClient } = await import('../src/scraper/tornClient.js')
    const { createRunLogger } = await import('../src/scraper/runLog.js')
    const { createScheduler } = await import('../src/scraper/scheduler.js')

    const pool = mkPool({ db: stack.db, encryptionKey: ENCRYPTION_KEY })
    const client = createTornClient({ baseUrl: stack.tornBaseUrl, budget: { requests: 50, perMs: 1000 } })
    const runs = createRunLogger(stack.db)
    const scheduler = createScheduler({ db: stack.db, runLogger: runs })

    // The demo job: pooled key → Torn fixture → real row → run record.
    await scheduler.register('demo-faction-sync', '* * * * * *', async () => {
      const claimed = await pool.claim()
      if (!claimed) throw new Error('no pooled key available')
      const data = await client.fetch('/v2/faction/basic', claimed.key)
      await stack.db.query(
        `INSERT INTO factions (id, name, tag) VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, tag = EXCLUDED.tag`,
        [data.basic.id, data.basic.name, data.basic.tag]
      )
      return { rows: 1, details: { used_member: claimed.member_id } }
    })
    await scheduler.register('never-runs', '* * * * * *', async () => {
      return { rows: 0 }
    })
    await stack.db.query(`UPDATE scraper_jobs SET enabled = false WHERE job_name = 'never-runs'`)

    scheduler.start()
    try {
      await new Promise((r) => setTimeout(r, 2300))
    } finally {
      scheduler.stop()
    }

    // The row landed…
    const faction = await stack.db.query(`SELECT * FROM factions WHERE id = 9004`)
    expect(faction.rows[0].name).toBe('Demo Opponents')

    // …the run was logged with the pooled key's owner in the details…
    const recent = await runs.recentRuns(20)
    const demoRuns = recent.filter((r) => r.job_name === 'demo-faction-sync')
    expect(demoRuns.length).toBeGreaterThanOrEqual(1)
    expect(demoRuns[0].status).toBe('success')
    expect(demoRuns[0].rows_written).toBe(1)
    expect(['100', '101', '102']).toContain(demoRuns[0].details!.used_member)

    // …and the disabled job never produced a run.
    expect(recent.some((r) => r.job_name === 'never-runs')).toBe(false)
  })
})
