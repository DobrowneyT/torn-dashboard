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

if (databaseUrl && !jwtSecret) {
  console.error('JWT_SECRET is required when DATABASE_URL is set (auth endpoints need it)')
  process.exit(1)
}
if (!databaseUrl) {
  console.warn(`[${factionSlug}] DATABASE_URL not set — serving /api/health only`)
}

const app = await buildServer({
  factionSlug,
  db: databaseUrl ? new pg.Pool({ connectionString: databaseUrl }) : undefined,
  tornBaseUrl,
  jwtSecret,
  tornApiKey: process.env.TORN_API_KEY || undefined,
})
await app.listen({ port, host: '0.0.0.0' })
console.log(`[${factionSlug}] API listening on :${port}`)

// In-process scrapers (slice #67+): opt-in via SCRAPERS_ENABLED, and the
// key-at-rest secret must be present for the pool.
if (process.env.SCRAPERS_ENABLED === 'true' && databaseUrl) {
  const encryptionKey = process.env.KEY_ENCRYPTION_KEY
  if (!encryptionKey) {
    console.error(`[${factionSlug}] SCRAPERS_ENABLED needs KEY_ENCRYPTION_KEY (32-byte hex)`)
    process.exit(1)
  }
  const { startScrapers } = await import('./scraper/registerJobs.js')
  await startScrapers({
    db: new pg.Pool({ connectionString: databaseUrl }),
    tornBaseUrl,
    encryptionKey,
  })
  console.log(`[${factionSlug}] scrapers scheduled`)
}
