// Tests at the provisioned-database seam: apply db/template.sql to a real,
// disposable Postgres and verify the resulting faction DB through SQL only —
// exactly how the API service will consume it.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import EmbeddedPostgres from 'embedded-postgres'
import pg from 'pg'

// Fixed ports flake when runners share a host; ask the OS for a free one.
function freePort() {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

const here = dirname(fileURLToPath(import.meta.url))
const TEMPLATE = readFileSync(join(here, '..', 'template.sql'), 'utf8')

// Independent source of truth: the table inventory of the live database
// (captured 2026-07-08) plus the two tables new to the multi-faction stack.
const LIVE_TABLES = [
  'crime_required_items', 'crime_reward_items', 'crime_slots', 'crimes',
  'faction_attacks', 'faction_revives', 'factions', 'inventory_items', 'items',
  'member_cpr_data', 'member_cpr_v2', 'member_daily_stats',
  'member_overview_thresholds', 'member_overview_views', 'member_secrets',
  'members', 'oc_crime_positions', 'oc_crime_types', 'oc_payout_members',
  'oc_payout_weeks', 'pricing_batches', 'ranked_wars', 'sync_metadata',
  'tier_requirements', 'war_member_contributions', 'war_payout_members',
  'war_payouts', 'war_room_auth_cache', 'war_room_chain_v2',
  'war_room_config_v2', 'war_room_dibs_v2', 'war_room_notes_private_v2',
  'war_room_notes_v2', 'war_room_roll_call_v2', 'war_room_state_v2',
]
const NEW_TABLES = [
  'faction_config', 'faction_secrets', 'faction_settings', 'role_assignments',
  // Scraper core (slice #67)
  'scraper_jobs', 'scraper_runs',
  // Crime participation log (#168) + uploaded branding images (#173)
  'crime_participation_v2', 'faction_branding_assets',
]

let server
let dataDir
let client

beforeAll(async () => {
  const port = await freePort()
  dataDir = mkdtempSync(join(tmpdir(), 'tnl-template-test-'))
  server = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
  })
  await server.initialise()
  await server.start()
  await server.createDatabase('faction_template_test')

  client = new pg.Client({
    host: '127.0.0.1',
    port,
    user: 'postgres',
    password: 'postgres',
    database: 'faction_template_test',
  })
  await client.connect()
  await client.query(TEMPLATE)
})

afterAll(async () => {
  await client?.end()
  await server?.stop()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('faction DB template', () => {
  it('creates every app table from the live schema plus the multi-faction config tables', async () => {
    const res = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
    )
    const created = res.rows.map((r) => r.table_name).sort()
    expect(created).toEqual([...LIVE_TABLES, ...NEW_TABLES].sort())
  })

  it('stores and retrieves an encrypted member API key, flagging the member', async () => {
    await client.query(
      `INSERT INTO members (member_id, member_name) VALUES ('42', 'Tester')`
    )
    await client.query(
      `SELECT set_member_api_key('42', 'ABCD1234ABCD1234', 'unit-test-secret',
                                 3::smallint, true, 'Member', 'v1')`
    )
    const key = await client.query(
      `SELECT get_member_api_key('42', 'unit-test-secret') AS key`
    )
    expect(key.rows[0].key).toBe('ABCD1234ABCD1234')

    const flag = await client.query(
      `SELECT has_cpr_key FROM members WHERE member_id = '42'`
    )
    expect(flag.rows[0].has_cpr_key).toBe(true)
  })

  it('maintains updated_at on war-room rows without pg_cron machinery', async () => {
    await client.query(
      `INSERT INTO war_room_dibs_v2 (target_id, claimed_by, claimed_name, updated_at)
       VALUES (1001, 42, 'Tester', '2000-01-01T00:00:00Z')`
    )
    const res = await client.query(
      `SELECT updated_at > now() - interval '1 minute' AS touched
       FROM war_room_dibs_v2 WHERE target_id = 1001`
    )
    expect(res.rows[0].touched).toBe(true)
  })
})
