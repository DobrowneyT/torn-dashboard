// #632 follow-up — retention for the run log itself.
//
// `scraper_runs` was append-only since launch, ~2,250 rows a day per tenant, and
// on 2026-09-10 that growth turned an inefficient fleet-metrics query into a
// live outage: ten abandoned copies of it piled up on one tenant and took a
// four-core box to a load average of 13.5.
//
// ⚠️ The tests that matter here are not "does it delete things". They are the
// ones proving it does NOT delete the two rows the fleet-metrics endpoint
// computes its numbers from — because losing either corrupts an alert silently,
// in the direction of looking healthier than the truth.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startTestStack, type TestStack } from './harness.js'
import { scraperRunsPruneJob, RETENTION_DAYS } from '../src/scraper/jobs/scraperRunsPrune.js'
import { collectFleetMetrics } from '../src/fleetMetrics.js'

let stack: TestStack

beforeAll(async () => { stack = await startTestStack() }, 60000)
afterAll(async () => { await stack?.close() })

beforeEach(async () => {
  await stack.db.query('DELETE FROM scraper_runs')
  await stack.db.query('DELETE FROM scraper_jobs')
})

/** `age` in days before now. */
const run = (jobName: string, age: number, status: string, error: string | null = null) =>
  stack.db.query(
    `INSERT INTO scraper_runs (job_name, started_at, status, error)
     VALUES ($1, now() - ($2 || ' days')::interval, $3, $4)`,
    [jobName, String(age), status, error]
  )

const enable = (jobName: string) =>
  stack.db.query(
    `INSERT INTO scraper_jobs (job_name, cron_schedule, enabled) VALUES ($1, NULL, true)
     ON CONFLICT (job_name) DO UPDATE SET enabled = true`,
    [jobName]
  )

const remaining = async () => {
  const r = await stack.db.query(
    // ⚠️ Rounded from seconds, not `extract(day ...)`, which truncates — a row
    // inserted 200 days ago reads as 199 the moment a DST boundary is crossed.
    `SELECT job_name, status,
            round(extract(epoch from now() - started_at) / 86400)::int AS age
       FROM scraper_runs ORDER BY started_at`
  )
  return r.rows.map((x) => `${x.job_name}/${x.status}/${x.age}d`)
}

describe('scraperRunsPruneJob', () => {
  it('deletes dead history past the retention window', async () => {
    await run('healthy', 200, 'success')
    await run('healthy', 100, 'success')
    await run('healthy', 60, 'failure', 'transient')
    await run('healthy', 1, 'success')
    const res = await scraperRunsPruneJob({ db: stack.db } as never)
    // The two ancient successes and the recovered failure are gone; the newest
    // success stays because it is the newest, not because it is recent.
    expect(res.rows).toBe(3)
    expect(await remaining()).toEqual(['healthy/success/1d'])
  })

  it('keeps everything inside the window untouched', async () => {
    await run('healthy', RETENTION_DAYS - 1, 'success')
    await run('healthy', 2, 'failure', 'transient')
    await run('healthy', 1, 'success')
    const res = await scraperRunsPruneJob({ db: stack.db } as never)
    expect(res.rows).toBe(0)
    expect(await remaining()).toHaveLength(3)
  })

  it('⚠️ keeps a job\'s newest success however old it is', async () => {
    // The failure this guards: lastSuccessAt is null for a job that has NEVER
    // succeeded, and that is deliberately distinct from "succeeded long ago".
    // Prune the old success and a quiet-but-working job starts reporting as one
    // that has never worked in its life.
    await enable('quiet')
    await run('quiet', 400, 'success')
    await run('quiet', 300, 'failure', 'ancient, since recovered')
    await run('quiet', 200, 'success')   // newest success, 200 days old
    await run('quiet', 100, 'failure', 'still broken')
    await run('quiet', 50, 'failure', 'still broken')

    await scraperRunsPruneJob({ db: stack.db } as never)
    expect(await remaining()).toEqual([
      'quiet/success/200d', 'quiet/failure/100d', 'quiet/failure/50d',
    ])

    const m = await collectFleetMetrics(stack.db)
    const f = m.scrapers.failing.find((x) => x.jobName === 'quiet')!
    // ⚠️ A DATE, not null. This is the whole point of the exception.
    expect(f.lastSuccessAt).not.toBeNull()
    expect(f.consecutiveFailures).toBe(2)
  })

  it('⚠️ keeps the entire current failure streak, so the count cannot shrink', async () => {
    // The other silent corruption: consecutiveFailures counts back to the last
    // success. Prune any of those failures and the number quietly drops as the
    // outage deepens — the alert under-reporting exactly when it matters.
    await enable('breaking')
    await run('breaking', 120, 'success')
    for (const age of [110, 90, 70, 45, 40, 2]) await run('breaking', age, 'failure', 'no key')

    const before = await collectFleetMetrics(stack.db)
    await scraperRunsPruneJob({ db: stack.db } as never)
    const after = await collectFleetMetrics(stack.db)

    const streak = (m: Awaited<ReturnType<typeof collectFleetMetrics>>) =>
      m.scrapers.failing.find((x) => x.jobName === 'breaking')!.consecutiveFailures
    expect(streak(before)).toBe(6)
    expect(streak(after)).toBe(6)
  })

  it('⚠️ keeps everything for a job that has NEVER succeeded', async () => {
    // capacityx's shape in #645. Every failure it has ever logged is part of the
    // current streak, so there is nothing here that is safe to drop. Capping it
    // would mean under-reporting the most broken job on the fleet.
    await enable('never-worked')
    for (const age of [365, 200, 100, 1]) await run('never-worked', age, 'failure', 'no faction access')
    const res = await scraperRunsPruneJob({ db: stack.db } as never)
    expect(res.rows).toBe(0)
    const m = await collectFleetMetrics(stack.db)
    const f = m.scrapers.failing.find((x) => x.jobName === 'never-worked')!
    expect(f.consecutiveFailures).toBe(4)
    expect(f.lastSuccessAt).toBeNull()
  })

  it('⚠️ never deletes a run still in flight', async () => {
    // A 'running' row is finished by a later UPDATE. Deleting one strands that
    // write — and an old `started_at` is exactly what a hung job looks like,
    // which is the case most worth keeping.
    await run('stuck', 90, 'running')
    const res = await scraperRunsPruneJob({ db: stack.db } as never)
    expect(res.rows).toBe(0)
    expect(await remaining()).toEqual(['stuck/running/90d'])
  })

  it('prunes each job independently', async () => {
    await run('a', 100, 'success')
    await run('a', 90, 'success')
    await run('b', 100, 'success')
    await scraperRunsPruneJob({ db: stack.db } as never)
    // One survivor each — b's only success is also its newest.
    expect((await remaining()).sort()).toEqual(['a/success/90d', 'b/success/100d'])
  })

  it('reports what it did', async () => {
    await run('a', 100, 'success')
    await run('a', 90, 'success')
    const res = await scraperRunsPruneJob({ db: stack.db } as never)
    expect(res.details).toMatchObject({ pruned: 1, remaining: 1, retention_days: RETENTION_DAYS })
  })
})
