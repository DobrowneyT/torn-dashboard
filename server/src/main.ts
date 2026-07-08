// Entry point for one per-faction API process. All per-faction identity comes
// from the environment (set by docker compose), never from code.
import { buildServer } from './app.js'

const factionSlug = process.env.FACTION_SLUG
if (!factionSlug) {
  console.error('FACTION_SLUG is required')
  process.exit(1)
}

const port = Number(process.env.PORT ?? 8080)

const app = await buildServer({ factionSlug })
await app.listen({ port, host: '0.0.0.0' })
console.log(`[${factionSlug}] API listening on :${port}`)
