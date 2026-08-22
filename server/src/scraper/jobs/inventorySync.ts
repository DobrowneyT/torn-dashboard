// Faction inventory sync — the cron counterpart of the manual
// POST /api/inventory/sync (server/src/leadership.ts). Pulls the faction's
// armory across every tracked category with a pooled key and upserts
// `inventory_items`, so loaned-item tracking and payout valuations stay fresh
// without a leader hitting "Sync" by hand. Writes the same `sync_metadata`
// row (data_type='inventory') the manual path does, attributed to 'scraper'.
import type { JobDeps } from './itemsSync.js'
import type { RunResult } from '../runLog.js'
import { fetchFactionInventoryV2, aggregateInventoryRows } from '../inventoryMap.js'

export async function inventorySyncJob({ db, pool, client }: JobDeps): Promise<RunResult> {
  const claimed = await pool.claim()
  if (!claimed) throw new Error('no pooled key available')

  const raw = await fetchFactionInventoryV2(
    (query) => client.fetch(`/v2/faction/inventory?${query}`, claimed.key)
  )
  const rows = aggregateInventoryRows(raw)

  const dbc = await db.connect()
  try {
    await dbc.query('BEGIN')
    for (const r of rows) {
      await dbc.query(
        `INSERT INTO inventory_items (id, name, quantity, available, loaned, loaned_to, api_type, category, last_synced)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, quantity = EXCLUDED.quantity, available = EXCLUDED.available,
           loaned = EXCLUDED.loaned, loaned_to = EXCLUDED.loaned_to, api_type = EXCLUDED.api_type,
           category = EXCLUDED.category, last_synced = now()`,
        [r.id, r.name, r.quantity, r.available, r.loaned, r.loaned_to, r.api_type, r.category]
      )
    }
    await dbc.query(
      `INSERT INTO sync_metadata (data_type, last_sync, synced_by) VALUES ('inventory', now(), 'scraper')`
    )
    await dbc.query('COMMIT')
  } catch (err) {
    await dbc.query('ROLLBACK')
    throw err
  } finally {
    dbc.release()
  }

  return { rows: rows.length }
}
