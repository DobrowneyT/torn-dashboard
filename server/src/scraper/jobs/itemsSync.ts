// Items catalog sync — port of scripts/items_update.py, now with a fleet fast
// path (#609 slice 7).
//
// Two sources, and the ORDER is the whole design:
//
//   1. the shared `global` catalogue, if the control plane has refreshed it
//      recently — zero Torn calls, one fetch for the whole fleet
//   2. this faction's own key pool, exactly as before
//
// ⚠️ **The fallback is not a nicety, it is the thing that makes centralising
// safe.** Moving this job to one key trades five-fold redundancy for a single
// point of failure whose failure mode is SILENT: prices quietly stop updating
// and every faction keeps valuing payouts off a stale table. That is precisely
// the decay that ran unnoticed for months in July (#123/#124). #609 requires
// both mitigations together — refuse stale prices, AND keep the tenant able to
// feed itself — because either alone leaves a hole.
//
// ⚠️ The tenant's OWN `items` table stays the read path. Nothing queries
// `global.items` at request time, deliberately: that would put the control
// plane in every tenant's read path and break the one guarantee the whole
// architecture is built on — kill the admin container and every tenant keeps
// working on its last-consumed data.
import type pg from 'pg'
import { readFleetMeta, itemsAreFresh } from '../../globalDb.js'
import type { createKeyPool } from '../keyPool.js'
import type { createTornClient } from '../tornClient.js'
import type { RunResult } from '../runLog.js'

export interface JobDeps {
  db: pg.Pool
  pool: ReturnType<typeof createKeyPool>
  client: ReturnType<typeof createTornClient>
  /** KEY_ENCRYPTION_KEY, when configured (#309). Jobs that maintain the key
   *  pool itself skip that work when it's absent, like the other pool ops. */
  encryptionKey?: string
  /** Read-only pool on the shared `global` database (#609). Optional on
   *  purpose — absent means this job behaves exactly as it did before. */
  globalDb?: pg.Pool
  /** Spy-stat provider config (#139) — lets war-lifecycle auto-fetch spies
   *  on the weekly setup. Optional: absent ⇒ the spy step no-ops. */
  spy?: {
    encryptionKey?: string
    tornStatsApiKey?: string
    bspApiKey?: string
    tornStatsBaseUrl?: string
    bspBaseUrl?: string
  }
}

/**
 * Copy the fleet catalogue into this faction's table.
 *
 * ⚠️ A plain upsert with no delete. An item that vanished from the fleet copy
 * — because a sync was partial, or Torn dropped it — must not vanish from a
 * faction's prices too: a name the catalogue cannot price is already reported
 * as `item_value_unmatched` (#441), so a missing row degrades to "unpriced"
 * rather than to "worth zero", and keeping the old row is strictly better than
 * either.
 */
async function adoptFleetCatalogue(db: pg.Pool, globalDb: pg.Pool): Promise<number> {
  const res = await globalDb.query(
    `SELECT id, name, description, effect, type, sub_type, market_price, sell_price,
            buy_price, circulation, is_tradable, image_url
       FROM items`
  )
  let rows = 0
  for (const it of res.rows) {
    await db.query(
      `INSERT INTO items (id, name, description, effect, type, sub_type, market_price,
                          sell_price, buy_price, circulation, is_tradable, image_url, last_updated)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, description = EXCLUDED.description, effect = EXCLUDED.effect,
         type = EXCLUDED.type, sub_type = EXCLUDED.sub_type, market_price = EXCLUDED.market_price,
         sell_price = EXCLUDED.sell_price, buy_price = EXCLUDED.buy_price,
         circulation = EXCLUDED.circulation, is_tradable = EXCLUDED.is_tradable,
         image_url = EXCLUDED.image_url, last_updated = now()`,
      [it.id, it.name ?? `Item ${it.id}`, it.description, it.effect, it.type, it.sub_type,
       it.market_price ?? 0, it.sell_price ?? 0, it.buy_price ?? 0,
       it.circulation, it.is_tradable, it.image_url]
    )
    rows += 1
  }
  return rows
}

export async function itemsSyncJob({ db, pool, client, globalDb }: JobDeps): Promise<RunResult> {
  // ⚠️ Every failure here falls THROUGH to the pool rather than up to the run
  // logger. The control plane is an optimisation; a tenant that cannot reach it
  // must sync exactly as it did before this existed, and the run should record
  // that it did so rather than record a failure the faction cannot act on.
  if (globalDb) {
    const fleet = await readFleetMeta(globalDb)
    if (fleet === null) {
      // readFleetMeta never throws — null is "control plane unavailable".
    } else if (!itemsAreFresh(fleet)) {
      console.warn(
        `[items-sync] fleet prices stale (synced ${fleet.itemsSyncedAt ?? 'never'}) — using this faction's key pool`
      )
    } else {
      try {
        const rows = await adoptFleetCatalogue(db, globalDb)
        return { rows, details: { source: 'fleet', synced_at: fleet.itemsSyncedAt } }
      } catch (err) {
        console.warn(
          `[items-sync] could not adopt the fleet catalogue, falling back to the key pool: ` +
          `${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
  }

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
  return { rows, details: { source: 'pool', used_member: claimed.member_id } }
}
