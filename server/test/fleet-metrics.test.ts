// #632 — the two numbers that would have caught #645 on day one.
//
// capacityx ran ZERO Torn-backed scraper jobs for thirteen days and every
// surface reported it healthy: /api/health/ready answered `ok`, Docker's
// healthcheck was green, and the #609 fleet status page said `5/5 tenants up`.
// Those check database connectivity and whether the scheduler is ARMED — not
// whether anything SUCCEEDS.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'
import { createKeyPool } from '../src/scraper/keyPool.js'
import { collectFleetMetrics } from '../src/fleetMetrics.js'
import { deriveTenantToken, tokenMatches, bearerFrom } from '../src/fleetMetricsAuth.js'

const ENCRYPTION_KEY = 'f'.repeat(64)
const FLEET_SECRET = 'fleet-metrics-secret-for-tests'
let stack: TestStack

beforeAll(async () => {
  stack = await startTestStack(undefined, {}, {
    fleetMetricsToken: deriveTenantToken(FLEET_SECRET, TEST_FACTION.slug),
  })
  await stack.db.query(`
    INSERT INTO members (member_id, member_name, tier, is_current) VALUES
      ('5001', 'Alpha', 3, true), ('5002', 'Bravo', 3, true), ('5003', 'Charlie', 3, true)
  `)
  const pool = createKeyPool({ db: stack.db, encryptionKey: ENCRYPTION_KEY })
  await pool.store('5001', 'FLEETKEY00005001', { consentVersion: 'v2', hasFactionAccess: true })
  await pool.store('5002', 'FLEETKEY00005002', { consentVersion: 'v2', hasFactionAccess: true })
  await pool.store('5003', 'FLEETKEY00005003', { consentVersion: 'v2', hasFactionAccess: false })
  await pool.disable('5002', 'not in faction as of whenever')
}, 60000)

afterAll(async () => { await stack?.close() })

describe('deriveTenantToken', () => {
  it('⚠️ gives each tenant a DIFFERENT token from one fleet secret', () => {
    // The obvious design — one shared secret pasted into every tenant — means a
    // leak from ANY faction's .env reads EVERY faction's metrics. One
    // faction's compromise should be one faction.
    const a = deriveTenantToken(FLEET_SECRET, 'tnl')
    const b = deriveTenantToken(FLEET_SECRET, 'forge')
    expect(a).not.toBe(b)
    expect(a).toHaveLength(64)
  })

  it('is deterministic, so the operator and the tenant agree without shipping it', () => {
    expect(deriveTenantToken(FLEET_SECRET, 'tnl')).toBe(deriveTenantToken(FLEET_SECRET, 'tnl'))
  })

  it("⚠️ one tenant's token does not yield another's", () => {
    // The property that makes this worth doing at all.
    expect(tokenMatches(deriveTenantToken(FLEET_SECRET, 'tnl'), deriveTenantToken(FLEET_SECRET, 'forge')))
      .toBe(false)
  })
})

describe('tokenMatches', () => {
  it('⚠️ returns false on a length mismatch rather than throwing', () => {
    // timingSafeEqual throws on differing lengths, so a short token would 500
    // instead of 401 — itself an oracle, and a noisy one.
    expect(() => tokenMatches('short', 'a-much-longer-token')).not.toThrow()
    expect(tokenMatches('short', 'a-much-longer-token')).toBe(false)
  })

  it('accepts an exact match', () => {
    expect(tokenMatches('abc123', 'abc123')).toBe(true)
  })
})

describe('bearerFrom', () => {
  it('reads a bearer token and rejects anything else', () => {
    expect(bearerFrom('Bearer tok')).toBe('tok')
    expect(bearerFrom('Basic tok')).toBeNull()
    expect(bearerFrom(undefined)).toBeNull()
    expect(bearerFrom('Bearer ')).toBeNull()
  })
})

describe('collectFleetMetrics', () => {
  it('⚠️ counts CLAIMABLE keys, not merely enrolled ones', async () => {
    // 5001 usable, 5002 disabled, 5003 enrolled but without faction access.
    // `disabled = false` alone would report 2 and hide the real answer — the
    // condition has to mirror keyPool.claim() exactly, which is what capacityx
    // turned on: it held one enabled key that claim() would never return.
    const m = await collectFleetMetrics(stack.db)
    expect(m.keys).toMatchObject({ claimable: 1, enrolled: 3, disabled: 1 })
  })

  it('reports consecutive failures per job, and ignores recovered ones', async () => {
    await stack.db.query(`
      INSERT INTO scraper_jobs (job_name, cron_schedule, enabled) VALUES
        ('always-fails', NULL, true), ('recovered', NULL, true), ('turned-off', NULL, false)
      ON CONFLICT (job_name) DO UPDATE SET enabled = EXCLUDED.enabled
    `)
    await stack.db.query(`
      INSERT INTO scraper_runs (job_name, started_at, status, error) VALUES
        ('always-fails', now() - interval '3 hours', 'failure', 'no pooled key available'),
        ('always-fails', now() - interval '2 hours', 'failure', 'no pooled key available'),
        ('always-fails', now() - interval '1 hours', 'failure', 'no pooled key available'),
        ('recovered',    now() - interval '3 hours', 'failure', 'transient'),
        ('recovered',    now() - interval '1 hours', 'success', NULL),
        ('turned-off',   now() - interval '1 hours', 'failure', 'ignored')
    `)

    const m = await collectFleetMetrics(stack.db)
    const failing = Object.fromEntries(m.scrapers.failing.map((f) => [f.jobName, f]))

    expect(failing['always-fails'].consecutiveFailures).toBe(3)
    // ⚠️ null, not a date: it has NEVER succeeded, which is a different fact
    // from "succeeded a long time ago" and the one that matters here.
    expect(failing['always-fails'].lastSuccessAt).toBeNull()
    expect(failing['always-fails'].lastError).toContain('no pooled key')

    // A job that failed once and recovered is not failing.
    expect(failing['recovered']).toBeUndefined()

    // ⚠️ A job an admin deliberately switched off is not failing either.
    // Reporting it would train someone to ignore this list — the #598 lesson
    // about a channel that cries wolf.
    expect(failing['turned-off']).toBeUndefined()
  })

  it('does not count in-flight runs as either outcome', async () => {
    await stack.db.query(
      `INSERT INTO scraper_runs (job_name, started_at, status) VALUES ('always-fails', now(), 'running')`
    )
    const m = await collectFleetMetrics(stack.db)
    const f = m.scrapers.failing.find((x) => x.jobName === 'always-fails')!
    expect(f.consecutiveFailures).toBe(3)
  })

  it('⚠️ counts only the failures AFTER the last success, not every failure ever', async () => {
    // The distinction the whole number rests on. A job that has run for months
    // has a long history of transient failures; reporting all of them would say
    // "247 consecutive failures" about a job that succeeded an hour ago.
    await stack.db.query(`
      INSERT INTO scraper_jobs (job_name, cron_schedule, enabled) VALUES ('long-lived', NULL, true)
      ON CONFLICT (job_name) DO UPDATE SET enabled = EXCLUDED.enabled
    `)
    await stack.db.query(`
      INSERT INTO scraper_runs (job_name, started_at, status, error) VALUES
        ('long-lived', now() - interval '30 days', 'failure', 'ancient'),
        ('long-lived', now() - interval '29 days', 'failure', 'ancient'),
        ('long-lived', now() - interval '10 days', 'success', NULL),
        ('long-lived', now() - interval '2 hours',  'failure', 'Torn API 429'),
        ('long-lived', now() - interval '1 hours',  'failure', 'Torn API 429')
    `)
    const m = await collectFleetMetrics(stack.db)
    const f = m.scrapers.failing.find((x) => x.jobName === 'long-lived')!
    expect(f.consecutiveFailures).toBe(2)
    expect(f.lastSuccessAt).not.toBeNull()
    expect(f.lastError).toContain('429')
  })

  it('⚠️ answers on a table the size a live tenant actually has', async () => {
    // THE REGRESSION THIS FILE EXISTS FOR NOW. The first cut of this query
    // expressed the streak as a correlated `min(rn)` subquery re-evaluated per
    // row over a CTE spanning all of `scraper_runs` — which is append-only and
    // has never been pruned. It was fine on the dozen rows the tests above
    // insert and could not answer AT ALL in production: measured 2026-09-10,
    // every live tenant 401'd without a token in milliseconds and returned
    // nothing after 25s with a valid one.
    //
    // Growth of the old formulation, measured: 5.5k rows 412ms, 10.5k 765ms,
    // 20.5k 1865ms, 50.5k 8793ms, 504k still running when a 60s statement
    // timeout killed it. The rebuilt query is 2-3ms at every one of those.
    //
    // 40k rows puts the old query around six seconds — past this endpoint's own
    // statement timeout — while the current one has roughly three orders of
    // magnitude of headroom against the assertion below.
    // ⚠️ Registered as ENABLED jobs, not just rows. The rebuilt query only
    // probes enabled jobs, so bulk rows belonging to jobs nobody asked about
    // would let it skip the work this test exists to measure.
    await stack.db.query(`
      INSERT INTO scraper_jobs (job_name, cron_schedule, enabled)
      SELECT 'bulk-' || i, NULL, true FROM generate_series(0, 11) AS i
      ON CONFLICT (job_name) DO UPDATE SET enabled = true
    `)
    await stack.db.query(`
      INSERT INTO scraper_runs (job_name, started_at, status, error)
      SELECT 'bulk-' || (i % 12),
             now() - ((40000 - i) * interval '30 seconds'),
             CASE WHEN i % 53 = 0 THEN 'failure' ELSE 'success' END,
             CASE WHEN i % 53 = 0 THEN 'transient' ELSE NULL END
        FROM generate_series(1, 40000) AS i
    `)
    const started = Date.now()
    const m = await collectFleetMetrics(stack.db)
    const elapsed = Date.now() - started
    expect(m.scrapers.runsLast24h).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(2000)
  })

  it('⚠️ does not leave its statement_timeout on the pooled connection', async () => {
    // `db` is a POOL. A bare `SET statement_timeout` lands on whichever
    // connection the pool handed out and STAYS there — quietly applying this
    // endpoint's five-second ceiling to ordinary application queries that have
    // nothing to do with it, on one connection out of ten, at random.
    await collectFleetMetrics(stack.db)
    // Drain enough connections that we are very likely to get the one the call
    // above used back.
    for (let i = 0; i < 12; i++) {
      const r = await stack.db.query('SHOW statement_timeout')
      expect(r.rows[0].statement_timeout).toBe('0')
    }
  })

  it('⚠️ never carries a member id or key material', async () => {
    // #609 is explicit that key-pool depth is reconnaissance; that does not
    // stop applying because the caller is meant to be ours. Counts and job
    // names only — job names are identical on every tenant and say nothing
    // about a faction.
    const json = JSON.stringify(await collectFleetMetrics(stack.db))
    expect(json).not.toContain('5001')
    expect(json).not.toContain('FLEETKEY')
    expect(json).not.toContain('cpr_api_key')
  })
})

describe('the endpoint', () => {
  const get = (token?: string) =>
    fetch(`${stack.baseUrl}/api/internal/fleet-metrics`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })

  it('serves metrics to the control plane', async () => {
    const res = await get(deriveTenantToken(FLEET_SECRET, TEST_FACTION.slug))
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.keys.claimable).toBe(1)
    expect(body.generatedAt).toBeTruthy()
  })

  it('⚠️ refuses an unauthenticated caller — the path IS public', async () => {
    // The generated tenant vhost proxies `location /api/` wholesale, so living
    // on the compose network protects nothing here.
    expect((await get()).status).toBe(401)
  })

  it("⚠️ refuses ANOTHER tenant's token", async () => {
    // The whole reason for deriving per tenant rather than sharing one secret.
    expect((await get(deriveTenantToken(FLEET_SECRET, 'someone-else'))).status).toBe(401)
  })

  it('refuses a token derived from the wrong fleet secret', async () => {
    expect((await get(deriveTenantToken('a-different-fleet-secret', TEST_FACTION.slug))).status).toBe(401)
  })

  it('gives the same answer for a missing token as a wrong one', async () => {
    // Distinguishing them tells a prober which half they have already solved.
    const [missing, wrong] = await Promise.all([get(), get('nonsense')])
    expect(missing.status).toBe(wrong.status)
    expect(await missing.json()).toEqual(await wrong.json())
  })
})
