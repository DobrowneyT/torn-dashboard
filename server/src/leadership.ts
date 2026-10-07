// Leadership tools: member-overview saved views/thresholds, tier overrides,
// and inventory management. Purpose-built endpoints replace the old generic
// arbitrary-table CRUD; reads are lead-gated, writes leadership/admin.
import { withTornAuth } from './tornComment.js'
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { requireRole } from './authz.js'
import { claimPooledKey, EMPTY_POOL_MESSAGE } from './scraper/keyPool.js'
import { projectPersonalstats } from './overviewStatPaths.js'
import { fetchFactionInventoryV2, aggregateInventoryRows } from './scraper/inventoryMap.js'

// Overview time windows (days). 'all' imposes no lower bound.
const OVERVIEW_WINDOW_DAYS: Record<string, number> = { '7': 7, '30': 30, '90': 90, '365': 365 }

export interface LeadershipDeps {
  db: pg.Pool
  tornBaseUrl: string
  /** Key-at-rest secret — server-side Torn syncs claim from the pool (#98). */
  encryptionKey?: string
}

const READ = { preHandler: requireRole('leadership', 'admin') }
const WRITE = { preHandler: [requireRole('leadership', 'admin')] }

export function registerLeadershipRoutes(app: FastifyInstance, deps: LeadershipDeps) {
  const db = deps.db
  // Attribution for created_by_* columns: the session's member row.
  async function attribution(tornUserId: string) {
    const res = await db.query('SELECT member_name FROM members WHERE member_id = $1', [tornUserId])
    return { id: tornUserId, name: res.rows[0]?.member_name ?? null }
  }

  app.get('/api/overview/views', READ, async () => {
    const res = await db.query(
      'SELECT id, name, columns, created_by_id, created_by_name, updated_at FROM member_overview_views ORDER BY name ASC'
    )
    return { views: res.rows }
  })

  app.post('/api/overview/views', WRITE, async (req, reply) => {
    const body = req.body as { name?: unknown; columns?: unknown } | null
    if (typeof body?.name !== 'string' || body.name.trim() === '' || !Array.isArray(body.columns)) {
      return reply.status(400).send({ error: 'name and columns (array) are required' })
    }
    const by = await attribution(req.session!.torn_user_id)
    const res = await db.query(
      `INSERT INTO member_overview_views (name, columns, created_by_id, created_by_name)
       VALUES ($1, $2, $3, $4) RETURNING id, name, columns, created_by_id, created_by_name, updated_at`,
      [body.name.trim(), JSON.stringify(body.columns), by.id, by.name]
    )
    return { view: res.rows[0] }
  })

  app.put('/api/overview/views/:id', WRITE, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as { name?: unknown; columns?: unknown } | null
    if (typeof body?.name !== 'string' || body.name.trim() === '' || !Array.isArray(body.columns)) {
      return reply.status(400).send({ error: 'name and columns (array) are required' })
    }
    const res = await db.query(
      `UPDATE member_overview_views SET name = $1, columns = $2, updated_at = now()
       WHERE id = $3 RETURNING id, name, columns, created_by_id, created_by_name, updated_at`,
      [body.name.trim(), JSON.stringify(body.columns), id]
    )
    if (res.rows.length === 0) return reply.status(404).send({ error: 'View not found' })
    return { view: res.rows[0] }
  })

  app.delete('/api/overview/views/:id', WRITE, async (req, reply) => {
    const { id } = req.params as { id: string }
    const res = await db.query('DELETE FROM member_overview_views WHERE id = $1 RETURNING id', [id])
    if (res.rows.length === 0) return reply.status(404).send({ error: 'View not found' })
    return { deleted: true }
  })

  // Threshold sets: same contract as views, with a jsonb object payload.
  const isPlainObject = (v: unknown) => v !== null && typeof v === 'object' && !Array.isArray(v)

  app.get('/api/overview/thresholds', READ, async () => {
    const res = await db.query(
      'SELECT id, name, thresholds, created_by_id, created_by_name, updated_at FROM member_overview_thresholds ORDER BY name ASC'
    )
    return { thresholds: res.rows }
  })

  app.post('/api/overview/thresholds', WRITE, async (req, reply) => {
    const body = req.body as { name?: unknown; thresholds?: unknown } | null
    if (typeof body?.name !== 'string' || body.name.trim() === '' || !isPlainObject(body.thresholds)) {
      return reply.status(400).send({ error: 'name and thresholds (object) are required' })
    }
    const by = await attribution(req.session!.torn_user_id)
    const res = await db.query(
      `INSERT INTO member_overview_thresholds (name, thresholds, created_by_id, created_by_name)
       VALUES ($1, $2, $3, $4) RETURNING id, name, thresholds, created_by_id, created_by_name, updated_at`,
      [body.name.trim(), JSON.stringify(body.thresholds), by.id, by.name]
    )
    return { threshold: res.rows[0] }
  })

  app.put('/api/overview/thresholds/:id', WRITE, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as { name?: unknown; thresholds?: unknown } | null
    if (typeof body?.name !== 'string' || body.name.trim() === '' || !isPlainObject(body.thresholds)) {
      return reply.status(400).send({ error: 'name and thresholds (object) are required' })
    }
    const res = await db.query(
      `UPDATE member_overview_thresholds SET name = $1, thresholds = $2, updated_at = now()
       WHERE id = $3 RETURNING id, name, thresholds, created_by_id, created_by_name, updated_at`,
      [body.name.trim(), JSON.stringify(body.thresholds), id]
    )
    if (res.rows.length === 0) return reply.status(404).send({ error: 'Threshold set not found' })
    return { threshold: res.rows[0] }
  })

  app.delete('/api/overview/thresholds/:id', WRITE, async (req, reply) => {
    const { id } = req.params as { id: string }
    const res = await db.query('DELETE FROM member_overview_thresholds WHERE id = $1 RETURNING id', [id])
    if (res.rows.length === 0) return reply.status(404).send({ error: 'Threshold set not found' })
    return { deleted: true }
  })

  // The overview grid's input: every member's snapshots over a window, in one
  // response (no client paging against a row cap). Accepts either `window`
  // (7/30/90/365/all) or a legacy `since` (YYYY-MM-DD). personalstats is
  // projected down to the catalog paths the grid can display (#285), keeping
  // the same nested shape so long/`all` windows stay small on the wire.
  app.get('/api/overview/daily-stats', READ, async (req, reply) => {
    const { window, since } = req.query as { window?: string; since?: string }

    let lowerBound: string | null = null
    if (window != null) {
      if (window === 'all') {
        lowerBound = null
      } else if (OVERVIEW_WINDOW_DAYS[window] != null) {
        lowerBound = new Date(Date.now() - OVERVIEW_WINDOW_DAYS[window] * 86400_000)
          .toISOString().slice(0, 10)
      } else {
        return reply.status(400).send({ error: 'window must be one of 7, 30, 90, 365, all' })
      }
    } else if (since != null) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
        return reply.status(400).send({ error: 'since must be YYYY-MM-DD' })
      }
      lowerBound = since
    } else {
      return reply.status(400).send({ error: 'window (7/30/90/365/all) or since (YYYY-MM-DD) is required' })
    }

    const res = await db.query(
      `SELECT member_id, snapshot_date, personalstats, profile, is_donator, property_name,
              last_action_timestamp, gym_strength, gym_speed, gym_dexterity, gym_defense, gym_energy
       FROM member_daily_stats
       ${lowerBound ? 'WHERE snapshot_date >= $1' : ''}
       ORDER BY member_id ASC, snapshot_date DESC`,
      lowerBound ? [lowerBound] : []
    )
    for (const row of res.rows) {
      if (row.personalstats != null) row.personalstats = projectPersonalstats(row.personalstats)
    }
    return { snapshots: res.rows }
  })

  app.get('/api/inventory', READ, async () => {
    const [items, sync] = await Promise.all([
      db.query('SELECT * FROM inventory_items_with_prices ORDER BY item_name'),
      db.query(
        `SELECT last_sync FROM sync_metadata WHERE data_type = 'inventory'
         ORDER BY last_sync DESC LIMIT 1`
      ),
    ])
    return { items: items.rows, last_sync: sync.rows[0]?.last_sync ?? null }
  })

  app.post('/api/inventory/pricing-batches', WRITE, async (req, reply) => {
    const body = req.body as { item_id?: unknown; price?: unknown; quantity?: unknown } | null
    const price = Number(body?.price)
    const quantity = Number(body?.quantity)
    if (typeof body?.item_id !== 'string' || !Number.isFinite(price) || price < 0 ||
        !Number.isInteger(quantity) || quantity < 1) {
      return reply.status(400).send({ error: 'item_id, price (>= 0) and quantity (>= 1) are required' })
    }
    const item = await db.query('SELECT id FROM inventory_items WHERE id = $1', [body.item_id])
    if (item.rows.length === 0) return reply.status(404).send({ error: 'Inventory item not found' })

    const by = await attribution(req.session!.torn_user_id)
    const res = await db.query(
      `INSERT INTO pricing_batches (item_id, price, quantity, added_by)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [body.item_id, Math.floor(price), quantity, by.name ?? by.id]
    )
    return { batch: res.rows[0] }
  })

  // "Set price": replace every batch with a single one at the new price for
  // the item's full current quantity.
  app.put('/api/inventory/items/:id/price', WRITE, async (req, reply) => {
    const { id } = req.params as { id: string }
    const price = Number((req.body as { price?: unknown } | null)?.price)
    if (!Number.isFinite(price) || price < 0) {
      return reply.status(400).send({ error: 'price (>= 0) is required' })
    }
    const item = await db.query('SELECT id, quantity FROM inventory_items WHERE id = $1', [id])
    if (item.rows.length === 0) return reply.status(404).send({ error: 'Inventory item not found' })

    const by = await attribution(req.session!.torn_user_id)
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM pricing_batches WHERE item_id = $1', [id])
      await client.query(
        'INSERT INTO pricing_batches (item_id, price, quantity, added_by) VALUES ($1, $2, $3, $4)',
        [id, Math.floor(price), item.rows[0].quantity, by.name ?? by.id]
      )
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
    return { item_id: id, price: Math.floor(price), quantity: item.rows[0].quantity }
  })

  // Pull the faction inventory from Torn with a pooled key and replace the
  // stored quantities.
  app.post('/api/inventory/sync', WRITE, async (req, reply) => {
    const claimed = await claimPooledKey(db, deps.encryptionKey)
    if (!claimed) return reply.status(503).send({ error: EMPTY_POOL_MESSAGE })

    let raw: Awaited<ReturnType<typeof fetchFactionInventoryV2>>
    try {
      raw = await fetchFactionInventoryV2(async (query) => {
        const res = await fetch(withTornAuth(`${deps.tornBaseUrl}/v2/faction/inventory?${query}`, claimed.key))
        const data = (await res.json()) as Record<string, any>
        if (data.error) throw new Error(data.error.error)
        return data
      })
    } catch (err) {
      return reply.status(502).send({ error: `Torn API: ${(err as Error).message}` })
    }
    const rows = aggregateInventoryRows(raw)

    const by = await attribution(req.session!.torn_user_id)
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      for (const r of rows) {
        await client.query(
          `INSERT INTO inventory_items (id, name, quantity, available, loaned, loaned_to, api_type, category, last_synced)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
           ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name, quantity = EXCLUDED.quantity, available = EXCLUDED.available,
             loaned = EXCLUDED.loaned, loaned_to = EXCLUDED.loaned_to, api_type = EXCLUDED.api_type,
             category = EXCLUDED.category, last_synced = now()`,
          [r.id, r.name, r.quantity, r.available, r.loaned, r.loaned_to ? JSON.stringify(r.loaned_to) : null, r.api_type, r.category]
        )
      }
      await client.query(
        `INSERT INTO sync_metadata (data_type, last_sync, synced_by) VALUES ('inventory', now(), $1)`,
        [by.name ?? by.id]
      )
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
    return { items_synced: rows.length }
  })

  // Tier override: the one members-table field leadership edits by hand.
  app.put('/api/members/:id/tier-override', WRITE, async (req, reply) => {
    const { id } = req.params as { id: string }
    const value = (req.body as { tier_override?: unknown } | null)?.tier_override
    if (value !== null && !Number.isInteger(value)) {
      return reply.status(400).send({ error: 'tier_override must be an integer or null' })
    }
    const res = await db.query(
      `UPDATE members SET tier_override = $1, updated_at = now()
       WHERE member_id = $2 RETURNING member_id, member_name, tier, tier_override`,
      [value, id]
    )
    if (res.rows.length === 0) return reply.status(404).send({ error: 'Member not found' })
    return { member: res.rows[0] }
  })
}
