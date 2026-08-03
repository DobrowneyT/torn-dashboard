// Faction inventory sync — the cron counterpart of the manual
// POST /api/inventory/sync (server/src/leadership.ts). Pulls the faction's
// armory across every tracked category with a pooled key and upserts
// `inventory_items`, so loaned-item tracking and payout valuations stay fresh
// without a leader hitting "Sync" by hand. Writes the same `sync_metadata`
// row (data_type='inventory') the manual path does, attributed to 'scraper'.
import type { JobDeps } from './itemsSync.js'
import type { RunResult } from '../runLog.js'

// The Torn v1 faction-inventory selections the manual sync pulls. Kept in
// lockstep with INVENTORY_CATEGORIES in leadership.ts.
const INVENTORY_CATEGORIES = ['temporary', 'medical', 'utilities', 'drugs', 'armor', 'weapons', 'caches', 'cesium']

export async function inventorySyncJob({ db, pool, client }: JobDeps): Promise<RunResult> {
  const claimed = await pool.claim()
  if (!claimed) throw new Error('no pooled key available')

  const config = await db.query('SELECT torn_faction_id FROM faction_config LIMIT 1')
  const factionId = config.rows[0]?.torn_faction_id
  if (!factionId) throw new Error('no faction id configured')

  // v1 faction endpoint: the client appends key + comment; one call returns
  // every requested category.
  const data = await client.fetch(`/faction/${factionId}?selections=${INVENTORY_CATEGORIES.join(',')}`, claimed.key)

  const rows: Array<Record<string, unknown>> = []
  for (const category of INVENTORY_CATEGORIES) {
    if (!Array.isArray(data[category])) continue
    for (const item of data[category]) {
      rows.push({
        id: String(item.ID),
        name: item.name || `Item ${item.ID}`,
        quantity: item.quantity || 0,
        available: item.available || 0,
        loaned: item.loaned || 0,
        loaned_to: item.loaned_to == null ? null
          : typeof item.loaned_to === 'string' ? item.loaned_to : JSON.stringify(item.loaned_to),
        api_type: item.type || category,
        category,
      })
    }
  }

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
