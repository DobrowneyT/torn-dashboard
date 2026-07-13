// Creates a new faction database from db/template.sql, seeds it, writes the
// faction_config identity row, and prints the docker-compose/nginx additions
// the operator needs to wire the faction's API process.
//
// Usage:
//   node db/new-faction.mjs --slug mayhem --name "TNL Mayhem Dashboard" --faction-id 12345
//
// Connection: defaults to the local compose stack, reading deploy/.env for the
// Postgres credentials. Standard PG* env vars override everything.
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import dotenv from 'dotenv'
import pg from 'pg'
import { applyScopedGrants } from './grants.mjs'

const here = dirname(fileURLToPath(import.meta.url))

const composeEnv = {}
dotenv.config({ path: join(here, '..', 'deploy', '.env'), processEnv: composeEnv })
process.env.PGHOST ??= '127.0.0.1'
process.env.PGPORT ??= composeEnv.POSTGRES_HOST_PORT ?? '5432'
process.env.PGUSER ??= composeEnv.POSTGRES_USER ?? 'postgres'
process.env.PGPASSWORD ??= composeEnv.POSTGRES_PASSWORD ?? ''

const { values: args } = parseArgs({
  options: {
    slug: { type: 'string' },
    name: { type: 'string' },
    'faction-id': { type: 'string' },
    // Adopt an EXISTING faction database as a module: provision the scoped
    // credential and deploy artifacts, touch no data (forge's path to
    // tenant-uniformity, and the production-cutover path).
    adopt: { type: 'boolean' },
    // First role assignments (#99): the faction leader (leadership) and the
    // global operator (admin) — everything after is self-serve in Settings.
    'leader-id': { type: 'string' },
    'admin-id': { type: 'string' },
    // Where the deploy artifacts live (compose include, nginx vhost, .env
    // credential line). Defaults to this repo's deploy/; tests redirect it.
    'deploy-dir': { type: 'string' },
  },
})

const slug = args.slug
const displayName = args.name
const tornFactionId = args['faction-id']
const adopt = args.adopt ?? false
const leaderId = args['leader-id']
const adminId = args['admin-id']

for (const [flag, v] of [['--leader-id', leaderId], ['--admin-id', adminId]]) {
  if (v !== undefined && !/^\d+$/.test(v)) {
    console.error(`Invalid ${flag} "${v}" — must be a Torn user id`)
    process.exit(1)
  }
}

if (!slug || (!adopt && (!displayName || !tornFactionId))) {
  console.error(
    'Usage: node new-faction.mjs --slug <slug> --name <display name> --faction-id <torn faction id>\n' +
    '       node new-faction.mjs --slug <slug> --adopt   # existing DB → module'
  )
  process.exit(1)
}
if (!/^[a-z][a-z0-9_]*$/.test(slug)) {
  console.error(`Invalid slug "${slug}" — lowercase letters, digits and underscores only`)
  process.exit(1)
}
if (!adopt && !/^\d+$/.test(tornFactionId)) {
  console.error(`Invalid faction id "${tornFactionId}" — must be numeric`)
  process.exit(1)
}

const dbName = `faction_${slug}`
const roleName = `app_${slug}`
const deployDir = args['deploy-dir'] ?? join(here, '..', 'deploy')

// 1. Create the database (against the maintenance DB) — or, in adopt mode,
// require it to exist already.
const admin = new pg.Client({ database: process.env.PGDATABASE ?? 'postgres' })
await admin.connect()
try {
  const dup = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName])
  if (adopt && dup.rowCount === 0) {
    console.error(`Database ${dbName} does not exist — nothing to adopt`)
    process.exit(2)
  }
  if (!adopt && dup.rowCount > 0) {
    console.error(`Database ${dbName} already exists — refusing to touch it (use --adopt to modularize it)`)
    process.exit(2)
  }
  if (!adopt) await admin.query(`CREATE DATABASE ${dbName}`)
} finally {
  await admin.end()
}

// 2. Apply the template and seeds inside the new database.
const db = new pg.Client({ database: dbName })
await db.connect()
try {
  if (!adopt) {
  await db.query(readFileSync(join(here, 'template.sql'), 'utf8'))

  const seedDir = join(here, 'seed')
  for (const file of readdirSync(seedDir).filter((f) => f.endsWith('.sql')).sort()) {
    await db.query(readFileSync(join(seedDir, file), 'utf8'))
  }

  const itemsPath = join(seedDir, 'items.json')
  if (existsSync(itemsPath)) {
    const items = JSON.parse(readFileSync(itemsPath, 'utf8'))
    const cols = ['id', 'name', 'description', 'effect', 'type', 'sub_type',
      'market_price', 'sell_price', 'buy_price', 'circulation', 'is_tradable', 'image_url']
    for (let at = 0; at < items.length; at += 500) {
      const batch = items.slice(at, at + 500)
      const params = []
      const tuples = batch.map((item, r) => {
        params.push(...cols.map((c) => item[c] ?? null))
        return `(${cols.map((_, c) => `$${r * cols.length + c + 1}`).join(', ')})`
      })
      await db.query(
        `INSERT INTO items (${cols.join(', ')}) VALUES ${tuples.join(', ')}`,
        params
      )
    }
    console.log(`Seeded ${items.length} items`)
  }

  await db.query(
    `INSERT INTO faction_config (slug, display_name, torn_faction_id) VALUES ($1, $2, $3)`,
    [slug, displayName, tornFactionId]
  )
  } // !adopt — adoption touches no schema, seeds, or identity

  // First role grants (#99) — idempotent so adopt/re-runs are safe.
  if (leaderId) {
    await db.query(
      `INSERT INTO role_assignments (torn_user_id, role) VALUES ($1, 'leadership') ON CONFLICT DO NOTHING`,
      [leaderId]
    )
  }
  if (adminId) {
    await db.query(
      `INSERT INTO role_assignments (torn_user_id, role) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`,
      [adminId]
    )
  }

  // 3. Scoped credential: this faction's API connects as app_<slug>, which
  // can only reach its own database. Revoking PUBLIC is what makes the
  // isolation real — otherwise every role may CONNECT to every DB.
  const password = randomBytes(24).toString('hex')
  const roleExists = await db.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [roleName])
  if (roleExists.rowCount > 0) {
    console.error(`Role ${roleName} already exists — refusing to touch it`)
    process.exit(2)
  }
  // Shared with db/restore.mjs — a restored DB has no grants (dumps carry none)
  // and must be able to get them back without recreating the role (#115).
  await applyScopedGrants(db, { dbName, roleName, password })

  // The credential lives in the deploy env file; compose interpolates it
  // into this faction's DATABASE_URL. Never printed. A hand-edited .env may
  // lack a trailing newline — appending must never glue onto its last line.
  const envKey = `DB_PASSWORD_${slug.toUpperCase()}`
  const envPath = join(deployDir, '.env')
  const needsEol = existsSync(envPath) && !readFileSync(envPath, 'utf8').endsWith('\n')
  appendFileSync(envPath, `${needsEol ? '\n' : ''}${envKey}=${password}\n`)
} finally {
  await db.end()
}

// 4. Deploy artifacts. The compose override is auto-loaded by
// `docker compose up`, so a new faction needs no compose-file edits; the
// nginx vhost is baked into the nginx image on its next build.
const OVERRIDE_HEADER = `# Per-faction API processes — managed by db/new-faction.mjs (slice #75).
# Auto-loaded by \`docker compose up\` alongside docker-compose.yml.
services:
`
const serviceBlock = `
  api-${slug}:
    build:
      context: ..
      dockerfile: deploy/server.Dockerfile
    environment:
      FACTION_SLUG: ${slug}
      PORT: 8080
      DATABASE_URL: postgres://${roleName}:\${DB_PASSWORD_${slug.toUpperCase()}}@postgres:5432/${dbName}
      JWT_SECRET: \${JWT_SECRET:?set JWT_SECRET in deploy/.env}
      TORN_API_BASE: \${TORN_API_BASE:-https://api.torn.com}
      KEY_ENCRYPTION_KEY: \${KEY_ENCRYPTION_KEY:-}
      TORNSTATS_API_KEY: \${TORNSTATS_API_KEY:-}
      BSP_API_KEY: \${BSP_API_KEY:-}
    depends_on:
      postgres:
        condition: service_healthy
    restart: unless-stopped
    healthcheck:
      # Liveness probe via the app's own runtime — no curl/wget needed in the image.
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 15s
      timeout: 5s
      retries: 5
      start_period: 10s
`
const overridePath = join(deployDir, 'docker-compose.override.yml')
if (!existsSync(overridePath)) writeFileSync(overridePath, OVERRIDE_HEADER)
appendFileSync(overridePath, serviceBlock)

// Host-header vhost: <slug>.localhost locally, <slug>.<domain> in prod.
// The variable proxy_pass + docker resolver means nginx starts (and the
// other tenants keep serving) even while this API container is down.
const vhost = `# ${displayName} — managed by db/new-faction.mjs (slice #75).
server {
    listen 80;
    server_name ${slug}.*;

    root /usr/share/nginx/html;
    index index.html;

    location /api/ {
        resolver 127.0.0.11 valid=10s;
        set $upstream_${slug} api-${slug}:8080;
        proxy_pass http://$upstream_${slug};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 300s;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
`
mkdirSync(join(deployDir, 'nginx', 'factions'), { recursive: true })
writeFileSync(join(deployDir, 'nginx', 'factions', `${slug}.conf`), vhost)

console.log(`
${adopt ? `Adopted ${dbName} as a module.` : `Created ${dbName} for "${displayName}" (Torn faction ${tornFactionId}).`}

Provisioned:
  - scoped DB role ${roleName} (credential appended to ${join(deployDir, '.env')})
  - ${overridePath} — api-${slug} service (compose picks it up automatically)
  - ${join(deployDir, 'nginx', 'factions', `${slug}.conf`)} — vhost for ${slug}.<your-domain>

Bring it up:
  docker compose -f ${join(deployDir, 'docker-compose.yml')} up -d --build api-${slug} nginx

Then browse http://${slug}.localhost:<HTTP_PORT>/ and grant the leader a role:
  role_assignments via the Settings page, or SQL as a first bootstrap.
`)
