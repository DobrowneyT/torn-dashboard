// Migration 0059 (#617) against the real pre-migration shape.
//
// The reason this gets its own test, in the spirit of migration-0047's: 0059
// carries a BACKFILL, and a backfill runs exactly once on live data. A count
// summed wrong, or a request silently dropped on the way in, is not something
// a later deploy can put right — the source rows are the only record of what
// people had asked for, and by the time anyone notices, the war is over.
//
// The pre-#617 shape is built by hand rather than taken from template.sql,
// which already carries the NEW table (same reason 0047's test does it).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import EmbeddedPostgres from 'embedded-postgres'
import pg from 'pg'

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
const MIGRATION = readFileSync(join(here, '..', 'migrations', '0059-assist-counts-on-target.sql'), 'utf8')

// The #523/#591 table, including the partial unique index 0059 must drop —
// that index IS the "one live assist per requester" rule being removed, so a
// test that omitted it could not prove the rule is gone.
const OLD_SCHEMA = `
CREATE TABLE public.war_room_assists_v2 (
  id bigserial PRIMARY KEY,
  target_id bigint NOT NULL,
  war_id bigint,
  requester_id bigint NOT NULL,
  requester_name text,
  kind text NOT NULL CHECK (kind IN ('smoke', 'tear', 'help')),
  wanted integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  auto_expire_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX war_room_assists_v2_active_requester_idx
  ON public.war_room_assists_v2 (requester_id) WHERE deleted_at IS NULL;
`

let server, dataDir, client

beforeAll(async () => {
  const port = await freePort()
  dataDir = mkdtempSync(join(tmpdir(), 'tnl-migration-0059-test-'))
  server = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: 'postgres', port, persistent: false })
  await server.initialise()
  await server.start()
  await server.createDatabase('faction_migration_0059_test')
  client = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', password: 'postgres', database: 'faction_migration_0059_test' })
  await client.connect()
  await client.query(OLD_SCHEMA)

  // A live war's worth of the cases that matter, all on distinct targets
  // except 100 — which is the whole point of the migration.
  //
  // ⚠️ Every LIVE row has a distinct requester, and that is a constraint, not
  // a style choice: the partial unique index above is the #523 rule, so a
  // fixture where one person holds two live requests is not a state the old
  // world could reach. (Soft-deleted rows are exempt — the index is partial.)
  // Having to work around it here is the clearest possible statement of what
  // this migration is for.
  await client.query(`
    INSERT INTO war_room_assists_v2
      (target_id, war_id, requester_id, requester_name, kind, wanted, created_at, deleted_at) VALUES
      -- 100: TWO people want a smoke (2 + 3), one wants a tear. Under #523
      -- only one of these could be live at a time; the sum is 5 smokes.
      (100, 7, 111, 'Ann', 'smoke', 2, '2026-09-05T10:00:00Z', NULL),
      (100, 7, 222, 'Bob', 'smoke', 3, '2026-09-05T10:04:00Z', NULL),
      (100, 7, 333, 'Cat', 'tear',  1, '2026-09-05T10:02:00Z', NULL),
      -- 101: two people asked for help — both ids must survive into
      -- help_raised_by, or either could answer their own call.
      (101, 7, 444, 'Dee', 'help',  1, '2026-09-05T10:01:00Z', NULL),
      (101, 7, 555, 'Eve', 'help',  2, '2026-09-05T10:03:00Z', NULL),
      -- 102: soft-deleted, and a live zero. Neither is a request.
      (102, 7, 666, 'Fox', 'smoke', 4, '2026-09-05T10:00:00Z', '2026-09-05T10:05:00Z'),
      (103, 7, 777, 'Gus', 'tear',  0, '2026-09-05T10:00:00Z', NULL)
  `)
}, 60000)

afterAll(async () => {
  await client?.end()
  await server?.stop()
  rmSync(dataDir, { recursive: true, force: true })
})

const counts = async (targetId) => (await client.query(
  'SELECT * FROM war_room_assist_counts_v2 WHERE target_id = $1', [targetId]
)).rows[0] ?? null

describe('migration 0059 against the #523 assists table', () => {
  it('applies, and applies again — a re-run must not double the counts', async () => {
    await expect(client.query(MIGRATION)).resolves.toBeDefined()
    // Idempotency is not academic here: update.sh re-runs migrations on every
    // deploy, so a backfill that added to existing rows instead of skipping
    // them would inflate every count on the next push.
    await expect(client.query(MIGRATION)).resolves.toBeDefined()
  })

  it('⚠️ SUMS two requesters asking for the same kind rather than picking one', async () => {
    // The case the migration exists for. Taking one row would silently discard
    // the other on the way in.
    const row = await counts(100)
    expect(Number(row.smoke_wanted)).toBe(5)
    expect(Number(row.tear_wanted)).toBe(1)
    expect(Number(row.help_wanted)).toBe(0)
  })

  it('keeps a per-kind raise time, taking the most recent of the merged rows', async () => {
    const row = await counts(100)
    expect(row.smoke_raised_at.toISOString()).toBe('2026-09-05T10:04:00.000Z')
    expect(row.tear_raised_at.toISOString()).toBe('2026-09-05T10:02:00.000Z')
    // A kind nobody asked for has no time, which is what stops the sweep
    // expiring it — see warRoomAssistsExpiry's IS NOT NULL guard.
    expect(row.help_raised_at).toBeNull()
  })

  it('⚠️ carries EVERY help requester into help_raised_by', async () => {
    // This is the one thing on the row that is not a count, and it is the only
    // reason the #591 rule survives: whoever asked for help must not be able to
    // answer it by turning up. Losing an id here re-opens that silently.
    const row = await counts(101)
    expect(Number(row.help_wanted)).toBe(3)
    expect([...row.help_raised_by].map(Number).sort((a, b) => a - b)).toEqual([444, 555])
  })

  it('leaves a soft-deleted request and a zero-count request behind', async () => {
    expect(await counts(102)).toBeNull()
    expect(await counts(103)).toBeNull()
  })

  it('⚠️ drops the one-live-assist-per-requester index — the rule being removed', async () => {
    // Leaving it would keep enforcing the exact rule this migration exists to
    // undo, the moment anything wrote to the old table again.
    const idx = await client.query(
      `SELECT 1 FROM pg_indexes WHERE indexname = 'war_room_assists_v2_active_requester_idx'`
    )
    expect(idx.rows).toHaveLength(0)
  })

  it('⚠️ KEEPS the old table — those rows are the only record of what was asked', async () => {
    // A live war can be in flight when this deploys. Dropping the table is a
    // separate, later migration, the same discipline #606 used for its mirror
    // tables.
    const still = await client.query('SELECT count(*)::int AS n FROM war_room_assists_v2')
    expect(still.rows[0].n).toBe(7)
  })

  it('refuses a negative count, so a decrement bug cannot go below zero in the table', async () => {
    await expect(
      client.query(`INSERT INTO war_room_assist_counts_v2 (target_id, smoke_wanted) VALUES (900, -1)`)
    ).rejects.toThrow()
  })
})
