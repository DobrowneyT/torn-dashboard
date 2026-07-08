// Creates a new faction database from db/template.sql, seeds it, writes the
// faction_config identity row, and prints the docker-compose/nginx additions
// the operator needs to wire the faction's API process.
//
// Usage:
//   node db/new-faction.mjs --slug mayhem --name "TNL Mayhem Dashboard" --faction-id 12345
//
// Connection: defaults to the local compose stack, reading deploy/.env for the
// Postgres credentials. Standard PG* env vars override everything.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import dotenv from 'dotenv'
import pg from 'pg'

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
  },
})

const slug = args.slug
const displayName = args.name
const tornFactionId = args['faction-id']

if (!slug || !displayName || !tornFactionId) {
  console.error('Usage: node new-faction.mjs --slug <slug> --name <display name> --faction-id <torn faction id>')
  process.exit(1)
}
if (!/^[a-z][a-z0-9_]*$/.test(slug)) {
  console.error(`Invalid slug "${slug}" — lowercase letters, digits and underscores only`)
  process.exit(1)
}
if (!/^\d+$/.test(tornFactionId)) {
  console.error(`Invalid faction id "${tornFactionId}" — must be numeric`)
  process.exit(1)
}

const dbName = `faction_${slug}`

// 1. Create the database (against the maintenance DB).
const admin = new pg.Client({ database: process.env.PGDATABASE ?? 'postgres' })
await admin.connect()
try {
  const dup = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName])
  if (dup.rowCount > 0) {
    console.error(`Database ${dbName} already exists — refusing to touch it`)
    process.exit(2)
  }
  await admin.query(`CREATE DATABASE ${dbName}`)
} finally {
  await admin.end()
}

// 2. Apply the template and seeds inside the new database.
const db = new pg.Client({ database: dbName })
await db.connect()
try {
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
} finally {
  await db.end()
}

console.log(`
Created ${dbName} for "${displayName}" (Torn faction ${tornFactionId}).

Add the faction's API process to deploy/docker-compose.yml:

  api-${slug}:
    build:
      context: ..
      dockerfile: deploy/server.Dockerfile
    environment:
      FACTION_SLUG: ${slug}
      DATABASE_URL: postgres://\${POSTGRES_USER}:\${POSTGRES_PASSWORD}@postgres:5432/${dbName}
    depends_on:
      postgres:
        condition: service_healthy
    restart: unless-stopped

And route the subdomain in deploy/nginx/default.conf:

  # inside the map $host $faction_api block:
  ${slug}.YOUR_DOMAIN  api-${slug}:8080;
`)
