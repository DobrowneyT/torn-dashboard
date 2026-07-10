// Manual war-room setup — the endpoints behind the leader's "Save & Fetch"
// flow (formerly the set_config_v2 / clear_state_v2 / fetch_members_v2 /
// fetch_chains_v2 edge actions). Same guard as war notes: warlead/
// leadership/admin, never visitors. The lifecycle job reuses
// clearWarRoomState so manual and automated setups behave identically.
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { requireNotVisitor, requireRole } from './authz.js'
import { createKeyPool } from './scraper/keyPool.js'
import { createTornClient } from './scraper/tornClient.js'
import { syncWarRoomMemberStates } from './warRoomTicker.js'
import type { WarRoomHub } from './warRoom.js'

export interface WarRoomSetupDeps {
  db: pg.Pool
  hub: WarRoomHub
  tornBaseUrl: string
  encryptionKey?: string
}

// Fields the leader panel may set on the config singleton — everything else
// (started_by, timestamps) is server-owned.
const CONFIG_COLUMNS = new Set([
  'enabled', 'faction_id', 'faction_name', 'auto_managed', 'managed_war_id',
  'revive_service_name', 'revive_service_url', 'revive_services',
  'tornstats_max_age_days', 'chain_poll_interval_ours_sec', 'chain_poll_interval_enemy_sec',
])

/**
 * Fresh slate: tombstone all live state + dibs rows and reset the chain
 * singleton (a new matchup must not inherit the prior chain's value, save
 * claim, or fetch watermarks). Returns the changed rows per channel so the
 * caller can broadcast them.
 */
export async function clearWarRoomState(db: pg.Pool) {
  const state = await db.query(
    'UPDATE war_room_state_v2 SET deleted_at = now(), updated_at = now() WHERE deleted_at IS NULL RETURNING *'
  )
  const dibs = await db.query(
    'UPDATE war_room_dibs_v2 SET deleted_at = now(), updated_at = now() WHERE deleted_at IS NULL RETURNING *'
  )
  const chain = await db.query(
    `UPDATE war_room_chain_v2 SET current = NULL, max = NULL, modifier = NULL,
       timeout = NULL, start_ts = NULL, cooldown = NULL, end_ts = NULL,
       save_claimed_by = NULL, save_claimed_name = NULL, save_claimed_at = NULL,
       enemy = NULL, our_last_fetched_at = NULL, enemy_last_fetched_at = NULL,
       updated_at = now()
     WHERE id = 1 RETURNING *`
  )
  return { state: state.rows, dibs: dibs.rows, chain: chain.rows }
}

const GUARD = { preHandler: [requireNotVisitor(), requireRole('warlead', 'leadership', 'admin')] }

export function registerWarRoomSetupRoutes(app: FastifyInstance, deps: WarRoomSetupDeps) {
  const { db, hub } = deps

  async function now(): Promise<string> {
    const res = await db.query('SELECT now() AS n')
    return res.rows[0].n
  }

  function jobDeps() {
    return {
      pool: createKeyPool({ db, encryptionKey: deps.encryptionKey! }),
      client: createTornClient({ baseUrl: deps.tornBaseUrl, budget: { requests: 60, perMs: 60_000 } }),
    }
  }

  function guardConfigured(reply: any): boolean {
    if (!deps.encryptionKey) {
      reply.status(503).send({ error: 'Key pool not configured (KEY_ENCRYPTION_KEY)' })
      return false
    }
    return true
  }

  app.put('/api/war-room/config', GUARD, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const updates = Object.entries(body).filter(([k]) => CONFIG_COLUMNS.has(k))
    if (updates.length === 0) return reply.status(400).send({ error: 'no config fields provided' })

    const sets = updates.map(([k], i) => `"${k}" = $${i + 1}`).join(', ')
    const res = await db.query(
      `INSERT INTO war_room_config_v2 (id) VALUES (1) ON CONFLICT (id) DO NOTHING`
    )
    void res
    const updated = await db.query(
      `UPDATE war_room_config_v2 SET ${sets}, updated_at = now() WHERE id = 1 RETURNING *`,
      updates.map(([, v]) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v))
    )
    hub.broadcast('config', updated.rows, await now())
    return { config: updated.rows[0] }
  })

  app.post('/api/war-room/clear-state', GUARD, async () => {
    const cleared = await clearWarRoomState(db)
    const ts = await now()
    hub.broadcast('state', cleared.state, ts)
    hub.broadcast('dibs', cleared.dibs, ts)
    hub.broadcast('chain', cleared.chain, ts)
    return { ok: true }
  })

  // Baseline both factions' member states (enemy passed, ours from config)
  // with a pooled key; refreshes the cached enemy faction name.
  app.post('/api/war-room/fetch-members', GUARD, async (req, reply) => {
    if (!guardConfigured(reply)) return
    const factionId = Number((req.body as { faction_id?: unknown } | null)?.faction_id)
    if (!Number.isFinite(factionId) || factionId <= 0) {
      return reply.status(400).send({ error: 'faction_id required' })
    }
    const { pool, client } = jobDeps()
    const claimed = await pool.claim()
    if (!claimed) return reply.status(503).send({ error: 'no pooled key available' })

    const us = await db.query('SELECT torn_faction_id FROM faction_config LIMIT 1')
    const ourId = Number(us.rows[0].torn_faction_id)

    const changed = await syncWarRoomMemberStates(db, client, claimed.key, factionId, ourId)
    if (changed.length > 0) hub.broadcast('state', changed, await now())

    // Cache the enemy's display name on the config row.
    let factionName: string | null = null
    try {
      const basic = await client.fetch(`/v2/faction/${factionId}/basic`, claimed.key)
      factionName = basic.basic?.name ?? null
      if (factionName) {
        const cfg = await db.query(
          `UPDATE war_room_config_v2 SET faction_name = $1, updated_at = now() WHERE id = 1 RETURNING *`,
          [factionName]
        )
        hub.broadcast('config', cfg.rows, await now())
      }
    } catch {
      // Name enrichment is best-effort.
    }
    return { ok: true, faction_name: factionName, members_synced: changed.length }
  })

  // One-shot seed of both chains so the timer card is warm before enable.
  app.post('/api/war-room/fetch-chains', GUARD, async (req, reply) => {
    if (!guardConfigured(reply)) return
    const enemyId = Number((req.body as { enemy_faction_id?: unknown } | null)?.enemy_faction_id)
    if (!Number.isFinite(enemyId) || enemyId <= 0) {
      return reply.status(400).send({ error: 'enemy_faction_id required' })
    }
    const { pool, client } = jobDeps()
    const claimed = await pool.claim()
    if (!claimed) return reply.status(503).send({ error: 'no pooled key available' })

    const us = await db.query('SELECT torn_faction_id FROM faction_config LIMIT 1')
    const ourId = Number(us.rows[0].torn_faction_id)

    const [ours, enemy] = await Promise.all([
      client.fetch(`/v2/faction/${ourId}/chain`, claimed.key),
      client.fetch(`/v2/faction/${enemyId}/chain`, claimed.key).catch(() => null),
    ])
    const oc = ours.chain ?? {}
    const res = await db.query(
      `INSERT INTO war_room_chain_v2 (id, current, max, modifier, timeout, start_ts, cooldown, end_ts,
         enemy, our_last_fetched_at, enemy_last_fetched_at, updated_at)
       VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, now(), $9, now())
       ON CONFLICT (id) DO UPDATE SET
         current = EXCLUDED.current, max = EXCLUDED.max, modifier = EXCLUDED.modifier,
         timeout = EXCLUDED.timeout, start_ts = EXCLUDED.start_ts, cooldown = EXCLUDED.cooldown,
         end_ts = EXCLUDED.end_ts, enemy = EXCLUDED.enemy,
         our_last_fetched_at = now(),
         enemy_last_fetched_at = COALESCE(EXCLUDED.enemy_last_fetched_at, war_room_chain_v2.enemy_last_fetched_at),
         updated_at = now()
       RETURNING *`,
      [oc.current ?? null, oc.max ?? null, oc.modifier ?? null, oc.timeout ?? null,
       oc.start ?? null, oc.cooldown ?? null, oc.end ?? null,
       enemy?.chain ? JSON.stringify(enemy.chain) : null,
       enemy?.chain ? new Date().toISOString() : null]
    )
    void res
    const fresh = await db.query('SELECT * FROM war_room_chain_v2 WHERE id = 1')
    hub.broadcast('chain', fresh.rows, await now())
    return { ok: true }
  })
}
