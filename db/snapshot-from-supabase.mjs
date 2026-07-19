// Restores a Forge data snapshot from the live Supabase project into a local
// faction database, via PostgREST with the service-role key (both read from
// the repo-root .env). Used to verify migrated pages against real data before
// the big-bang cutover; safe to re-run (truncates the listed tables first).
//
//   node db/snapshot-from-supabase.mjs [--db faction_forge] [--full-attacks]
//
// Deliberately skipped: member_secrets (never copy key material out of
// production). faction_attacks defaults to recent rows (the full table is
// 400k+; the war pages only need windows for recent wars) — pass
// --full-attacks for the real cutover, where full history matters.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import dotenv from 'dotenv'
import pg from 'pg'

const here = dirname(fileURLToPath(import.meta.url))
const rootEnv = {}
dotenv.config({ path: join(here, '..', '.env'), processEnv: rootEnv })
const composeEnv = {}
dotenv.config({ path: join(here, '..', 'deploy', '.env'), processEnv: composeEnv })

const SUPABASE_URL = rootEnv.VITE_SUPABASE_URL
const SERVICE_KEY = rootEnv.VITE_SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('VITE_SUPABASE_URL / VITE_SUPABASE_SERVICE_ROLE_KEY missing from .env')
  process.exit(1)
}

const { values: args } = parseArgs({
  options: { db: { type: 'string' }, 'full-attacks': { type: 'boolean' } },
})
const dbName = args.db ?? 'faction_forge'

// Ordered parents-before-children so inserts satisfy FKs.
// filter = PostgREST query string appended to the fetch.
const thirtyFiveDaysAgo = new Date(Date.now() - 35 * 24 * 3600 * 1000).toISOString().slice(0, 10)
const TABLES = [
  { name: 'members' },
  { name: 'member_cpr_v2' },
  { name: 'member_daily_stats', filter: `snapshot_date=gte.${thirtyFiveDaysAgo}` },
  { name: 'oc_payout_weeks' },
  { name: 'oc_payout_members' },
  { name: 'crimes' },
  { name: 'crime_slots' },
  { name: 'crime_reward_items' },
  { name: 'crime_required_items' },
  { name: 'ranked_wars' },
  {
    name: 'faction_attacks',
    filter: args['full-attacks']
      ? undefined
      : `started=gte.${Math.floor(Date.now() / 1000) - 35 * 24 * 3600}`,
  },
  { name: 'war_member_contributions' },
  { name: 'war_payouts' },
  { name: 'war_payout_members' },
  { name: 'faction_revives' },
  { name: 'inventory_items' },
  { name: 'pricing_batches' },
  { name: 'tier_requirements' },
  { name: 'member_overview_views' },
  { name: 'member_overview_thresholds' },
  { name: 'factions' },
]

async function fetchAll(table, filter) {
  const rows = []
  const page = 1000
  for (let from = 0; ; from += page) {
    const url = `${SUPABASE_URL}/rest/v1/${table}?select=*${filter ? `&${filter}` : ''}`
    const res = await fetch(url, {
      headers: {
        apikey: SERVICE_KEY,
        authorization: `Bearer ${SERVICE_KEY}`,
        Range: `${from}-${from + page - 1}`,
      },
    })
    if (!res.ok) throw new Error(`${table}: PostgREST ${res.status} ${await res.text()}`)
    const batch = await res.json()
    rows.push(...batch)
    if (batch.length < page) return rows
  }
}

const db = new pg.Client({
  host: '127.0.0.1',
  port: Number(process.env.PGPORT ?? composeEnv.POSTGRES_HOST_PORT ?? 5432),
  user: process.env.PGUSER ?? composeEnv.POSTGRES_USER ?? 'postgres',
  password: process.env.PGPASSWORD ?? composeEnv.POSTGRES_PASSWORD,
  database: dbName,
})
await db.connect()

try {
  // Children truncate with their parents via CASCADE.
  await db.query(`TRUNCATE ${TABLES.map((t) => t.name).join(', ')} CASCADE`)

  for (const { name, filter } of TABLES) {
    const rows = await fetchAll(name, filter)
    if (rows.length === 0) {
      console.log(`${name}: 0 rows`)
      continue
    }
    const cols = Object.keys(rows[0])
    const colList = cols.map((c) => `"${c}"`).join(', ')
    const batchSize = Math.max(1, Math.floor(30000 / cols.length))
    for (let at = 0; at < rows.length; at += batchSize) {
      const batch = rows.slice(at, at + batchSize)
      const params = []
      const tuples = batch.map((row, r) => {
        params.push(...cols.map((c) => {
          const v = row[c]
          // node-pg can't tell json from array columns for plain objects.
          return v !== null && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : v
        }))
        return `(${cols.map((_, i) => `$${r * cols.length + i + 1}`).join(', ')})`
      })
      // OVERRIDING SYSTEM VALUE lets snapshot rows keep their identity ids.
      await db.query(
        `INSERT INTO "${name}" (${colList}) OVERRIDING SYSTEM VALUE VALUES ${tuples.join(', ')}`,
        params
      )
    }
    console.log(`${name}: ${rows.length} rows`)
  }

  // Re-align sequences past the snapshot's explicit ids. Enumerate via
  // pg_depend ('a' = serial, 'i' = identity) — calling pg_get_serial_sequence
  // in a WHERE clause errors on tables without the column.
  const seqs = await db.query(`
    SELECT sn.nspname AS seq_schema, s.relname AS seq,
           tn.nspname AS tab_schema, t.relname AS tab, a.attname AS col
    FROM pg_class s
    JOIN pg_namespace sn ON sn.oid = s.relnamespace
    JOIN pg_depend d ON d.objid = s.oid AND d.deptype IN ('a', 'i')
    JOIN pg_class t ON t.oid = d.refobjid
    JOIN pg_namespace tn ON tn.oid = t.relnamespace
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
    WHERE s.relkind = 'S'
  `)
  for (const { seq_schema, seq, tab_schema, tab, col } of seqs.rows) {
    await db.query(
      `SELECT setval('"${seq_schema}"."${seq}"', GREATEST(COALESCE((SELECT max("${col}") FROM "${tab_schema}"."${tab}"), 1), 1))`
    )
  }
  console.log(`Snapshot restored into ${dbName}.`)
} finally {
  await db.end()
}
