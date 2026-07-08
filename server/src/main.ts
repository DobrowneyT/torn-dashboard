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
})
await app.listen({ port, host: '0.0.0.0' })
console.log(`[${factionSlug}] API listening on :${port}`)
