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

  it('never claims a key flagged as lacking faction API access (defensive filter)', async () => {
    const pool = createKeyPool({ db: stack.db, encryptionKey: ENCRYPTION_KEY })
    // 100 has faction access; 101 explicitly does not — a stale/edge-case row
    // that must never be claimed for a faction-scoped call (Torn error 7).
    await pool.store('100', 'AAAAKEY100AAAAAA', { keyLevel: 3, hasFactionAccess: true, consentVersion: 'v2' })
    await pool.store('101', 'BBBBKEY101BBBBBB', { keyLevel: 3, hasFactionAccess: false, consentVersion: 'v2' })

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
  it('holds the per-key budget under parallel load on one key', async () => {
    stack.torn.setPath('/v2/faction/basic', { basic: { id: 53100 } })
    const { createTornClient } = await import('../src/scraper/tornClient.js')
    // Budget: 2 requests per 400ms window, per key.
    const client = createTornClient({ baseUrl: stack.tornBaseUrl, budget: { requests: 2, perMs: 400 } })

    // Measured from a fixed point taken BEFORE any dispatch, not from the first
    // resolution. Gaps between resolutions are a bad proxy: a loaded event loop
    // delays the first one, which compresses every gap measured against it, so
    // the test failed on total suite load rather than on the limiter. (Seen at
    // 246ms against a 250ms floor when #385 added a file to the run.) A fixed
    // baseline cannot be compressed, which makes these floors both steadier and
    // tighter than the ones they replace.
    const t0 = Date.now()
    const resolved: number[] = []
    await Promise.all(
      Array.from({ length: 6 }, () =>
        client.fetch('/v2/faction/basic', 'SOMEPOOLEDKEY16').then(() => resolved.push(Date.now()))
      )
    )
    resolved.sort((a, b) => a - b)

    // 6 requests on ONE key at 2/window dispatch in three waves: ~0ms, ~400ms,
    // ~800ms. An unthrottled client would land all six near t0.
    expect(resolved).toHaveLength(6)
    expect(resolved[2] - t0).toBeGreaterThanOrEqual(350)
    expect(resolved[4] - t0).toBeGreaterThanOrEqual(750)
  })

  it('rate-limits each key independently, so multiple keys multiply throughput (#228)', async () => {
    stack.torn.setPath('/v2/faction/basic', { basic: { id: 53100 } })
    const { createTornClient } = await import('../src/scraper/tornClient.js')
    // Budget: 1 request per 400ms window, PER KEY.
    const client = createTornClient({ baseUrl: stack.tornBaseUrl, budget: { requests: 1, perMs: 400 } })

    const resolved: number[] = []
    // Three distinct keys, one request each: each key's own window admits it
    // immediately, so all three land in the first wave. A shared budget would
    // have serialised them into three waves (~0/400/800ms).
    await Promise.all(
      ['KEYAAAAAAAAAAAA1', 'KEYBBBBBBBBBBBB2', 'KEYCCCCCCCCCCCC3'].map((k) =>
        client.fetch('/v2/faction/basic', k).then(() => resolved.push(Date.now()))
      )
    )
    resolved.sort((a, b) => a - b)
    expect(resolved).toHaveLength(3)
    expect(resolved[2] - resolved[0]).toBeLessThan(300)
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

  it('startRun returns a running record immediately and settles the row in the background', async () => {
    const { createRunLogger } = await import('../src/scraper/runLog.js')
    const runs = createRunLogger(stack.db)

    // A body the test controls: it stays pending until we release it, standing
    // in for a long job (member-stats runs for minutes). The caller must not
    // block on it — a synchronous trigger holds the HTTP request open and nginx
    // 502s at 60s.
    let release: (r: { rows: number }) => void = () => {}
    const gate = new Promise<{ rows: number }>((res) => { release = res })

    const started = await runs.startRun('bg-demo', () => gate)
    // Returned while the body is still pending.
    expect(started.status).toBe('running')
    expect(started.finished_at).toBeNull()
    expect(started.id).toBeTruthy()
    const midRow = await stack.db.query('SELECT status FROM scraper_runs WHERE id = $1', [started.id])
    expect(midRow.rows[0].status).toBe('running')

    // Once the body resolves, the background settle closes the row.
    release({ rows: 7 })
    let settled: { status: string; rows_written: number; finished_at: string | null } | undefined
    for (let i = 0; i < 50 && settled?.status !== 'success'; i++) {
      settled = (await stack.db.query(
        'SELECT status, rows_written, finished_at FROM scraper_runs WHERE id = $1', [started.id]
      )).rows[0]
      if (settled?.status !== 'success') await new Promise((r) => setTimeout(r, 20))
    }
    expect(settled!.status).toBe('success')
    expect(settled!.rows_written).toBe(7)
    expect(settled!.finished_at).toBeTruthy()
  })

  it('reapOrphanedRuns fails leftover running rows on boot and leaves finished runs alone', async () => {
    const { createRunLogger } = await import('../src/scraper/runLog.js')
    const runs = createRunLogger(stack.db)

    // A finished run (must survive the reap) and an orphan left 'running' the
    // way a job killed mid-flight by a redeploy/crash leaves it.
    const good = await runs.withRun('reap-demo', async () => ({ rows: 3 }))
    const orphan = await stack.db.query(
      `INSERT INTO scraper_runs (job_name, status) VALUES ('reap-demo', 'running') RETURNING id`
    )
    const orphanId = orphan.rows[0].id

    const reaped = await runs.reapOrphanedRuns()
    expect(reaped).toBeGreaterThanOrEqual(1)

    const rows = await stack.db.query(
      'SELECT id, status, error, finished_at FROM scraper_runs WHERE id = ANY($1)', [[good.id, orphanId]]
    )
    const byId = Object.fromEntries(rows.rows.map((r) => [String(r.id), r]))
    // The orphan is closed out as a failure with a restart marker.
    expect(byId[String(orphanId)].status).toBe('failure')
    expect(byId[String(orphanId)].error).toMatch(/interrupt|restart/i)
    expect(byId[String(orphanId)].finished_at).toBeTruthy()
    // The already-finished run is untouched.
    expect(byId[String(good.id)].status).toBe('success')
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

    // Registration defaults every job to disabled — enabling is the admin's
    // explicit bring-up step (Global Admin), mirrored here for the demo job;
    // 'never-runs' stays at the default.
    const fresh = await stack.db.query(
      `SELECT enabled FROM scraper_jobs WHERE job_name IN ('demo-faction-sync', 'never-runs')`
    )
    expect(fresh.rows.map((r) => r.enabled)).toEqual([false, false])
    await stack.db.query(`UPDATE scraper_jobs SET enabled = true WHERE job_name = 'demo-faction-sync'`)

    scheduler.start()
    try {
      await new Promise((r) => setTimeout(r, 2300))
    } finally {
      scheduler.stop()
    }

    // The row landed…
    const faction = await stack.db.query(`SELECT * FROM factions WHERE id = 9004`)
    expect(faction.rows[0].name).toBe('Demo Opponents')

    // …the run was logged with the pooled key's owner in the details.
    // stop() doesn't cancel an in-flight tick, so the newest row may still
    // be 'running' on a slow runner — assert on the newest completed run.
    const recent = await runs.recentRuns(20)
    const demoRuns = recent.filter((r) => r.job_name === 'demo-faction-sync')
    expect(demoRuns.length).toBeGreaterThanOrEqual(1)
    const finished = demoRuns.find((r) => r.status !== 'running')
    expect(finished).toBeTruthy()
    expect(finished!.status).toBe('success')
    expect(finished!.rows_written).toBe(1)
    expect(['100', '101', '102']).toContain(finished!.details!.used_member)

    // …and the disabled job never produced a run.
    expect(recent.some((r) => r.job_name === 'never-runs')).toBe(false)
  })

  describe('cadence: faction override, fleet default, code default (#609 slice 5)', () => {
    const mkScheduler = async (flags?: unknown) => {
      const { createRunLogger } = await import('../src/scraper/runLog.js')
      const { createScheduler } = await import('../src/scraper/scheduler.js')
      return createScheduler({
        db: stack.db, runLogger: createRunLogger(stack.db), flags: flags as never,
      })
    }

    /** A resolver over a fixed map, with no database behind it. */
    const fleetFlags = (entries: Record<string, unknown>) => ({
      async get(key: string) {
        return key in entries
          ? { key, value: entries[key], source: 'fleet' as const }
          : { key, value: undefined, source: 'unset' as const }
      },
      async all() { return [] },
      invalidate() {},
    })

    it('⚠️ registers a new job with a NULL schedule, not the seeded default', async () => {
      // Seeding the code default made every job look permanently customised,
      // which left the fleet layer with nothing to say.
      const scheduler = await mkScheduler()
      await scheduler.register('cadence-fresh', '0 0 * * * *', async () => ({ rows: 0 }))
      const row = await stack.db.query(
        `SELECT cron_schedule FROM scraper_jobs WHERE job_name = 'cadence-fresh'`
      )
      expect(row.rows[0].cron_schedule).toBeNull()
    })

    it('⚠️ adopts a previously-seeded row that nobody ever edited', async () => {
      // The old registration wrote the code default into the column. A row
      // holding exactly that string was written by the seed and never touched,
      // so it is cleared and follows the fleet from now on.
      await stack.db.query(
        `INSERT INTO scraper_jobs (job_name, cron_schedule, enabled) VALUES ('cadence-seeded', '0 5 * * * *', false)`
      )
      const scheduler = await mkScheduler()
      await scheduler.register('cadence-seeded', '0 5 * * * *', async () => ({ rows: 0 }))
      const row = await stack.db.query(
        `SELECT cron_schedule FROM scraper_jobs WHERE job_name = 'cadence-seeded'`
      )
      expect(row.rows[0].cron_schedule).toBeNull()
    })

    it("⚠️ leaves a row an operator actually changed alone", async () => {
      // The inference above is only safe because it cannot touch this case.
      await stack.db.query(
        `INSERT INTO scraper_jobs (job_name, cron_schedule, enabled) VALUES ('cadence-edited', '0 30 * * * *', false)`
      )
      const scheduler = await mkScheduler()
      await scheduler.register('cadence-edited', '0 5 * * * *', async () => ({ rows: 0 }))
      const row = await stack.db.query(
        `SELECT cron_schedule FROM scraper_jobs WHERE job_name = 'cadence-edited'`
      )
      expect(row.rows[0].cron_schedule).toBe('0 30 * * * *')
    })

    it('resolves each layer and reports where the cadence came from', async () => {
      const scheduler = await mkScheduler(fleetFlags({
        'scraper.schedule.cadence-fleet': '0 0 */2 * * *',
        'scraper.schedule.cadence-local': '0 0 */2 * * *',
      }))
      await scheduler.register('cadence-fleet', '0 5 * * * *', async () => ({ rows: 0 }))
      await scheduler.register('cadence-plain', '0 6 * * * *', async () => ({ rows: 0 }))
      await scheduler.register('cadence-local', '0 7 * * * *', async () => ({ rows: 0 }))
      await stack.db.query(
        `UPDATE scraper_jobs SET cron_schedule = '0 15 * * * *' WHERE job_name = 'cadence-local'`
      )

      await scheduler.start()
      try {
        const byName = new Map(scheduler.schedules().map((r) => [r.jobName, r]))
        expect(byName.get('cadence-fleet')).toMatchObject({ effective: '0 0 */2 * * *', source: 'fleet' })
        expect(byName.get('cadence-plain')).toMatchObject({ effective: '0 6 * * * *', source: 'default' })
        expect(byName.get('cadence-local')).toMatchObject({ effective: '0 15 * * * *', source: 'tenant' })
      } finally {
        scheduler.stop()
      }
    })

    it('⚠️ a malformed fleet default does not stop the jobs after it starting', async () => {
      // cron.schedule() throws on a bad expression and start() registers in a
      // loop, so one bad character typed once into a FLEET flag would stop
      // scraping for every faction — with the only symptom being that data
      // quietly stopped arriving.
      const scheduler = await mkScheduler(fleetFlags({
        'scraper.schedule.cadence-broken': 'every 6 hours',
      }))
      await scheduler.register('cadence-broken', '0 8 * * * *', async () => ({ rows: 0 }))
      await scheduler.register('cadence-after', '0 9 * * * *', async () => ({ rows: 0 }))

      await expect(scheduler.start()).resolves.toBeUndefined()
      try {
        const byName = new Map(scheduler.schedules().map((r) => [r.jobName, r]))
        expect(byName.get('cadence-broken')).toMatchObject({
          effective: '0 8 * * * *', source: 'default', rejected: 'every 6 hours',
        })
        expect(byName.get('cadence-after')).toMatchObject({ effective: '0 9 * * * *' })
      } finally {
        scheduler.stop()
      }
    })
  })

  it('a tick that rejects (pool gone under a live scheduler) never escapes as an unhandled rejection', async () => {
    const { createRunLogger } = await import('../src/scraper/runLog.js')
    const { createScheduler } = await import('../src/scraper/scheduler.js')

    // A db that answers register()/start() but throws inside every tick — the
    // way a pool torn down under a running scheduler (e.g. at shutdown, or a
    // transient outage) does. The tick must swallow that, not crash the process.
    let live = true
    const db = {
      query: async (sql: string) => {
        if (sql.includes('SELECT job_name')) {
          return { rows: [{ job_name: 'flaky', cron_schedule: '* * * * * *' }] }
        }
        if (!live) throw new Error('pool is closed')
        return { rows: [] }
      },
    } as unknown as (typeof stack)['db']

    const scheduler = createScheduler({ db, runLogger: createRunLogger(db) })
    await scheduler.register('flaky', '* * * * * *', async () => ({ rows: 0 }))

    const rejections: unknown[] = []
    const onReject = (err: unknown) => rejections.push(err)
    process.on('unhandledRejection', onReject)
    try {
      await scheduler.start()
      live = false // pull the pool out from under the running scheduler
      await new Promise((r) => setTimeout(r, 1300)) // let a cron tick fire against it
    } finally {
      scheduler.stop()
      await new Promise((r) => setTimeout(r, 50)) // drain any pending rejection
      process.off('unhandledRejection', onReject)
    }
    expect(rejections).toEqual([])
  })
})

// #963 — a tick must not start a second copy of a job that is still running.
//
// ⚠️ Nothing stopped it before. During a Torn outage a run outlives its
// cadence, and each overlapping copy claimed its own pooled key and opened its
// own connection to an API that was not answering — then they all resumed at
// once when Torn came back.
describe('overlap guard (#963)', () => {
  const mk = async () => {
    const { createRunLogger } = await import('../src/scraper/runLog.js')
    const { createScheduler } = await import('../src/scraper/scheduler.js')
    return createScheduler({ db: stack.db, runLogger: createRunLogger(stack.db) })
  }
  const enable = (name: string) =>
    stack.db.query(`UPDATE scraper_jobs SET enabled = true WHERE job_name = $1`, [name])

  it('⚠️ never runs two copies of one job at once', async () => {
    const scheduler = await mk()
    let active = 0
    let maxActive = 0
    let starts = 0
    // Slower than its own one-second cadence — the outage shape.
    await scheduler.register('overlap-slow', '* * * * * *', async () => {
      starts += 1
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 2_500))
      active -= 1
      return { rows: 0 }
    })
    await enable('overlap-slow')

    scheduler.start()
    try {
      await new Promise((r) => setTimeout(r, 3_200))
    } finally {
      scheduler.stop()
    }
    // Let the in-flight run settle before the stack is torn down.
    await new Promise((r) => setTimeout(r, 2_600))

    expect(starts).toBeGreaterThanOrEqual(1)
    expect(maxActive).toBe(1)
  }, 15_000)

  it('⚠️ a DISABLED tick releases the guard, so re-enabling the job works', async () => {
    // THE case `finally` protects. A tick on a disabled job adds it to the
    // in-flight set and returns early; without `finally` it is never removed,
    // so switching a job off and back on would leave it skipped for the life
    // of the process — silently.
    //
    // ⚠️ An earlier version of this test had a job THROW and asserted it ran
    // again. It passed with the guard released outside `finally`, because
    // `withRun` never throws — it records the failure on the run row. The
    // probe caught it; the test was guarding nothing.
    const scheduler = await mk()
    let starts = 0
    await scheduler.register('overlap-toggled', '* * * * * *', async () => {
      starts += 1
      return { rows: 0 }
    })
    // Left DISABLED: every tick takes the early-return path.
    scheduler.start()
    try {
      await new Promise((r) => setTimeout(r, 1_600))
      expect(starts).toBe(0)
      await enable('overlap-toggled')
      await new Promise((r) => setTimeout(r, 2_200))
    } finally {
      scheduler.stop()
    }
    await new Promise((r) => setTimeout(r, 300))
    expect(starts).toBeGreaterThanOrEqual(1)
  }, 10_000)

  it('different jobs are not blocked by each other', async () => {
    // The guard is per JOB. One slow scraper must not hold up the rest.
    const scheduler = await mk()
    let fastStarts = 0
    await scheduler.register('overlap-hog', '* * * * * *', async () => {
      await new Promise((r) => setTimeout(r, 2_500))
      return { rows: 0 }
    })
    await scheduler.register('overlap-fast', '* * * * * *', async () => {
      fastStarts += 1
      return { rows: 0 }
    })
    await enable('overlap-hog')
    await enable('overlap-fast')

    scheduler.start()
    try {
      await new Promise((r) => setTimeout(r, 2_400))
    } finally {
      scheduler.stop()
    }
    await new Promise((r) => setTimeout(r, 2_600))
    expect(fastStarts).toBeGreaterThanOrEqual(2)
  }, 12_000)
})
