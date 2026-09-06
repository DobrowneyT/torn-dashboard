/**
 * Fleet status collection (#609 slice 3).
 *
 * ⚠️ **No privilege, and no cross-tenant database access.** The #608 audit was
 * explicit that health monitoring needs neither: tenants already serve
 * `/api/health/ready` on the internal compose network, and Postgres answers for
 * itself. Nothing here mounts a Docker socket or holds a faction credential.
 *
 * ⚠️ **Tenant discovery is free.** `app_global_rw` can read `pg_database` — a
 * shared catalog — so the tenant list comes from the cluster itself rather than
 * a config file that would drift the moment a faction was added. Verified on
 * the live box that the same role *cannot* CONNECT to any `faction_*` database,
 * so enumeration is not a hole: it learns the names and nothing else.
 *
 * Everything degrades. A tenant that does not answer is reported as `down`, not
 * thrown — a status page that 500s because one container is unhealthy is a
 * status page that fails exactly when it is needed.
 */
import type pg from 'pg'
import { readdir, stat, statfs } from 'node:fs/promises'
import { deriveTenantToken } from '../fleetMetricsAuth.js'
import type { FleetMetrics } from '../fleetMetrics.js'

export type TenantState = 'ok' | 'degraded' | 'down'

export interface TenantStatus {
  slug: string
  state: TenantState
  /** What the tenant said about itself, when it answered. */
  db?: string
  scheduler?: string
  ticker?: string
  version?: string
  global?: unknown
  error?: string
  latencyMs?: number
  /**
   * Key-pool depth and failing scrapers (#632). ⚠️ Absent when no
   * FLEET_METRICS_SECRET is configured, or when the tenant is too old to serve
   * the endpoint — which must read as "not measured", never as "all fine". The
   * alert rules treat undefined and zero as different things for exactly the
   * reason #645 went unnoticed for thirteen days.
   */
  metrics?: FleetMetrics
  metricsError?: string
}

export interface BackupStatus {
  /** Most recent dump per faction, by filename prefix. */
  newestAgeHours: number | null
  count: number
  /** ⚠️ Factions with a database but no dump at all. */
  missing: string[]
  error?: string
}

export interface DiskStatus {
  path: string
  totalBytes: number
  freeBytes: number
  usedPercent: number
  error?: string
}

export interface FleetStatus {
  generatedAt: string
  postgres: { state: 'ok' | 'down'; error?: string }
  tenants: TenantStatus[]
  backups: BackupStatus
  disk: DiskStatus | null
  global: { schemaVersion: number | null; ocModelVersion: string | null; itemsSyncedAt: string | null } | null
}

/**
 * How long to wait on a tenant before calling it down.
 *
 * ⚠️ Short on purpose. These are same-host HTTP calls that normally answer in
 * single-digit milliseconds; a long timeout means one wedged container stalls
 * the whole status page, which is the moment it matters most.
 */
export const TENANT_TIMEOUT_MS = 3_000

/** `faction_tnl` → `tnl`. Null for anything that is not a faction database. */
export function slugFromDbName(dbName: string): string | null {
  const m = /^faction_(.+)$/.exec(dbName)
  if (!m) return null
  // The dev stack's `_dev` databases are a separate compose project with their
  // own containers; including them would report five phantom tenants as down.
  if (m[1].endsWith('_dev')) return null
  return m[1]
}

export async function discoverTenants(db: pg.Pool): Promise<string[]> {
  const res = await db.query(
    `SELECT datname FROM pg_database WHERE datname LIKE 'faction\\_%' ORDER BY datname`
  )
  return res.rows
    .map((r: { datname: string }) => slugFromDbName(r.datname))
    .filter((s): s is string => s !== null)
}

/**
 * Ask one tenant how it is.
 *
 * ⚠️ `global: "unavailable"` on a tenant is NOT degraded. Tenants are designed
 * to work with the control plane down — treating it as a fault would mean this
 * page reports the fleet as unhealthy whenever the box rendering the page is
 * the thing that is broken, which is both wrong and confusing.
 */
export async function checkTenant(
  slug: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = TENANT_TIMEOUT_MS,
  fleetSecret?: string
): Promise<TenantStatus> {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(`http://api-${slug}:8080/api/health/ready`, {
      signal: controller.signal,
    })
    const latencyMs = Date.now() - started
    const body = (await res.json()) as Record<string, unknown>
    const db = typeof body.db === 'string' ? body.db : 'unknown'
    return {
      slug,
      // 503 or a down database is degraded, not down: the process is answering,
      // which is a different problem from a container that is gone.
      state: res.ok && db === 'up' ? 'ok' : 'degraded',
      db,
      scheduler: typeof body.scheduler === 'string' ? body.scheduler : undefined,
      ticker: typeof body.ticker === 'string' ? body.ticker : undefined,
      version: typeof body.version === 'string' ? body.version : undefined,
      global: body.global,
      latencyMs,
    }
  } catch (e) {
    return {
      slug,
      state: 'down',
      error: e instanceof Error ? (e.name === 'AbortError' ? `no response in ${timeoutMs}ms` : e.message) : String(e),
      latencyMs: Date.now() - started,
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The metrics a tenant will only tell an authenticated caller (#632).
 *
 * ⚠️ Separate from the readiness probe, and failing separately. A tenant too
 * old to serve this endpoint, or one whose token does not match, must not be
 * reported as DOWN — it is answering perfectly well, we simply cannot see
 * inside it. Conflating the two would make a rollout look like an outage.
 */
export async function fetchTenantMetrics(
  slug: string,
  fleetSecret: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = TENANT_TIMEOUT_MS
): Promise<{ metrics?: FleetMetrics; metricsError?: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(`http://api-${slug}:8080/api/internal/fleet-metrics`, {
      headers: { authorization: `Bearer ${deriveTenantToken(fleetSecret, slug)}` },
      signal: controller.signal,
    })
    if (!res.ok) return { metricsError: `HTTP ${res.status}` }
    return { metrics: (await res.json()) as FleetMetrics }
  } catch (e) {
    return { metricsError: e instanceof Error ? e.message : String(e) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Backup freshness, from the dump directory.
 *
 * ⚠️ The audit called this out as worth more than container liveness, and the
 * reason is asymmetry: a backup job that has been failing for three weeks is
 * WORSE than no backup, because you believe you have one. Reporting the newest
 * dump's age is what turns that from a surprise into a number.
 *
 * ⚠️ `missing` is computed against the known tenant list, not against whatever
 * files happen to exist. A faction that has never been backed up produces no
 * file at all, so a check that only looked at files present would report it as
 * perfectly healthy.
 */
export async function checkBackups(
  dir: string,
  tenants: string[],
  now = Date.now()
): Promise<BackupStatus> {
  try {
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql.gz'))
    let newest = 0
    const seen = new Set<string>()
    for (const file of files) {
      const m = /^faction_(.+?)_\d{8}T\d{6}Z\.sql\.gz$/.exec(file)
      if (m) seen.add(m[1])
      const s = await stat(`${dir}/${file}`)
      if (s.mtimeMs > newest) newest = s.mtimeMs
    }
    return {
      newestAgeHours: newest > 0 ? (now - newest) / 3_600_000 : null,
      count: files.length,
      missing: tenants.filter((t) => !seen.has(t)),
    }
  } catch (e) {
    return {
      newestAgeHours: null,
      count: 0,
      missing: [],
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

/** Free space on the filesystem backing `path`. */
export async function checkDisk(path: string): Promise<DiskStatus> {
  try {
    const fs = await statfs(path)
    const totalBytes = fs.blocks * fs.bsize
    const freeBytes = fs.bavail * fs.bsize
    return {
      path,
      totalBytes,
      freeBytes,
      usedPercent: totalBytes > 0 ? ((totalBytes - freeBytes) / totalBytes) * 100 : 0,
    }
  } catch (e) {
    return {
      path, totalBytes: 0, freeBytes: 0, usedPercent: 0,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

export interface CollectorDeps {
  db: pg.Pool
  backupDir?: string
  fetchImpl?: typeof fetch
  now?: () => number
  /** Derives each tenant's metrics token (#632). Absent leaves `metrics`
   *  undefined on every tenant, which the alert rules read as unmeasured. */
  fleetMetricsSecret?: string
}

export async function collectFleetStatus(deps: CollectorDeps): Promise<FleetStatus> {
  const now = deps.now?.() ?? Date.now()
  let postgres: FleetStatus['postgres'] = { state: 'ok' }
  let tenants: string[] = []
  let globalMeta: FleetStatus['global'] = null

  try {
    tenants = await discoverTenants(deps.db)
    const meta = await deps.db.query(
      'SELECT schema_version, oc_model_version, items_synced_at FROM fleet_meta WHERE id = 1'
    )
    const row = meta.rows[0]
    globalMeta = row
      ? {
          schemaVersion: Number(row.schema_version),
          ocModelVersion: row.oc_model_version ?? null,
          itemsSyncedAt: row.items_synced_at ? new Date(row.items_synced_at).toISOString() : null,
        }
      : null
  } catch (e) {
    // ⚠️ Postgres being down does not abort the report. The tenant checks are
    // independent HTTP calls and still carry useful information — and "the
    // control plane's own database is down" is itself the headline finding.
    postgres = { state: 'down', error: e instanceof Error ? e.message : String(e) }
  }

  // In parallel: one slow tenant must not serialise behind the others.
  const statuses = await Promise.all(
    tenants.map(async (slug) => {
      const status = await checkTenant(slug, deps.fetchImpl)
      // ⚠️ Only asked of a tenant that answered. A container that is down has
      // nothing to say about its key pool, and a failed metrics call on top of
      // a failed readiness call is noise on an incident already reported.
      if (!deps.fleetMetricsSecret || status.state === 'down') return status
      return { ...status, ...(await fetchTenantMetrics(slug, deps.fleetMetricsSecret, deps.fetchImpl)) }
    })
  )

  const backupDir = deps.backupDir ?? '/backups'
  const [backups, disk] = await Promise.all([
    checkBackups(backupDir, tenants, now),
    checkDisk(backupDir),
  ])

  return {
    generatedAt: new Date(now).toISOString(),
    postgres,
    tenants: statuses,
    backups,
    disk: disk.error ? null : disk,
    global: globalMeta,
  }
}
