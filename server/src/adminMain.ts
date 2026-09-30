/**
 * Admin control plane entrypoint (#609 slice 2).
 *
 * Starts TWO listeners from one process:
 *
 *   0.0.0.0:8090   public  — behind nginx at admin.monchoon.me
 *   127.0.0.1:8091 local   — reachable only over an SSH tunnel
 *
 * ⚠️ **The local listener binds 0.0.0.0 inside the container, and the security
 * boundary is the HOST-SIDE publication, not the bind.** The first cut bound it
 * to the container's 127.0.0.1 on the reasoning that loopback is tighter. That
 * is wrong and it fails closed in the most confusing way: Docker forwards a
 * published port to the container's NETWORK INTERFACE, never to its loopback,
 * so `127.0.0.1:8091:8091` reached a port nothing was listening on and every
 * request died with a connection error rather than an HTTP status. Found on the
 * live box, where curl returned `000`.
 *
 * So the boundary is compose's `127.0.0.1:8091:8091`: the port is published
 * only on the host's loopback, unroutable from the internet, reachable over an
 * SSH tunnel.
 *
 * ⚠️ The honest cost of that: the local surface is now reachable by anything
 * else on the compose network — a compromised tenant container could send
 * requests to it. It is not defenceless (the same password + TOTP gate applies,
 * and a local-surface token is rejected on the public surface and vice versa),
 * but it is a real difference from "only reachable via SSH" and worth stating
 * rather than glossing. What the split still buys is that a destructive route
 * is not registered on the internet-facing listener at all.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { buildAdminApp } from './adminPlane/app.js'
import { looksHashed } from './adminPlane/password.js'
import { pgIncidentStore } from './adminPlane/incidentStore.js'
import { mailConfigFromEnv } from './adminPlane/mailer.js'
import { startItemsSync } from './adminPlane/itemsSync.js'
import {
  startMonitor, DEFAULT_INTERVAL_MS, DEFAULT_DIGEST_HOUR_UTC, type MonitorDeps,
} from './adminPlane/monitor.js'
import { deriveTenantToken } from './fleetMetricsAuth.js'
import { TENANT_REGISTRY_SCOPE } from './adminPlane/tenantRegistry.js'

const here = dirname(fileURLToPath(import.meta.url))

function readVersion(): string {
  try {
    return readFileSync(join(here, '..', '..', 'VERSION'), 'utf8').trim()
  } catch {
    return 'dev'
  }
}

/**
 * ⚠️ Refuse to start rather than start insecurely.
 *
 * An admin container that comes up with no password — or with a default one —
 * is worse than one that will not come up at all: "it started fine" would mean
 * "it started open", and this is the single box that can affect every tenant.
 * A crash-loop is loud, and the operator finds out immediately.
 */
function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(
      `[admin] ${name} is required. The control plane refuses to start unconfigured — ` +
      `an admin surface that comes up with no gate is worse than one that does not come up. ` +
      `Generate credentials with: npx tsx db/admin-password.mts`
    )
    process.exit(1)
  }
  return value
}

const username = required('ADMIN_USERNAME')
const passwordHash = required('ADMIN_PASSWORD_HASH')
const totpSecret = required('ADMIN_TOTP_SECRET')
const sessionSecret = required('ADMIN_SESSION_SECRET')

// ⚠️ A plaintext password in ADMIN_PASSWORD_HASH would "work" in the sense that
// verifyPassword returns false for everything — the operator could never log
// in, and would have no idea why. Refuse with an explanation instead.
if (!looksHashed(passwordHash)) {
  console.error(
    '[admin] ADMIN_PASSWORD_HASH does not look like a scrypt hash. It must be the output of ' +
    'npx tsx db/admin-password.mts, not a plaintext password.'
  )
  process.exit(1)
}

// ⚠️ The one cross-check that catches the most dangerous misconfiguration:
// reusing the tenant JWT secret would make any tenant admin's token — or any
// single compromised tenant container — a fleet-wide credential.
if (process.env.JWT_SECRET && sessionSecret === process.env.JWT_SECRET) {
  console.error(
    '[admin] ADMIN_SESSION_SECRET must not equal JWT_SECRET. Sharing it would make every ' +
    'tenant session token a valid admin credential.'
  )
  process.exit(1)
}

// Writer pool on the shared `global` database — the only writer in the fleet.
// Small: this is a low-traffic control surface, and exhausting global's
// connection slots would degrade the thing every tenant reads.
const databaseUrl = process.env.DATABASE_URL
const db = databaseUrl ? new pg.Pool({ connectionString: databaseUrl, max: 4 }) : undefined
db?.on('error', (err) => console.error('[admin] pg pool error:', err.message))
if (!databaseUrl) {
  console.warn('[admin] DATABASE_URL not set — status collection disabled')
}

const version = readVersion()
const publicPort = Number(process.env.ADMIN_PUBLIC_PORT ?? 8090)
const localPort = Number(process.env.ADMIN_LOCAL_PORT ?? 8091)
// Overridable for tests; never set this to a routable address in deployment —
// the host publication is what keeps it off the internet.
const localBind = process.env.ADMIN_LOCAL_BIND ?? '0.0.0.0'

// ⚠️ Status collection needs no privilege beyond reading `pg_database` for the
// tenant list: tenants are polled over plain HTTP on the compose network, and
// `app_global_rw` cannot CONNECT to any faction database (verified on the live
// cluster). No Docker socket, no per-tenant credential.
const collector = db
  ? {
      db,
      backupDir: process.env.ADMIN_BACKUP_DIR ?? '/backups',
      // #632: derives each tenant's metrics token. Absent leaves `metrics`
      // undefined on every tenant, which the alert rules read as UNMEASURED
      // and stay silent about — never as "all fine".
      fleetMetricsSecret: process.env.FLEET_METRICS_SECRET || undefined,
    }
  : undefined

/**
 * Alerting (#609 slice 4).
 *
 * ⚠️ Both delivery channels are OPTIONAL and their absence is not a startup
 * failure, unlike every credential above. The distinction is what the missing
 * value would mean: a missing password would mean the gate is open, while a
 * missing webhook means the status page is the only place alerts appear —
 * degraded, visible, and safe. Refusing to boot over it would take the whole
 * control plane down to protect a notification.
 */
const alerts: MonitorDeps | undefined = collector && db
  ? {
      collector,
      store: pgIncidentStore(db),
      discordWebhookUrl: process.env.ADMIN_DISCORD_WEBHOOK_URL || undefined,
      mail: mailConfigFromEnv(),
      digestHourUtc: Number(process.env.ADMIN_DIGEST_HOUR_UTC ?? DEFAULT_DIGEST_HOUR_UTC),
      pageUrl: process.env.ADMIN_PUBLIC_URL || undefined,
      hostLabel: process.env.ADMIN_HOST_LABEL || undefined,
    }
  : undefined

/**
 * The fleet item catalogue (#609 slice 7).
 *
 * ⚠️ Optional, and its absence is silent-by-design rather than a failure: with
 * no key the control plane simply never publishes prices, `items_synced_at`
 * stays NULL, and every tenant syncs from its own pool exactly as it did
 * before. That is the SAME null the alert rules treat as "not in service" — the
 * two readings have to agree, or a fleet with no key would page every minute.
 *
 * ⚠️ This is MonChoon's own Torn key, and it is the only Torn credential this
 * box will ever hold. /v2/torn/items is public, which is precisely why this job
 * is one of only two the #608 audit found movable.
 */
const tornApiKey = process.env.ADMIN_TORN_API_KEY || undefined
const items = db && tornApiKey ? { db, apiKey: tornApiKey } : undefined

const publicApp = await buildAdminApp({
  surface: 'public', username, passwordHash, totpSecret, sessionSecret, version, collector, alerts,
  fleetDb: db,
  items,
})
/**
 * The Discord bot's bearer for the tenant registry (#826 follow-up).
 *
 * ⚠️ Derived under its own scope rather than reusing a tenant's metrics token:
 * knowing which factions exist and reading a faction's metrics are different
 * privileges, and one credential should not grant both.
 *
 * ⚠️ Absent without `FLEET_METRICS_SECRET`, which leaves the route answering
 * 503 — "not configured", distinct from "wrong token", so nobody rotates a
 * credential that was never the problem.
 */
const fleetSecret = process.env.FLEET_METRICS_SECRET || undefined
const tenantRegistryToken = fleetSecret
  ? deriveTenantToken(fleetSecret, TENANT_REGISTRY_SCOPE)
  : undefined

const localApp = await buildAdminApp({
  surface: 'local', username, passwordHash, totpSecret, sessionSecret, version, collector, alerts,
  fleetDb: db,
  items,
  tenantRegistryToken,
})

await publicApp.listen({ host: '0.0.0.0', port: publicPort })
await localApp.listen({ host: localBind, port: localPort })

console.log(
  `[admin] v${version} public :${publicPort} (read + provisioning), ` +
  `local ${localBind}:${localPort} (destructive; published to host loopback only)`
)

// ⚠️ Started AFTER both listeners are up. The first cycle polls every tenant
// with a 3s timeout each; running it before `listen` would delay the container
// answering its own healthcheck, and compose would restart it mid-poll — a
// crash loop caused by the monitoring rather than by anything it monitors.
const monitor = alerts
  ? startMonitor(alerts, Number(process.env.ADMIN_ALERT_INTERVAL_MS ?? DEFAULT_INTERVAL_MS))
  : null

const itemsSync = items ? startItemsSync(items) : null
if (!items) {
  console.warn(
    '[admin] item catalogue sync disabled — set ADMIN_TORN_API_KEY to publish prices for the fleet. ' +
    'Tenants keep syncing from their own key pools.'
  )
}

if (alerts) {
  console.log(
    `[admin] monitor armed — discord ${alerts.discordWebhookUrl ? 'configured' : 'OFF'}, ` +
    `digest ${alerts.mail?.url && alerts.mail?.to ? `to ${alerts.mail.to} at ${alerts.digestHourUtc}:00 UTC` : 'OFF'}`
  )
} else {
  console.warn('[admin] monitor disabled — no DATABASE_URL, so there is nowhere to keep incident state')
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, async () => {
    monitor?.stop()
    itemsSync?.stop()
    await Promise.allSettled([publicApp.close(), localApp.close(), db?.end()])
    process.exit(0)
  })
}
