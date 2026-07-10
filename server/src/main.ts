// Entry point for one per-faction API process. All per-faction identity comes
// from the environment (set by docker compose), never from code.
import pg from 'pg'
import { buildServer } from './app.js'

const factionSlug = process.env.FACTION_SLUG
if (!factionSlug) {
  console.error('FACTION_SLUG is required')
  process.exit(1)
}

const port = Number(process.env.PORT ?? 8080)
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`PORT must be a valid port number, got "${process.env.PORT}"`)
  process.exit(1)
}
const databaseUrl = process.env.DATABASE_URL
const jwtSecret = process.env.JWT_SECRET
const tornBaseUrl = process.env.TORN_API_BASE ?? 'https://api.torn.com'
const keyEncryptionKey = process.env.KEY_ENCRYPTION_KEY || undefined

if (databaseUrl && !jwtSecret) {
  console.error('JWT_SECRET is required when DATABASE_URL is set (auth endpoints need it)')
  process.exit(1)
}
if (!databaseUrl) {
  console.warn(`[${factionSlug}] DATABASE_URL not set — serving /api/health only`)
}

// One pool for the API, scrapers, and ticker. The error handler matters: an
// idle-client error on an unhandled pg.Pool 'error' event kills the process
// (which shows up as an nginx 502 crash-loop).
const db = databaseUrl ? new pg.Pool({ connectionString: databaseUrl }) : undefined
db?.on('error', (err) => console.error(`[${factionSlug}] pg pool error:`, err.message))

const app = await buildServer({
  factionSlug,
  db,
  tornBaseUrl,
  jwtSecret,
  tornApiKey: process.env.TORN_API_KEY || undefined,
  keyEncryptionKey,
})
await app.listen({ port, host: '0.0.0.0' })
console.log(`[${factionSlug}] API listening on :${port}`)

// In-process scrapers (slice #67+): opt-in via SCRAPERS_ENABLED, and the
// key-at-rest secret must be present for the pool. A failure here (e.g. a
// faction DB that hasn't had db/migrate.mjs run yet) degrades to
// dashboards-only — it must never crash-loop the whole API.
if (process.env.SCRAPERS_ENABLED === 'true' && db) {
  if (!keyEncryptionKey) {
    console.error(`[${factionSlug}] SCRAPERS_ENABLED needs KEY_ENCRYPTION_KEY (32-byte hex) — scrapers NOT started`)
  } else {
    try {
      const { startScrapers } = await import('./scraper/registerJobs.js')
      await startScrapers({ db, tornBaseUrl, encryptionKey: keyEncryptionKey })
      console.log(`[${factionSlug}] scrapers scheduled`)

      // War-room ticker (slice #71): runs at 1 Hz but self-gates each tick on
      // war_room_config_v2.enabled + the managed war's active window, so an
      // idle faction costs one SELECT per second and zero Torn calls.
      if (app.warRoomHub) {
        const { createWarRoomTicker } = await import('./warRoomTicker.js')
        const { createKeyPool } = await import('./scraper/keyPool.js')
        const ticker = createWarRoomTicker({
          db,
          pool: createKeyPool({ db, encryptionKey: keyEncryptionKey }),
          hub: app.warRoomHub,
          tornBaseUrl,
        })
        ticker.start()
        console.log(`[${factionSlug}] war-room ticker armed (config-gated)`)
      }
    } catch (err) {
      console.error(
        `[${factionSlug}] scraper startup failed — API continues without scrapers. ` +
        `If this DB predates the scraper slices, run: node db/migrate.mjs`,
        err
      )
    }
  }
}
