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
import type { PushService } from './push.js'
import { createSurgeDetector, type SurgeConfig, type SurgeEvent } from './warRoomSurge.js'
import { snapshotDibbedStatus, sweepDibsExpiry, DIBS_EXPIRY_SECONDS } from './warRoomDibsExpiry.js'
import { storeOurChain, storeEnemyChain, chainPollDue, chainNearExpiry, CHAIN_FORCE_POLL_SEC } from './warRoomChain.js'
import { memberStatsPollDue, sweepMemberStats, pruneMemberStats } from './warRoomMemberStats.js'

export interface WarRoomTickerDeps {
  db: pg.Pool
  pool: ReturnType<typeof createKeyPool>
  hub: WarRoomHub
  tornBaseUrl: string
  intervalMs?: number
  /** #106 auto-release window: seconds after a target leaves hospital. */
  dibsExpirySeconds?: number
  /** Web Push service (#207) for surge fan-out (#208); optional. */
  pushService?: PushService
}

// Map the war_room_config_v2 surge columns to the detector's config shape.
function surgeConfigFrom(cfg: Record<string, unknown>): SurgeConfig {
  return {
    enabled: !!cfg.surge_alerts_enabled,
    enemy: { threshold: Number(cfg.surge_enemy_threshold ?? 3), windowSec: Number(cfg.surge_enemy_window_sec ?? 60) },
    our: { threshold: Number(cfg.surge_our_threshold ?? 4), windowSec: Number(cfg.surge_our_window_sec ?? 60) },
    cooldownSec: Number(cfg.surge_cooldown_sec ?? 300),
  }
}

// User-facing copy for each surge direction: enemy = we're being pushed
// (defensive), our = organize a push (offensive).
function surgeMessage(ev: SurgeEvent): { title: string; body: string } {
  return ev.direction === 'enemy'
    ? { title: '🛡️ Incoming push!', body: `${ev.count} enemies just left hospital — defend / turtle up.` }
    : { title: '⚔️ Push window!', body: `${ev.count} of ours are out — organize a push.` }
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

/**
 * Fetch both factions' member states and merge them into war_room_state_v2,
 * diffing in SQL (jsonb equality is semantic — only genuine changes persist
 * and return). Shared by the 1 Hz ticker and the lifecycle's baseline fetch.
 * Returns the changed rows (including tombstones for roster leavers).
 */
export async function syncWarRoomMemberStates(
  db: pg.Pool,
  client: { fetch(path: string, key: string): Promise<any> },
  key: string,
  enemyId: number,
  ourId: number
): Promise<any[]> {
  const [enemy, ours] = await Promise.all([
    client.fetch(`/v2/faction/${enemyId}/members?striptags=true`, key),
    client.fetch(`/v2/faction/${ourId}/members?striptags=true`, key),
  ])

  const fresh = new Map<number, { faction_id: number; m: any }>()
  for (const m of enemy.members ?? []) fresh.set(Number(m.id), { faction_id: enemyId, m })
  for (const m of ours.members ?? []) fresh.set(Number(m.id), { faction_id: ourId, m })

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
  return changed
}

export function createWarRoomTicker(deps: WarRoomTickerDeps) {
  const { db, pool, hub, tornBaseUrl } = deps
  // The ticker's own client: budget sized for 1 Hz member fetches.
  const client = createTornClient({ baseUrl: tornBaseUrl, budget: { requests: 80, perMs: 60_000 } })
  // One detector for the process lifetime — it tracks per-member state and the
  // rolling recovery windows across ticks (the single source of truth, #208).
  const surge = createSurgeDetector()
  let timer: NodeJS.Timeout | null = null
  let ticking = false
  // The member-stats sweep (#336) walks the whole roster, so it runs DETACHED
  // from the tick body with its own in-flight guard. Awaiting it inline would
  // stall the 1 Hz state sync for the length of the sweep — the board would
  // visibly freeze every cycle.
  let sweepingMemberStats = false

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
      // The war window gates AUTOMATION-owned sessions only: a manual Save
      // (auto_managed=false) may carry a stale managed_war_id from whatever
      // the lifecycle ran last, and must keep polling regardless.
      if (cfg.auto_managed && !(await warWindowActive(cfg.managed_war_id))) return

      const claimed = await pool.claim()
      if (!claimed) return

      const us = await db.query('SELECT torn_faction_id FROM faction_config LIMIT 1')
      const ourId = Number(us.rows[0].torn_faction_id)
      const enemyId = Number(cfg.faction_id)

      // Snapshot dibbed targets' hospital status BEFORE the sync overwrites it —
      // the auto-expiry sweep diffs old vs new (see warRoomDibsExpiry).
      const prevDibStatus = await snapshotDibbedStatus(db)
      const changed = await syncWarRoomMemberStates(db, client, claimed.key, enemyId, ourId)
      const expiredDibs = await sweepDibsExpiry(
        db, prevDibStatus,
        // Live-editable in the war-room settings (#159); the static dep is a
        // test/override fallback.
        Number(cfg.dibs_expiry_seconds ?? deps.dibsExpirySeconds ?? DIBS_EXPIRY_SECONDS)
      )

      if (changed.length > 0 || expiredDibs.length > 0) {
        const now = await db.query('SELECT now() AS server_now')
        if (changed.length > 0) hub.broadcast('state', changed, now.rows[0].server_now)
        if (expiredDibs.length > 0) hub.broadcast('dibs', expiredDibs, now.rows[0].server_now)
      }

      // PUSH-surge detection + fan-out (#208). observe() is a no-op when the
      // toggle is off. We only act on ENEMY-side surges ("we're being pushed") —
      // the our-side / offensive direction is intentionally not alerted.
      const surges = surge
        .observe(changed, { enemyId, ourId, config: surgeConfigFrom(cfg), nowMs: Date.now() })
        .filter((ev) => ev.direction === 'enemy')
      for (const ev of surges) {
        const msg = surgeMessage(ev)
        // Open tabs: sound/flash automatically for everyone (reuses #156/#157).
        hub.alert({ kind: 'surge', direction: ev.direction, count: ev.count, ...msg })
        // Subscribers: a background web-push, even with the tab closed.
        void deps.pushService?.sendToAll({ ...msg, url: '/war-room', tag: `surge-${ev.direction}` }).catch(() => {})
      }

      // Live chain watch: poll our + enemy chains at their configured cadences
      // (or force a poll when our chain is within seconds of dropping), convert
      // Torn's relative timers to absolute, and broadcast the refreshed row.
      await pollChains(cfg, claimed.key, ourId, enemyId)

      // Live energy + cooldowns for our own members (#336). Fire-and-forget:
      // see sweepingMemberStats. Off by default (cadence 0).
      void sweepMemberStatsIfDue(cfg).catch(() => {})
    } finally {
      ticking = false
    }
  }

  /**
   * Cadence-gated sweep of our own members' energy/cooldowns (#336).
   *
   * Unlike everything else in the tick this does NOT use the pooled key: Torn
   * exposes bars/cooldowns as self-only selections, so each member's row costs
   * one call made with that member's own key. The shared `client` is safe to
   * reuse because its rate limiter is per-key — each member's key sees at most
   * two calls a minute at the 30s floor.
   */
  async function sweepMemberStatsIfDue(cfg: any): Promise<void> {
    if (sweepingMemberStats) return
    // Claim the guard BEFORE the first await: two ticks a second apart would
    // otherwise both pass the check and double-sweep the roster.
    sweepingMemberStats = true
    try {
      const interval = Number(cfg.member_stats_poll_interval_sec ?? 0)
      if (interval <= 0) return
      const mark = await db.query(
        'SELECT extract(epoch from max(fetched_at)) AS last FROM war_room_member_stats_v2'
      )
      if (!memberStatsPollDue(mark.rows[0]?.last, interval, Date.now())) return

      const keys = await pool.listKeys()
      if (keys.length === 0) return
      const changed = await sweepMemberStats(db, client, keys)
      // Drop rows for members who are no longer enrolled, so a departed member's
      // last-known energy can't linger on the board.
      await pruneMemberStats(db, keys.map((k) => k.member_id))

      if (changed.length > 0) {
        const sn = await db.query('SELECT now() AS server_now')
        // 'memberstats' is a LEAD-ONLY channel — the hub withholds it from
        // ordinary members' sockets (see LEAD_ONLY_CHANNELS in warRoom.ts).
        hub.broadcast('memberstats', changed, sn.rows[0].server_now)
      }
    } finally {
      sweepingMemberStats = false
    }
  }

  // Cadence-gated chain polling, sharing the tick's claimed key. Our-side and
  // enemy-side each have their own interval; our side also force-polls near
  // expiry. One broadcast carries the full (both-sides) singleton row.
  async function pollChains(cfg: any, key: string, ourId: number, enemyId: number): Promise<void> {
    const nowMs = Date.now()
    const nowEpoch = Math.floor(nowMs / 1000)
    const cur = await db.query(
      `SELECT timeout,
              extract(epoch from our_last_fetched_at)   AS our_fetched,
              extract(epoch from enemy_last_fetched_at) AS enemy_fetched
       FROM war_room_chain_v2 WHERE id = 1`
    )
    const row = cur.rows[0]
    const ourInterval = Number(cfg.chain_poll_interval_ours_sec ?? 5)
    const enemyInterval = Number(cfg.chain_poll_interval_enemy_sec ?? 30)
    const forceOurs = chainNearExpiry(row?.timeout != null ? Number(row.timeout) : null, nowEpoch, CHAIN_FORCE_POLL_SEC)

    let latest: any = null
    if (forceOurs || chainPollDue(row?.our_fetched, ourInterval, nowMs)) {
      try {
        const data = await client.fetch(`/v2/faction/${ourId}/chain`, key)
        latest = await storeOurChain(db, data.chain, nowEpoch)
      } catch { /* transient — the next cadence retries */ }
    }
    if (enemyId && chainPollDue(row?.enemy_fetched, enemyInterval, nowMs)) {
      try {
        const data = await client.fetch(`/v2/faction/${enemyId}/chain`, key)
        latest = await storeEnemyChain(db, data.chain, nowEpoch)
      } catch { /* enemy chain is best-effort */ }
    }
    if (latest) {
      const sn = await db.query('SELECT now() AS server_now')
      hub.broadcast('chain', [latest], sn.rows[0].server_now)
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
