// Regression test for a migration that crashed on every production deploy
// attempt (server stuck on 3.54.0 for a day): 0047 tried to ALTER
// inventory_items.loaned_to's type while inventory_items_with_prices (and 9
// per-category views built on top of it) still SELECTed it — Postgres
// refuses that outright ("cannot alter type of a column used by a view or
// rule"). This builds the pre-migration schema shape by hand (the CURRENT
// template.sql already has loaned_to as jsonb, so it can't stand in for the
// "before" state) and proves 0047 now survives the exact view chain that
// broke it, twice (idempotency).
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
const MIGRATION = readFileSync(join(here, '..', 'migrations', '0047-inventory-loaned-structured.sql'), 'utf8')

// The pre-#542 shape, minimal: just the table and view chain 0047 touches.
// View SQL is identical whether loaned_to is text or jsonb (a passthrough
// column), so this is the same DDL 0047 itself uses to recreate them —
// what matters for this test is that loaned_to STARTS as text.
const OLD_SCHEMA = `
CREATE TABLE public.pricing_batches (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id text,
  price bigint NOT NULL,
  quantity integer NOT NULL,
  added_at timestamp without time zone DEFAULT now(),
  added_by text NOT NULL
);
CREATE TABLE public.inventory_items (
  id text NOT NULL,
  name text NOT NULL,
  quantity integer DEFAULT 0,
  available integer DEFAULT 0,
  loaned integer DEFAULT 0,
  loaned_to text,
  api_type text,
  category text,
  last_synced timestamp without time zone DEFAULT now()
);

CREATE VIEW public.inventory_items_with_prices AS
 SELECT ii.id AS item_id, ii.name AS item_name, ii.quantity, ii.available, ii.loaned,
        ii.loaned_to, ii.api_type, ii.category, ii.last_synced,
        COALESCE(sum(pb.price * pb.quantity) / NULLIF(sum(pb.quantity), 0)::numeric, 0::numeric) AS weighted_avg_price,
        COALESCE(sum(pb.quantity), 0::bigint) AS total_batched_quantity,
        COALESCE(sum(pb.price * pb.quantity) / NULLIF(sum(pb.quantity), 0)::numeric * ii.quantity::numeric, 0::numeric) AS total_value,
        max(pb.added_at) AS last_price_update
   FROM inventory_items ii LEFT JOIN pricing_batches pb ON ii.id = pb.item_id
  GROUP BY ii.id, ii.name, ii.quantity, ii.available, ii.loaned, ii.loaned_to, ii.api_type, ii.category, ii.last_synced;

CREATE VIEW public.inventory_weapons AS
 SELECT item_id, item_name, quantity, available, loaned, loaned_to, api_type, category, last_synced,
        weighted_avg_price, total_batched_quantity, total_value, last_price_update
   FROM inventory_items_with_prices WHERE category = 'weapons'::text;
CREATE VIEW public.inventory_caches AS
 SELECT item_id, item_name, quantity, available, loaned, loaned_to, api_type, category, last_synced,
        weighted_avg_price, total_batched_quantity, total_value, last_price_update
   FROM inventory_items_with_prices WHERE category = 'caches'::text;

INSERT INTO inventory_items (id, name, quantity, available, loaned, loaned_to, category) VALUES
  ('220', 'Grenade', 100, 90, 10, 'Bob [700]', 'weapons');
`

let server, dataDir, client

beforeAll(async () => {
  const port = await freePort()
  dataDir = mkdtempSync(join(tmpdir(), 'tnl-migration-0047-test-'))
  server = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: 'postgres', port, persistent: false })
  await server.initialise()
  await server.start()
  await server.createDatabase('faction_migration_0047_test')
  client = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', password: 'postgres', database: 'faction_migration_0047_test' })
  await client.connect()
  await client.query(OLD_SCHEMA)
}, 30000)

afterAll(async () => {
  await client?.end()
  await server?.stop()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('migration 0047 against the pre-existing view chain', () => {
  it('survives inventory_items_with_prices and its dependent category views, and converts the column', async () => {
    await expect(client.query(MIGRATION)).resolves.toBeDefined()

    const col = await client.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_name = 'inventory_items' AND column_name = 'loaned_to'`
    )
    expect(col.rows[0].data_type).toBe('jsonb')

    // The dependent views survived the CASCADE drop + recreate, still usable.
    const weapons = await client.query('SELECT item_id, category FROM inventory_weapons')
    expect(weapons.rows).toEqual([{ item_id: '220', category: 'weapons' }])
    const caches = await client.query('SELECT count(*)::int n FROM inventory_caches')
    expect(caches.rows[0].n).toBe(0)

    // Old string data cannot be recovered (no id/amount in a name-only join) —
    // resets to NULL, the next inventory sync repopulates it.
    const row = await client.query('SELECT loaned_to FROM inventory_items WHERE id = $1', ['220'])
    expect(row.rows[0].loaned_to).toBeNull()
  })

  it('is idempotent — re-running against the now-jsonb column is a no-op', async () => {
    await expect(client.query(MIGRATION)).resolves.toBeDefined()
    const weapons = await client.query('SELECT count(*)::int n FROM inventory_weapons')
    expect(weapons.rows[0].n).toBe(1)
  })
})
