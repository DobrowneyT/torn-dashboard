// Items catalog sync — port of scripts/items_update.py. Fetches the full
// Torn items catalog with any pooled key and upserts the `items` table so
// payout enrichment sees fresh market/sell prices.
import type pg from 'pg'
import type { createKeyPool } from '../keyPool.js'
import type { createTornClient } from '../tornClient.js'
import type { RunResult } from '../runLog.js'

export interface JobDeps {
  db: pg.Pool
  pool: ReturnType<typeof createKeyPool>
  client: ReturnType<typeof createTornClient>
}

export async function itemsSyncJob({ db, pool, client }: JobDeps): Promise<RunResult> {
  const claimed = await pool.claim()
  if (!claimed) throw new Error('no pooled key available')

  const data = await client.fetch('/v2/torn/items?cat=All&sort=ASC', claimed.key)
  const items: any[] = data.items ?? []

  let rows = 0
  for (const it of items) {
    if (it.id == null) continue
    const value = it.value ?? {}
    await db.query(
      `INSERT INTO items (id, name, description, effect, type, sub_type, market_price,
                          sell_price, buy_price, circulation, is_tradable, image_url, last_updated)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, description = EXCLUDED.description, effect = EXCLUDED.effect,
         type = EXCLUDED.type, sub_type = EXCLUDED.sub_type, market_price = EXCLUDED.market_price,
         sell_price = EXCLUDED.sell_price, buy_price = EXCLUDED.buy_price,
         circulation = EXCLUDED.circulation, is_tradable = EXCLUDED.is_tradable,
         image_url = EXCLUDED.image_url, last_updated = now()`,
      [it.id, it.name ?? `Item ${it.id}`, it.description ?? null, it.effect ?? null,
       it.type ?? null, it.sub_type ?? null, value.market_price ?? 0, value.sell_price ?? 0,
       value.buy_price ?? 0, it.circulation ?? null, it.is_tradable ?? null, it.image ?? null]
    )
    rows += 1
  }
  return { rows }
}
