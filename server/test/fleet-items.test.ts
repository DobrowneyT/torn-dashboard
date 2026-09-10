// #609 slice 7 — the item catalogue moves to the control plane.
//
// ⚠️ The whole risk of this slice is stated in the issue and is worth keeping
// in view while reading the tests: centralising trades five-fold redundancy for
// ONE key, and the failure is silent and expensive. Today every tenant fetches
// from its own hourly re-verified pool (#309) and survives any single key
// dying; fed by one key, prices quietly stop updating and every faction keeps
// valuing payouts off a stale table. That is the decay that ran unnoticed for
// months in July (#123/#124).
//
// So most of this file is about the two mitigations #609 requires TOGETHER:
// tenants fall back to their own pools, and stale prices are refused with a
// reason rather than used.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { cloneDatabase, GLOBAL_TEMPLATE_DB, type ClonedDatabase } from './sharedPostgres.js'
import {
  fetchItems, syncFleetItems, itemsSyncIsDue,
  MIN_PLAUSIBLE_ITEMS, ITEMS_SYNC_INTERVAL_MS,
} from '../src/adminPlane/itemsSync.js'
import { ITEMS_STALE_AFTER_MS } from '../src/globalDb.js'
import {
  catalogFreshness, ITEM_PRICES_UNUSABLE_AFTER_MS, EMPTY_CATALOG, priceNodeItems,
} from '../src/oc/itemPricing.js'
import { itemsSyncJob } from '../src/scraper/jobs/itemsSync.js'
import { readFleetMeta, itemsAreFresh } from '../src/globalDb.js'

let cloned: ClonedDatabase
let admin: pg.Client
let globalDb: pg.Pool

const NOW = Date.parse('2026-09-06T12:00:00.000Z')

/** A catalogue big enough to clear the plausibility floor. */
const manyItems = (n = MIN_PLAUSIBLE_ITEMS + 5) =>
  Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    name: `Item ${i + 1}`,
    type: 'Melee',
    value: { market_price: (i + 1) * 100, sell_price: (i + 1) * 10, buy_price: 0 },
  }))

const jsonFetch = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch

beforeAll(async () => {
  // A clone of the prepared global template on the run's shared cluster; this
  // file used to boot a cluster of its own. See globalPostgres.ts.
  cloned = await cloneDatabase(GLOBAL_TEMPLATE_DB, 'fleet_items')
  admin = new pg.Client(cloned.conn)
  await admin.connect()
  globalDb = new pg.Pool({ ...cloned.conn, max: 4 })
})

afterAll(async () => {
  await globalDb?.end().catch(() => {})
  await admin?.end().catch(() => {})
  await cloned?.drop()
})

async function resetGlobal() {
  await admin.query('TRUNCATE items')
  await admin.query('UPDATE fleet_meta SET items_synced_at = NULL WHERE id = 1')
}

// ⚠️ Formatted in SQL, like the production reads. This test file loads db.ts
// transitively, which installs a PROCESS-WIDE timestamptz parser for PostgREST
// compatibility — so a plain `SELECT items_synced_at` here comes back as
// `2026-09-06T07:00:00-05`, which `new Date()` rejects. That is not a test
// artefact: it is exactly the bug this slice found in readFleetMeta, where the
// resulting throw was swallowed and every tenant would have read the control
// plane as permanently unavailable.
const syncedAt = async (): Promise<string | null> =>
  (await admin.query(
    `SELECT to_char(items_synced_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
       FROM fleet_meta WHERE id = 1`
  )).rows[0].at

describe('⚠️ the two cadences must not merely happen to agree', () => {
  it('refreshes well inside the freshness window', () => {
    // With both at six hours the fleet copy would reach the staleness boundary
    // at the exact moment the next refresh was due, so every tenant would spend
    // the tail of each cycle falling back to its own key pool. The feature
    // would then cost one Torn call per faction and save nothing — while
    // appearing to work, which is the worst kind of failure.
    expect(ITEMS_SYNC_INTERVAL_MS).toBeLessThan(ITEMS_STALE_AFTER_MS)
    // Room for two consecutive failed refreshes before any tenant notices.
    expect(ITEMS_SYNC_INTERVAL_MS * 2).toBeLessThanOrEqual(ITEMS_STALE_AFTER_MS)
  })

  it('withholds prices only long after both sources have failed', () => {
    // Six hours decides whether to ADOPT the fleet copy; past it a tenant just
    // uses its own pool and prices carry on. The refusal threshold only bites
    // when both have been dead for a week.
    expect(ITEM_PRICES_UNUSABLE_AFTER_MS).toBeGreaterThan(ITEMS_STALE_AFTER_MS * 20)
  })
})

describe('fetchItems', () => {
  it('⚠️ treats a Torn error BODY on a 200 as a failure', async () => {
    // Torn answers 200 with {"error":{...}}. Trusting the status code would
    // read a bad key as an empty catalogue — and an empty catalogue stamped
    // fresh is exactly the silent failure this slice is guarding against.
    await expect(fetchItems({
      db: globalDb, apiKey: 'k',
      fetchImpl: jsonFetch({ error: { code: 2, error: 'Incorrect key' } }),
    })).rejects.toThrow(/Incorrect key/)
  })

  it('surfaces a transport failure', async () => {
    await expect(fetchItems({
      db: globalDb, apiKey: 'k', fetchImpl: jsonFetch({ items: [] }, 503),
    })).rejects.toThrow(/HTTP 503/)
  })
})

describe('syncFleetItems', () => {
  it('publishes the catalogue and stamps the timestamp', async () => {
    await resetGlobal()
    const r = await syncFleetItems({
      db: globalDb, apiKey: 'k', now: () => NOW, fetchImpl: jsonFetch({ items: manyItems() }),
    })
    expect(r.rows).toBe(MIN_PLAUSIBLE_ITEMS + 5)
    expect((await admin.query('SELECT COUNT(*)::int AS n FROM items')).rows[0].n).toBe(r.rows)
    expect(await syncedAt()).toBe(new Date(NOW).toISOString())
  })

  it('⚠️ refuses a truncated response and leaves the previous timestamp standing', async () => {
    // A handful of items is not a small catalogue — it is a partial read, a
    // changed shape, or an error body that happened to parse. Writing them and
    // stamping fresh would tell every tenant the prices are current while the
    // table holds almost nothing, which is worse than the outage it came from.
    await resetGlobal()
    await syncFleetItems({
      db: globalDb, apiKey: 'k', now: () => NOW, fetchImpl: jsonFetch({ items: manyItems() }),
    })
    const before = await syncedAt()

    await expect(syncFleetItems({
      db: globalDb, apiKey: 'k', now: () => NOW + 1000,
      fetchImpl: jsonFetch({ items: manyItems(3) }),
    })).rejects.toThrow(/Refusing to publish 3 items/)

    expect(await syncedAt()).toEqual(before)
  })

  it('⚠️ does not stamp a fresh timestamp over a half-written table', async () => {
    // The stamp is the only signal a tenant has that these prices can be
    // trusted, so it is the last write inside the same transaction as the rows.
    await resetGlobal()
    const bad = manyItems()
    // A name of null violates NOT NULL partway through the upsert loop.
    ;(bad[50] as Record<string, unknown>).name = null
    ;(bad[50] as Record<string, unknown>).id = null
    // (a null id is skipped, so force a real failure instead)
    ;(bad[51] as Record<string, unknown>).id = 'not-a-number'

    await expect(syncFleetItems({
      db: globalDb, apiKey: 'k', now: () => NOW, fetchImpl: jsonFetch({ items: bad }),
    })).rejects.toThrow()
    expect(await syncedAt()).toBeNull()
    expect((await admin.query('SELECT COUNT(*)::int AS n FROM items')).rows[0].n).toBe(0)
  })
})

describe('itemsSyncIsDue', () => {
  it('⚠️ reads a NULL timestamp as due, the opposite of the alert rules', async () => {
    // In alertRules.ts a null items_synced_at means "not in service" and must
    // NOT fire. Here the control plane is the thing putting it into service, so
    // null is exactly the state to act on. The two readings are deliberate and
    // must not be unified.
    await resetGlobal()
    expect(await itemsSyncIsDue({ db: globalDb, apiKey: 'k', now: () => NOW })).toBe(true)
  })

  it('is not due immediately after a sync, and is due once the interval passes', async () => {
    await resetGlobal()
    await syncFleetItems({
      db: globalDb, apiKey: 'k', now: () => NOW, fetchImpl: jsonFetch({ items: manyItems() }),
    })
    expect(await itemsSyncIsDue({ db: globalDb, apiKey: 'k', now: () => NOW + 60_000 })).toBe(false)
    expect(await itemsSyncIsDue({
      db: globalDb, apiKey: 'k', now: () => NOW + ITEMS_SYNC_INTERVAL_MS + 1,
    })).toBe(true)
  })
})

describe('⚠️ readFleetMeta against a REAL connection (#609 slice 1 regression)', () => {
  // This is the bug slice 7 found, and it was invisible because the slice-1
  // tests fake the pool with `Date` objects — which node-pg does NOT return in
  // this process. `src/db.ts` installs a process-wide timestamptz parser so the
  // tenant API can serve PostgREST-shaped strings, so the column really arrives
  // as `2026-09-06T07:00:00-05`: not ISO-8601, and rejected by `new Date()`.
  // The old code then called `.toISOString()` on an Invalid Date, which THROWS,
  // and the throw landed in readFleetMeta's own `catch { return null }`.
  //
  // Net effect: the moment `items_synced_at` became non-null — which slice 7 is
  // the first thing to do — every tenant would have read the control plane as
  // permanently "unavailable" and silently stopped using it. Nothing would look
  // broken. The feature would simply never have worked.
  it('returns a parseable ISO timestamp, not a local-offset string', async () => {
    await resetGlobal()
    await syncFleetItems({
      db: globalDb, apiKey: 'k', now: () => NOW, fetchImpl: jsonFetch({ items: manyItems() }),
    })

    const meta = await readFleetMeta(globalDb)
    expect(meta).not.toBeNull()
    expect(meta!.itemsSyncedAt).toBe(new Date(NOW).toISOString())
    expect(Number.isFinite(Date.parse(meta!.itemsSyncedAt!))).toBe(true)
  })

  it('and the freshness check built on it actually answers true', async () => {
    // The assertion that matters downstream: an unparseable timestamp makes
    // itemsAreFresh return false forever, so the fleet fast path would never
    // engage even with a perfectly healthy control plane.
    await resetGlobal()
    await syncFleetItems({
      db: globalDb, apiKey: 'k', now: () => Date.now(), fetchImpl: jsonFetch({ items: manyItems() }),
    })
    expect(itemsAreFresh(await readFleetMeta(globalDb))).toBe(true)
  })

  it('still reads a never-synced fleet without inventing a timestamp', async () => {
    await resetGlobal()
    const meta = await readFleetMeta(globalDb)
    expect(meta?.itemsSyncedAt).toBeNull()
    expect(itemsAreFresh(meta)).toBe(false)
  })
})

// ── The tenant side ─────────────────────────────────────────────────────────

describe('the tenant items-sync job', () => {
  /** A tenant `items` table backed by a plain array. */
  function fakeTenant() {
    const rows: unknown[][] = []
    return {
      rows,
      db: { query: async (_sql: string, params?: unknown[]) => { if (params) rows.push(params); return { rows: [] } } } as any,
    }
  }

  const pool = (claimable: boolean) => ({
    claim: async () => (claimable ? { key: 'tenant-key', member_id: '100' } : null),
  }) as any

  const tornClient = (items: unknown[]) => ({
    fetch: async () => ({ items }),
  }) as any

  it('adopts the fleet catalogue when it is fresh, spending NO Torn call', async () => {
    await resetGlobal()
    await syncFleetItems({
      db: globalDb, apiKey: 'k', now: () => Date.now(), fetchImpl: jsonFetch({ items: manyItems() }),
    })
    const tenant = fakeTenant()
    let claimed = false
    const result = await itemsSyncJob({
      db: tenant.db,
      globalDb,
      pool: { claim: async () => { claimed = true; return { key: 'k', member_id: '1' } } } as any,
      client: tornClient([]),
    })
    expect(result.details).toMatchObject({ source: 'fleet' })
    expect(result.rows).toBe(MIN_PLAUSIBLE_ITEMS + 5)
    // The rate-limit win is the entire point of centralising this.
    expect(claimed).toBe(false)
  })

  describe('⚠️ every failure falls back to this faction’s own key pool', () => {
    // The fallback is not a nicety — it is what makes centralising safe at all,
    // and #609 requires it alongside the staleness refusal rather than instead
    // of it. "Global is a fast path, not a dependency."
    it('when the fleet prices have gone stale', async () => {
      await resetGlobal()
      await admin.query(
        `UPDATE fleet_meta SET items_synced_at = now() - interval '20 hours' WHERE id = 1`
      )
      const tenant = fakeTenant()
      const result = await itemsSyncJob({
        db: tenant.db, globalDb, pool: pool(true), client: tornClient([{ id: 1, name: 'Xanax' }]),
      })
      expect(result.details).toMatchObject({ source: 'pool' })
      expect(result.rows).toBe(1)
    })

    it('when the control plane is unreachable', async () => {
      const dead = { query: async () => { throw new Error('ECONNREFUSED') } } as any
      const tenant = fakeTenant()
      const result = await itemsSyncJob({
        db: tenant.db, globalDb: dead, pool: pool(true), client: tornClient([{ id: 1, name: 'Xanax' }]),
      })
      expect(result.details).toMatchObject({ source: 'pool' })
    })

    it('when the fleet copy is fresh but reading it fails partway', async () => {
      // A tenant that got as far as trusting the timestamp and then hit a
      // permission or network error must still end the run with prices.
      let call = 0
      const flaky = {
        query: async (sql: string) => {
          call += 1
          if (sql.includes('fleet_meta')) {
            return { rows: [{ schema_version: 5, oc_model_version: null, oc_model_built_at: null, items_synced_at: new Date() }] }
          }
          throw new Error('permission denied for table items')
        },
      } as any
      const tenant = fakeTenant()
      const result = await itemsSyncJob({
        db: tenant.db, globalDb: flaky, pool: pool(true), client: tornClient([{ id: 1, name: 'Xanax' }]),
      })
      expect(result.details).toMatchObject({ source: 'pool' })
      expect(call).toBeGreaterThan(0)
    })

    it('behaves exactly as before when there is no control plane at all', async () => {
      const tenant = fakeTenant()
      const result = await itemsSyncJob({
        db: tenant.db, pool: pool(true), client: tornClient([{ id: 1, name: 'Xanax' }]),
      })
      expect(result.details).toMatchObject({ source: 'pool' })
    })

    it('still fails loudly when the pool is empty too', async () => {
      // Both sources dead is a real failure and the run log should say so.
      const tenant = fakeTenant()
      await expect(itemsSyncJob({
        db: tenant.db, pool: pool(false), client: tornClient([]),
      })).rejects.toThrow(/no pooled key/)
    })
  })
})

// ── Refusing stale prices ───────────────────────────────────────────────────

describe('catalogFreshness', () => {
  it('trusts a recent catalogue', () => {
    const f = catalogFreshness(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)
    expect(f.fresh).toBe(true)
    expect(f.reason).toBeUndefined()
  })

  it('⚠️ refuses with a reason once both sources have been dead a week', () => {
    // #609: stale prices are "refused with a reason, never silently used" —
    // the same house rule as item_value_unmatched (#441), unpriced endings as a
    // lower bound (#473) and null-not-zero (#351). Absent beats confidently
    // wrong.
    const f = catalogFreshness(new Date(NOW - 9 * 86_400_000).toISOString(), NOW)
    expect(f.fresh).toBe(false)
    expect(f.reason).toMatch(/9 days old/)
    expect(f.ageHours).toBeGreaterThan(200)
  })

  it('⚠️ gives a never-synced catalogue its OWN reason', () => {
    // A faction that has never run items-sync has no prices to withhold.
    // Reporting "prices are too old" would send an operator looking for a sync
    // failure that never happened.
    const f = catalogFreshness(null, NOW)
    expect(f.fresh).toBe(false)
    expect(f.reason).toMatch(/never been synced/)
    expect(f.ageHours).toBeNull()
  })

  it('does not trust an unreadable timestamp', () => {
    expect(catalogFreshness('not a date', NOW).fresh).toBe(false)
  })

  it('⚠️ withholding routes through the path #441 already built', () => {
    // Expressed as an EMPTY catalogue, so every drop comes back in
    // `item_value_unmatched` rather than through a second, parallel notion of
    // "unpriced" that the client would have to learn.
    const priced = priceNodeItems(
      [{ name: 'Priceless Painting', occurrences: 2, qty: { avg: 1 } }], 4, EMPTY_CATALOG
    )
    expect(priced).toMatchObject({ value: 0, unmatched: ['Priceless Painting'] })
  })
})
