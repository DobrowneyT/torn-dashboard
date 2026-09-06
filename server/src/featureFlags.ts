/**
 * Feature-flag resolution: fleet default, tenant override (#609 slice 5).
 *
 * ⚠️ **"Unset" is a distinct state from "set to a falsy value", and this file
 * is where that is enforced.** The naive `local || global` is wrong the moment
 * a tenant sets a cadence to `0` or a flag to `false` — and in this codebase
 * that is not hypothetical: `member_stats_poll_interval_sec = 0` ALREADY means
 * "off" (`scraper/jobs/warLifecycle.ts`), and `chain_poll_interval_*_sec = 0`
 * means "never poll". A faction that had deliberately disabled something would
 * silently inherit the fleet's "on".
 *
 * So the signal is the ROW'S EXISTENCE, never its value. Both tables carry
 * `CHECK (jsonb_typeof(value) <> 'null')` so a JSON null cannot be written as a
 * pretend-unset, and unsetting is a DELETE. Same bug class as
 * `Number(null) === 0`, which bit `chainedValue` in #585.
 *
 * ⚠️ **The fleet layer degrades to stale, then to absent — never to an error.**
 * The #608 audit chose "tenants read `global` directly" precisely so that
 * killing the admin container leaves every tenant fully functional. A resolver
 * that threw when `global` was unreachable would convert an intentional,
 * survivable degradation into an outage, which is the one failure mode this
 * architecture promises cannot happen.
 */
import type pg from 'pg'

export type FlagValue = string | number | boolean | Record<string, unknown> | unknown[]

export type FlagSource = 'tenant' | 'fleet' | 'unset'

export interface ResolvedFlag {
  key: string
  /** `undefined` — and only `undefined` — means unset everywhere. */
  value: FlagValue | undefined
  source: FlagSource
  /** Present when the fleet also has a value the tenant is overriding. */
  fleetValue?: FlagValue
}

export interface FlagResolver {
  get(key: string): Promise<ResolvedFlag>
  /** Every key set in either layer, resolved. For the admin console. */
  all(): Promise<ResolvedFlag[]>
  /** Force the next read to hit the database. Called after a write. */
  invalidate(): void
}

/**
 * How long a resolved snapshot is reused.
 *
 * Short on purpose rather than tuned: the scheduler already re-reads
 * `scraper_jobs.enabled` on every tick so flips take effect without a restart,
 * and a flag that needed a redeploy would be a worse lever than the config
 * column it replaces. One minute is far below the cadence of anything a human
 * changes and far above the cost of two small SELECTs.
 */
export const FLAG_CACHE_TTL_MS = 60_000

interface Snapshot {
  tenant: Map<string, FlagValue>
  fleet: Map<string, FlagValue>
  loadedAt: number
}

export interface FlagResolverDeps {
  db: pg.Pool
  /** Read-only pool on `global`. Absent is a supported state. */
  globalDb?: pg.Pool
  ttlMs?: number
  now?: () => number
  log?: (msg: string) => void
}

export function createFlagResolver(deps: FlagResolverDeps): FlagResolver {
  const ttl = deps.ttlMs ?? FLAG_CACHE_TTL_MS
  const now = deps.now ?? (() => Date.now())
  const log = deps.log ?? ((m: string) => console.warn(m))
  let snapshot: Snapshot | null = null
  let inFlight: Promise<Snapshot> | null = null

  async function readTenant(): Promise<Map<string, FlagValue>> {
    const res = await deps.db.query('SELECT key, value FROM feature_flags')
    return new Map(res.rows.map((r: { key: string; value: FlagValue }) => [r.key, r.value]))
  }

  async function readFleet(previous: Map<string, FlagValue> | undefined): Promise<Map<string, FlagValue>> {
    if (!deps.globalDb) return new Map()
    try {
      const res = await deps.globalDb.query('SELECT key, value FROM fleet_flags')
      return new Map(res.rows.map((r: { key: string; value: FlagValue }) => [r.key, r.value]))
    } catch (e) {
      // ⚠️ Serve the LAST KNOWN fleet defaults rather than an empty map. An
      // empty map is not neutral — it silently reverts every fleet-set value to
      // the code default, so a blip in the control plane would change how the
      // tenant behaves. Keeping the previous snapshot means an unreachable
      // control plane changes nothing at all, which is the promise.
      log(`[flags] fleet defaults unavailable, serving last known: ${e instanceof Error ? e.message : String(e)}`)
      return previous ?? new Map()
    }
  }

  async function load(): Promise<Snapshot> {
    const fresh = snapshot && now() - snapshot.loadedAt < ttl
    if (fresh) return snapshot!
    // One load at a time: twenty jobs resolving their cadence at startup must
    // not each open their own pair of queries.
    if (inFlight) return inFlight
    inFlight = (async () => {
      const [tenant, fleet] = await Promise.all([readTenant(), readFleet(snapshot?.fleet)])
      snapshot = { tenant, fleet, loadedAt: now() }
      return snapshot
    })().finally(() => { inFlight = null })
    return inFlight
  }

  function resolve(key: string, snap: Snapshot): ResolvedFlag {
    // ⚠️ `.has()`, never a truthiness test. This single line is the whole
    // contract: a tenant row holding `0`, `false` or `""` wins over any fleet
    // default, because the tenant said so.
    if (snap.tenant.has(key)) {
      const out: ResolvedFlag = { key, value: snap.tenant.get(key)!, source: 'tenant' }
      if (snap.fleet.has(key)) out.fleetValue = snap.fleet.get(key)!
      return out
    }
    if (snap.fleet.has(key)) return { key, value: snap.fleet.get(key)!, source: 'fleet' }
    return { key, value: undefined, source: 'unset' }
  }

  return {
    async get(key) {
      return resolve(key, await load())
    },
    async all() {
      const snap = await load()
      const keys = [...new Set([...snap.tenant.keys(), ...snap.fleet.keys()])].sort()
      return keys.map((k) => resolve(k, snap))
    },
    invalidate() {
      snapshot = null
    },
  }
}

/**
 * Read a flag as a string, or `undefined` if unset or the wrong shape.
 *
 * ⚠️ Wrong-shape returns `undefined` (fall back) rather than coercing. A cron
 * expression that arrived as the number `5` would stringify to `"5"` and be
 * accepted by nothing, failing at schedule time far from the flag that caused
 * it. The caller's default is the safe answer.
 */
export function asString(flag: ResolvedFlag): string | undefined {
  return typeof flag.value === 'string' && flag.value.trim() !== '' ? flag.value : undefined
}

/** As above for numbers. `0` is a legitimate value and must survive. */
export function asNumber(flag: ResolvedFlag): number | undefined {
  return typeof flag.value === 'number' && Number.isFinite(flag.value) ? flag.value : undefined
}

/** As above for booleans. `false` is a legitimate value and must survive. */
export function asBoolean(flag: ResolvedFlag): boolean | undefined {
  return typeof flag.value === 'boolean' ? flag.value : undefined
}

/** Namespaced key for a scraper job's fleet-default cadence. */
export const scraperScheduleKey = (jobName: string) => `scraper.schedule.${jobName}`
