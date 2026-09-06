/**
 * Admin control plane entrypoint (#609 slice 2).
 *
 * Starts TWO listeners from one process:
 *
 *   0.0.0.0:8090   public  — behind nginx at admin.monchoon.me
 *   127.0.0.1:8091 local   — reachable only over an SSH tunnel
 *
 * ⚠️ The local listener binds to loopback INSIDE the container, which is not
 * the same as loopback on the host — a container's 127.0.0.1 is its own. It is
 * reached by publishing that port to the host's loopback in compose
 * (`127.0.0.1:8091:8091`), so it is unroutable from outside the VPS while an
 * SSH tunnel can reach it. The bind and the port publication have to agree;
 * either alone is not the guarantee.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { buildAdminApp } from './adminPlane/app.js'
import { looksHashed } from './adminPlane/password.js'

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
      `Generate credentials with: node db/admin-password.mjs`
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
    'node db/admin-password.mjs, not a plaintext password.'
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

// ⚠️ Status collection needs no privilege beyond reading `pg_database` for the
// tenant list: tenants are polled over plain HTTP on the compose network, and
// `app_global_rw` cannot CONNECT to any faction database (verified on the live
// cluster). No Docker socket, no per-tenant credential.
const collector = db
  ? { db, backupDir: process.env.ADMIN_BACKUP_DIR ?? '/backups' }
  : undefined

const publicApp = await buildAdminApp({
  surface: 'public', username, passwordHash, totpSecret, sessionSecret, version, collector,
})
const localApp = await buildAdminApp({
  surface: 'local', username, passwordHash, totpSecret, sessionSecret, version, collector,
})

await publicApp.listen({ host: '0.0.0.0', port: publicPort })
await localApp.listen({ host: '127.0.0.1', port: localPort })

console.log(`[admin] v${version} public :${publicPort} (read + provisioning), local :${localPort} (destructive)`)

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, async () => {
    await Promise.allSettled([publicApp.close(), localApp.close(), db?.end()])
    process.exit(0)
  })
}
