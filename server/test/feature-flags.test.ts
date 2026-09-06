// #609 slice 5 — fleet defaults with tenant overrides.
//
// One idea carries this whole file: **"unset" is a distinct state from "set to
// a falsy value"**. `local || global` is the bug it exists to prevent, and in
// this codebase it is not hypothetical — `member_stats_poll_interval_sec = 0`
// already means "off" (scraper/jobs/warLifecycle.ts) and
// `chain_poll_interval_*_sec = 0` means "never poll". A faction that had
// deliberately switched something off would silently inherit the fleet's "on".
//
// Same bug class as `Number(null) === 0`, which bit `chainedValue` in #585.
import { describe, expect, it, vi } from 'vitest'
import {
  createFlagResolver, asString, asNumber, asBoolean, scraperScheduleKey, FLAG_CACHE_TTL_MS,
} from '../src/featureFlags.js'
import { resolveJobSchedule } from '../src/scraper/scheduleResolution.js'

type Row = { key: string; value: unknown }

/** A pool whose two tables are plain arrays, so a test states its own state. */
function pools(tenant: Row[], fleet: Row[] | Error | null) {
  let tenantCalls = 0
  let fleetCalls = 0
  const db = {
    query: async () => { tenantCalls += 1; return { rows: tenant } },
  } as any
  const globalDb = fleet === null ? undefined : ({
    query: async () => {
      fleetCalls += 1
      if (fleet instanceof Error) throw fleet
      return { rows: fleet }
    },
  } as any)
  return { db, globalDb, counts: () => ({ tenantCalls, fleetCalls }) }
}

describe('flag resolution', () => {
  it('falls back to the fleet default when the tenant has said nothing', async () => {
    const { db, globalDb } = pools([], [{ key: 'a', value: 'fleet' }])
    const r = createFlagResolver({ db, globalDb })
    expect(await r.get('a')).toMatchObject({ value: 'fleet', source: 'fleet' })
  })

  it('prefers the tenant value when both are set', async () => {
    const { db, globalDb } = pools([{ key: 'a', value: 'mine' }], [{ key: 'a', value: 'fleet' }])
    const r = createFlagResolver({ db, globalDb })
    expect(await r.get('a')).toMatchObject({ value: 'mine', source: 'tenant', fleetValue: 'fleet' })
  })

  it('reports unset as undefined, not as a default', async () => {
    const { db, globalDb } = pools([], [])
    const r = createFlagResolver({ db, globalDb })
    expect(await r.get('nope')).toEqual({ key: 'nope', value: undefined, source: 'unset' })
  })

  describe('⚠️ a falsy tenant value is still a tenant value', () => {
    // THE acceptance criterion from #609: "a test proving a tenant-set 0 is not
    // overridden by a global default".
    it('keeps a tenant-set 0 over a fleet default of 300', async () => {
      const { db, globalDb } = pools([{ key: 'poll', value: 0 }], [{ key: 'poll', value: 300 }])
      const r = createFlagResolver({ db, globalDb })
      const flag = await r.get('poll')
      expect(flag.value).toBe(0)
      expect(flag.source).toBe('tenant')
      expect(asNumber(flag)).toBe(0)
    })

    it('keeps a tenant-set false over a fleet default of true', async () => {
      const { db, globalDb } = pools([{ key: 'on', value: false }], [{ key: 'on', value: true }])
      const r = createFlagResolver({ db, globalDb })
      const flag = await r.get('on')
      expect(flag.value).toBe(false)
      expect(asBoolean(flag)).toBe(false)
    })

    it('keeps a tenant-set empty string over a fleet default', async () => {
      const { db, globalDb } = pools([{ key: 's', value: '' }], [{ key: 's', value: 'fleet' }])
      const r = createFlagResolver({ db, globalDb })
      expect(await r.get('s')).toMatchObject({ value: '', source: 'tenant' })
    })
  })

  it('lists the union of both layers, resolved', async () => {
    const { db, globalDb } = pools(
      [{ key: 'b', value: 2 }],
      [{ key: 'a', value: 1 }, { key: 'b', value: 99 }]
    )
    const r = createFlagResolver({ db, globalDb })
    expect(await r.all()).toEqual([
      { key: 'a', value: 1, source: 'fleet' },
      { key: 'b', value: 2, source: 'tenant', fleetValue: 99 },
    ])
  })

  describe('⚠️ when the control plane is unreachable', () => {
    it('works with no global database at all', async () => {
      const { db } = pools([{ key: 'a', value: 'mine' }], null)
      const r = createFlagResolver({ db })
      expect(await r.get('a')).toMatchObject({ value: 'mine', source: 'tenant' })
      expect(await r.get('b')).toMatchObject({ source: 'unset' })
    })

    it('serves the LAST KNOWN fleet defaults rather than reverting to code', async () => {
      // An empty map is not neutral: it silently reverts every fleet-set value
      // to the code default, so a blip in the control plane would change how
      // the tenant behaves. Keeping the previous snapshot means an unreachable
      // control plane changes nothing at all — which is the promise the whole
      // "tenants read global directly" architecture is built on (#608).
      let broken = false
      const db = { query: async () => ({ rows: [] }) } as any
      const globalDb = {
        query: async () => {
          if (broken) throw new Error('ECONNREFUSED')
          return { rows: [{ key: 'a', value: 'fleet' }] }
        },
      } as any
      let clock = 0
      const r = createFlagResolver({ db, globalDb, ttlMs: 10, now: () => clock, log: () => {} })

      expect(await r.get('a')).toMatchObject({ value: 'fleet', source: 'fleet' })
      broken = true
      clock = 1000
      expect(await r.get('a')).toMatchObject({ value: 'fleet', source: 'fleet' })
    })

    it('never throws out of get()', async () => {
      const { db, globalDb } = pools([], new Error('ECONNREFUSED'))
      const r = createFlagResolver({ db, globalDb, log: () => {} })
      await expect(r.get('a')).resolves.toMatchObject({ source: 'unset' })
    })
  })

  describe('caching', () => {
    it('reuses a snapshot inside the TTL', async () => {
      const { db, globalDb, counts } = pools([], [])
      let clock = 0
      const r = createFlagResolver({ db, globalDb, now: () => clock })
      await r.get('a'); await r.get('b'); await r.get('c')
      expect(counts().tenantCalls).toBe(1)
      clock = FLAG_CACHE_TTL_MS + 1
      await r.get('a')
      expect(counts().tenantCalls).toBe(2)
    })

    it('⚠️ coalesces a startup burst into one load', async () => {
      // Twenty jobs resolve their cadence at once when the scheduler starts.
      // Without this each would open its own pair of queries against a pool
      // that is also serving the API's first requests.
      const { db, globalDb, counts } = pools([], [])
      const r = createFlagResolver({ db, globalDb })
      await Promise.all(Array.from({ length: 20 }, () => r.get('x')))
      expect(counts().tenantCalls).toBe(1)
    })

    it('invalidate() forces the next read to hit the database', async () => {
      const { db, globalDb, counts } = pools([], [])
      const r = createFlagResolver({ db, globalDb })
      await r.get('a')
      r.invalidate()
      await r.get('a')
      expect(counts().tenantCalls).toBe(2)
    })
  })

  describe('typed accessors', () => {
    const flag = (value: unknown) => ({ key: 'k', value, source: 'tenant' } as any)

    it('⚠️ refuse to coerce, so the caller falls back to its own default', () => {
      // A cron expression that arrived as the number 5 would stringify to "5"
      // and be accepted by nothing, failing at schedule time far from the flag
      // that caused it.
      expect(asString(flag(5))).toBeUndefined()
      expect(asNumber(flag('30'))).toBeUndefined()
      expect(asBoolean(flag(1))).toBeUndefined()
    })

    it('let legitimate falsy values through', () => {
      expect(asNumber(flag(0))).toBe(0)
      expect(asBoolean(flag(false))).toBe(false)
    })

    it('treat a blank string as absent', () => {
      expect(asString(flag('   '))).toBeUndefined()
    })

    it('reject a non-finite number', () => {
      expect(asNumber(flag(Number.NaN))).toBeUndefined()
    })
  })
})

describe('scraper cadence resolution', () => {
  const DEFAULT = '0 15 */6 * * *'
  const resolver = (tenant: Row[], fleet: Row[]) => {
    const { db, globalDb } = pools(tenant, fleet)
    return createFlagResolver({ db, globalDb })
  }

  it('uses the code default when nothing else is set', async () => {
    const r = await resolveJobSchedule({
      jobName: 'items-sync', codeDefault: DEFAULT, tenantValue: null,
      flags: resolver([], []),
    })
    expect(r).toMatchObject({ effective: DEFAULT, source: 'default' })
  })

  it('takes the fleet default when the faction has no override', async () => {
    const r = await resolveJobSchedule({
      jobName: 'items-sync', codeDefault: DEFAULT, tenantValue: null,
      flags: resolver([], [{ key: scraperScheduleKey('items-sync'), value: '0 0 */12 * * *' }]),
    })
    expect(r).toMatchObject({ effective: '0 0 */12 * * *', source: 'fleet' })
  })

  it("a faction's own value beats the fleet default", async () => {
    const r = await resolveJobSchedule({
      jobName: 'items-sync', codeDefault: DEFAULT, tenantValue: '0 0 * * * *',
      flags: resolver([], [{ key: scraperScheduleKey('items-sync'), value: '0 0 */12 * * *' }]),
    })
    expect(r).toMatchObject({ effective: '0 0 * * * *', source: 'tenant', fleetValue: '0 0 */12 * * *' })
  })

  describe('⚠️ an invalid expression falls back instead of throwing', () => {
    // `cron.schedule()` throws on a malformed expression and start() registers
    // in a loop, so one typo would leave every job after it in the table
    // unscheduled. Via a FLEET flag it is worse: one bad character typed once
    // stops scraping for every faction, and the only symptom is that data
    // quietly stops arriving.
    it('rejects a bad fleet default and reports it', async () => {
      const r = await resolveJobSchedule({
        jobName: 'items-sync', codeDefault: DEFAULT, tenantValue: null,
        flags: resolver([], [{ key: scraperScheduleKey('items-sync'), value: 'every 6 hours' }]),
      })
      expect(r).toMatchObject({ effective: DEFAULT, source: 'default', rejected: 'every 6 hours' })
    })

    it('rejects a bad tenant value without silently promoting the fleet default', async () => {
      // The faction asked for something specific and got it wrong. Quietly
      // applying a fleet cadence it never chose would be a surprise; falling
      // all the way back to the documented code default, and saying so, is not.
      const r = await resolveJobSchedule({
        jobName: 'items-sync', codeDefault: DEFAULT, tenantValue: 'nonsense',
        flags: resolver([], [{ key: scraperScheduleKey('items-sync'), value: '0 0 */12 * * *' }]),
      })
      expect(r).toMatchObject({ effective: DEFAULT, source: 'default', rejected: 'nonsense' })
    })
  })

  it('⚠️ treats an empty tenant string as a rejected value, not as unset', async () => {
    // Reading '' as "unset" would hide a real mistake behind plausible
    // behaviour — the faction would silently run on the fleet cadence and the
    // page would show nothing wrong.
    const r = await resolveJobSchedule({
      jobName: 'items-sync', codeDefault: DEFAULT, tenantValue: '',
      flags: resolver([], [{ key: scraperScheduleKey('items-sync'), value: '0 0 */12 * * *' }]),
    })
    expect(r.rejected).toBe('')
    expect(r.source).toBe('default')
  })

  it('works with no flag resolver at all — exactly as it did before #609', async () => {
    const r = await resolveJobSchedule({ jobName: 'items-sync', codeDefault: DEFAULT, tenantValue: null })
    expect(r).toMatchObject({ effective: DEFAULT, source: 'default' })
    expect(r.fleetValue).toBeUndefined()
  })
})
