// In-process war-room ticker (slice #71) — replaces the 1 Hz pg_cron →
// pg_net → edge-function tick. Gated hard: a tick does NOTHING (not even a
// Torn call) unless war_room_config_v2.enabled is true AND the managed war
// is inside its active window. Each live tick: claim a pooled key, fetch
// enemy + our member states, diff against war_room_state_v2, persist only
// what changed (tombstoning members who left the roster), and broadcast the
// changed rows through the WebSocket hub.
import type pg from 'pg'
import { createTornClient } from './scraper/tornClient.js'
import type { createKeyPool } from './scraper/keyPool.js'
import type { WarRoomHub } from './warRoom.js'

export interface WarRoomTickerDeps {
  db: pg.Pool
  pool: ReturnType<typeof createKeyPool>
  hub: WarRoomHub
  tornBaseUrl: string
  intervalMs?: number
}

function memberState(m: any) {
  return {
    last_action: m.last_action ?? null,
    status: m.status ?? null,
    is_revivable: m.is_revivable ?? false,
    has_early_discharge: m.has_early_discharge ?? false,
    is_in_oc: m.is_in_oc ?? false,
    is_on_wall: m.is_on_wall ?? false,
    revive_setting: m.revive_setting ?? null,
  }
}

export function createWarRoomTicker(deps: WarRoomTickerDeps) {
  const { db, pool, hub, tornBaseUrl } = deps
  // The ticker's own client: budget sized for 1 Hz member fetches.
  const client = createTornClient({ baseUrl: tornBaseUrl, budget: { requests: 80, perMs: 60_000 } })
  let timer: NodeJS.Timeout | null = null
  let ticking = false

  async function warWindowActive(managedWarId: number | null): Promise<boolean> {
    if (managedWarId == null) return true
    const res = await db.query('SELECT start_at, end_at FROM ranked_wars WHERE id = $1', [managedWarId])
    if (res.rows.length === 0) return false
    const now = Math.floor(Date.now() / 1000)
    const { start_at, end_at } = res.rows[0]
    return Number(start_at) <= now && (end_at == null || Number(end_at) === 0 || Number(end_at) > now)
  }

  async function tick(): Promise<void> {
    if (ticking) return
    ticking = true
    try {
      const config = await db.query('SELECT * FROM war_room_config_v2 WHERE id = 1')
      const cfg = config.rows[0]
      if (!cfg?.enabled || !cfg.faction_id) return
      if (!(await warWindowActive(cfg.managed_war_id))) return

      const claimed = await pool.claim()
      if (!claimed) return

      const us = await db.query('SELECT torn_faction_id FROM faction_config LIMIT 1')
      const ourId = Number(us.rows[0].torn_faction_id)
      const enemyId = Number(cfg.faction_id)

      const [enemy, ours] = await Promise.all([
        client.fetch(`/v2/faction/${enemyId}/members?striptags=true`, claimed.key),
        client.fetch(`/v2/faction/${ourId}/members?striptags=true`, claimed.key),
      ])

      const fresh = new Map<number, { faction_id: number; m: any }>()
      for (const m of enemy.members ?? []) fresh.set(Number(m.id), { faction_id: enemyId, m })
      for (const m of ours.members ?? []) fresh.set(Number(m.id), { faction_id: ourId, m })

      // Diff in SQL: jsonb equality there is semantic (key order doesn't
      // matter), so the conditional upsert only touches — and only RETURNs —
      // rows that genuinely changed.
      const changed: any[] = []
      for (const [memberId, { faction_id, m }] of fresh) {
        const state = memberState(m)
        const res = await db.query(
          `INSERT INTO war_room_state_v2 (member_id, faction_id, member_name, level, "position", state, deleted_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, NULL, now())
           ON CONFLICT (member_id) DO UPDATE SET
             faction_id = EXCLUDED.faction_id, member_name = EXCLUDED.member_name,
             level = EXCLUDED.level, "position" = EXCLUDED.position,
             state = EXCLUDED.state, deleted_at = NULL, updated_at = now()
           WHERE war_room_state_v2.state IS DISTINCT FROM EXCLUDED.state
              OR war_room_state_v2.member_name IS DISTINCT FROM EXCLUDED.member_name
              OR war_room_state_v2.level IS DISTINCT FROM EXCLUDED.level
              OR war_room_state_v2.faction_id IS DISTINCT FROM EXCLUDED.faction_id
              OR war_room_state_v2.deleted_at IS NOT NULL
           RETURNING *`,
          [memberId, faction_id, m.name, m.level ?? null, m.position ?? null, JSON.stringify(state)]
        )
        if (res.rows.length > 0) changed.push(res.rows[0])
      }

      // Members that vanished from their roster become tombstones (the same
      // delete signal the polling RPCs carried).
      const gone = await db.query(
        `UPDATE war_room_state_v2 SET deleted_at = now(), updated_at = now()
         WHERE faction_id = ANY($1) AND deleted_at IS NULL AND NOT (member_id = ANY($2))
         RETURNING *`,
        [[enemyId, ourId], [...fresh.keys()]]
      )
      changed.push(...gone.rows)

      if (changed.length > 0) {
        const now = await db.query('SELECT now() AS server_now')
        hub.broadcast('state', changed, now.rows[0].server_now)
      }
    } finally {
      ticking = false
    }
  }

  return {
    tick,
    start() {
      if (timer) return
      timer = setInterval(() => { void tick().catch(() => {}) }, deps.intervalMs ?? 1000)
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}
