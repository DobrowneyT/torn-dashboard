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

// VAPID keypair for Web Push (#207). Operator step — generate with
// `npx web-push generate-vapid-keys` (see docs/PUSH.md). All three must be set
// for push to arm; otherwise the endpoints still exist but delivery is a no-op.
const vapid =
  process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY
    ? {
        publicKey: process.env.VAPID_PUBLIC_KEY,
        privateKey: process.env.VAPID_PRIVATE_KEY,
        subject: process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
      }
    : null

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

// Readiness flags (#76): flipped true below once background work is armed, so
// /api/health/ready reports the real per-faction state to the uptime monitor.
const health = { scheduler: false, ticker: false }

const app = await buildServer({
  factionSlug,
  db,
  tornBaseUrl,
  jwtSecret,
  keyEncryptionKey,
  health,
  // Spy-stat providers for the war room (#100) — optional, operator-level.
  tornStatsApiKey: process.env.TORNSTATS_API_KEY || undefined,
  bspApiKey: process.env.BSP_API_KEY || undefined,
  // Web Push (#207) — optional; push is disabled until the operator sets it.
  vapid,
  // In-app feedback → GitHub issue (#253) — optional; disabled without a PAT.
  feedbackGithubToken: process.env.FEEDBACK_GITHUB_TOKEN || undefined,
  feedbackGithubRepo: process.env.FEEDBACK_GITHUB_REPO || 'DobrowneyT/torn-forge-oc-system',
  feedbackLabel: process.env.FEEDBACK_LABEL || 'needs-triage',
})
if (vapid) console.log(`[${factionSlug}] Web Push armed (VAPID configured)`)
await app.listen({ port, host: '0.0.0.0' })
console.log(`[${factionSlug}] API listening on :${port}`)

// In-process scrapers (slice #67+): armed whenever the key-at-rest secret
// is present. Every job registers DISABLED — per-job enablement (and
// cadence) is the faction admin's bring-up step in Global Admin, so an
// armed-but-unconfigured faction costs gate-checks and zero Torn calls.
// A failure here (e.g. a faction DB that hasn't had db/migrate.mjs run
// yet) degrades to dashboards-only — it must never crash-loop the API.
if (db) {
  if (!keyEncryptionKey) {
    console.warn(`[${factionSlug}] KEY_ENCRYPTION_KEY not set — scrapers and war-room ticker NOT armed`)
  } else {
    try {
      const { startScrapers } = await import('./scraper/registerJobs.js')
      await startScrapers({
        db, tornBaseUrl, encryptionKey: keyEncryptionKey,
        // #139: lets war-lifecycle auto-fetch spies on the weekly setup.
        tornStatsApiKey: process.env.TORNSTATS_API_KEY || undefined,
        bspApiKey: process.env.BSP_API_KEY || undefined,
      })
      health.scheduler = true
      console.log(`[${factionSlug}] scrapers scheduled`)

      // Re-arm competition boundary timers (#230): any competition whose start
      // or end is still in the future gets its one-off capture timer back after
      // a restart.
      await app.competitionTimers?.rearmAll()

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
          // Surge fan-out (#208) sends background web-push via the #207 service.
          pushService: app.pushService,
        })
        ticker.start()
        health.ticker = true
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
