// Leadership tools: member-overview saved views/thresholds, tier overrides,
// and inventory management. Purpose-built endpoints replace the old generic
// arbitrary-table CRUD; visitors read everything, write nothing.
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { requireNotVisitor, requireRole } from './authz.js'

export interface LeadershipDeps {
  db: pg.Pool
  tornBaseUrl: string
  /** Faction-held Torn key for server-side syncs (until slice #67's pool). */
  tornApiKey?: string
}

const READ = { preHandler: requireRole('leadership', 'admin', 'visitor') }
const WRITE = { preHandler: [requireNotVisitor(), requireRole('leadership', 'admin')] }

// The Torn v1 faction-inventory selections the legacy sync pulled.
const INVENTORY_CATEGORIES = ['temporary', 'medical', 'utilities', 'drugs', 'armor', 'weapons', 'caches', 'cesium']

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

  // The overview grid's input: every member's snapshots since a date, in one
  // response (no client paging against a row cap).
  app.get('/api/overview/daily-stats', READ, async (req, reply) => {
    const since = (req.query as { since?: string }).since
    if (!since || !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
      return reply.status(400).send({ error: 'since (YYYY-MM-DD) is required' })
    }
    const res = await db.query(
      `SELECT member_id, snapshot_date, personalstats, profile, is_donator, property_name,
              last_action_timestamp, gym_strength, gym_speed, gym_dexterity, gym_defense, gym_energy
       FROM member_daily_stats WHERE snapshot_date >= $1
       ORDER BY member_id ASC, snapshot_date DESC`,
      [since]
    )
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

  // Pull the faction inventory from Torn with the server-held key and
  // replace the stored quantities (same shape the legacy browser sync wrote).
  app.post('/api/inventory/sync', WRITE, async (req, reply) => {
    if (!deps.tornApiKey) {
      return reply.status(503).send({ error: 'Server Torn API key not configured' })
    }
    const config = await db.query('SELECT torn_faction_id FROM faction_config LIMIT 1')
    const factionId = config.rows[0].torn_faction_id
    const url = `${deps.tornBaseUrl}/faction/${factionId}?selections=${INVENTORY_CATEGORIES.join(',')}&key=${deps.tornApiKey}&comment=TNL-Inventory-Sync`
    const res = await fetch(url)
    const data = (await res.json()) as Record<string, any>
    if (data.error) {
      return reply.status(502).send({ error: `Torn API: ${data.error.error}` })
    }

    const rows: Record<string, unknown>[] = []
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
          [r.id, r.name, r.quantity, r.available, r.loaned, r.loaned_to, r.api_type, r.category]
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
