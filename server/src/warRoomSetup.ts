// Manual war-room setup — the endpoints behind the leader's "Save & Fetch"
// flow (formerly the set_config_v2 / clear_state_v2 / fetch_members_v2 /
// fetch_chains_v2 edge actions). Same guard as war notes: warlead/
// leadership/admin. The lifecycle job reuses
// clearWarRoomState so manual and automated setups behave identically.
import type { FastifyInstance } from 'fastify'
import { DIBS_RELEASE_REASONS } from './warDibsReasons.js'
import type pg from 'pg'
import { requireRole } from './authz.js'
import { createKeyPool } from './scraper/keyPool.js'
import { createTornClient } from './scraper/tornClient.js'
import { resolveSpyProviders, fetchSpiesForMembers } from './spyFetch.js'
import { syncWarRoomMemberStates } from './warRoomTicker.js'
import { storeOurChain, storeEnemyChain } from './warRoomChain.js'
import { clampConfigValue } from './warRoomConfigBounds.js'
import type { WarRoomHub } from './warRoom.js'

export interface WarRoomSetupDeps {
  db: pg.Pool
  hub: WarRoomHub
  tornBaseUrl: string
  encryptionKey?: string
  /** Spy-stat providers (#100). Keys are operator-level (shared services);
   *  base URLs are injectable for the test fixture. */
  tornStatsApiKey?: string
  bspApiKey?: string
  tornStatsBaseUrl?: string
  bspBaseUrl?: string
}

// Fields the leader panel may set on the config singleton — everything else
// (started_by, timestamps) is server-owned.
const CONFIG_COLUMNS = new Set([
  'enabled', 'faction_id', 'faction_name', 'auto_managed', 'managed_war_id',
  'revive_service_name', 'revive_service_url', 'revive_services',
  'tornstats_max_age_days', 'chain_poll_interval_ours_sec', 'chain_poll_interval_enemy_sec',
  'dibs_expiry_seconds',
  'assist_expiry_seconds',
  // PUSH-surge alerts (#208): global on/off + per-direction rate + cooldown.
  'surge_alerts_enabled',
  'surge_enemy_threshold', 'surge_enemy_window_sec',
  'surge_our_threshold', 'surge_our_window_sec',
  'surge_cooldown_sec',
  // Revive-surge alerts (#359): the same shape again, tracked separately
  // because revive prep and hospital churn happen at very different rates.
  'surge_revive_alerts_enabled',
  'surge_revive_enemy_threshold', 'surge_revive_enemy_window_sec',
  'surge_revive_our_threshold', 'surge_revive_our_window_sec',
  'surge_revive_cooldown_sec',
  // Live member energy/cooldown sweep (#336). 0 = off; see CONFIG_BOUNDS.
  'member_stats_poll_interval_sec',
  // Roster refresh cadence in ms (#339). Floored at 500ms = 2 Hz.
  'roster_poll_interval_ms',
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
    // ⚠️ #530 — `reset` is BLAMELESS. The board being wiped at war setup is not
    // a holder failing to convert, and a report that counts it as one would
    // penalise whoever happened to be holding a claim when a lead hit setup.
    `UPDATE war_room_dibs_v2 SET deleted_at = now(), updated_at = now(),
       release_reason = '${DIBS_RELEASE_REASONS.reset}'
     WHERE deleted_at IS NULL RETURNING *`
  )
  // #523: a new matchup must not inherit the prior war's raised hands either.
  const assist = await db.query(
    // #617: a new war starts with nothing asked for. Counts are zeroed rather
    // than rows deleted, so a client holding the old row sees it go to zero.
    `UPDATE war_room_assist_counts_v2
        SET help_wanted = 0, smoke_wanted = 0, tear_wanted = 0,
            help_raised_by = '{}', updated_at = now()
      WHERE help_wanted > 0 OR smoke_wanted > 0 OR tear_wanted > 0
      RETURNING *`
  )
  const chain = await db.query(
    `UPDATE war_room_chain_v2 SET current = NULL, max = NULL, modifier = NULL,
       timeout = NULL, start_ts = NULL, cooldown = NULL, end_ts = NULL,
       save_claimed_by = NULL, save_claimed_name = NULL, save_claimed_at = NULL,
       enemy = NULL, our_last_fetched_at = NULL, enemy_last_fetched_at = NULL,
       updated_at = now()
     WHERE id = 1 RETURNING *`
  )
  // A new matchup must not inherit the prior war's headline (#158).
  const config = await db.query(
    `UPDATE war_room_config_v2 SET headline_text = NULL, headline_tone = NULL,
       headline_set_by = NULL, headline_set_at = NULL, updated_at = now()
     WHERE id = 1 RETURNING *`
  )
  return { state: state.rows, dibs: dibs.rows, assist: assist.rows, chain: chain.rows, config: config.rows }
}

const GUARD = { preHandler: [requireRole('warlead', 'leadership', 'admin')] }

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
    const allowed = Object.entries(body).filter(([k]) => CONFIG_COLUMNS.has(k))
    if (allowed.length === 0) return reply.status(400).send({ error: 'no config fields provided' })

    // Clamp cadence fields to safe bounds (#260). The client clamps these too,
    // but that is a UX affordance: without this, a crafted request could set a
    // chain poller to 0s and the server-side poller would hammer Torn.
    const updates: Array<[string, unknown]> = []
    for (const [k, v] of allowed) {
      const clamped = clampConfigValue(k, v)
      if (!clamped.ok) return reply.status(400).send({ error: clamped.error })
      updates.push([k, clamped.value])
    }

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
    hub.broadcast('assist', cleared.assist, ts)
    hub.broadcast('chain', cleared.chain, ts)
    hub.broadcast('config', cleared.config, ts)  // headline reset (#158)
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
    // Store both sides via the shared helpers (relative→absolute conversion,
    // per-side upsert). A failed enemy fetch leaves the last good enemy value.
    const nowEpoch = Math.floor(Date.now() / 1000)
    await storeOurChain(db, ours.chain, nowEpoch)
    if (enemy?.chain) await storeEnemyChain(db, enemy.chain, nowEpoch)
    const fresh = await db.query('SELECT * FROM war_room_chain_v2 WHERE id = 1')
    hub.broadcast('chain', fresh.rows, await now())
    return { ok: true }
  })

  // Spy-stat enrichment (#100): TornStats faction spies first (they carry a
  // real capture time), BSP for anyone TornStats didn't cover. Ports the
  // fetch_bsp_v2 edge action; bsp_* columns hold whichever source's values,
  // spy_source is the provenance.
  app.post('/api/war-room/fetch-spies', GUARD, async (req, reply) => {
    const memberIds = ((req.body as { member_ids?: unknown } | null)?.member_ids as unknown[]) ?? []
    const ids = memberIds.map(Number).filter((n) => Number.isInteger(n) && n > 0)
    if (ids.length === 0) {
      return reply.status(400).send({ error: 'member_ids required' })
    }

    const providers = await resolveSpyProviders(db, deps)
    const result = await fetchSpiesForMembers({ db, memberIds: ids, providers })
    if (!result.ok) {
      if (result.reason === 'no_provider') {
        return reply.status(503).send({
          error: 'No spy provider configured — set the TornStats/BSP keys in Global Admin',
        })
      }
      return reply.status(400).send({ error: 'member_ids required' })
    }

    const fresh = await db.query('SELECT * FROM war_room_state_v2 WHERE deleted_at IS NULL')
    hub.broadcast('state', fresh.rows, await now())
    return {
      ok: true, fetched: result.fetched, tornstats: result.tornstats,
      bsp: result.bsp, requested: result.requested,
    }
  })
}
