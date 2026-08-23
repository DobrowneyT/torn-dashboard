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
import { snapshotAssistedStatus, sweepAssistsExpiry } from './warRoomAssistsExpiry.js'
import { storeOurChain, storeEnemyChain, chainPollDue, chainNearExpiry, CHAIN_FORCE_POLL_SEC } from './warRoomChain.js'
import { memberStatsPollDue, sweepMemberStats, pruneMemberStats } from './warRoomMemberStats.js'
import {
  rosterPollDue, safeRosterIntervalMs, TICKER_HEARTBEAT_MS,
} from './warRoomRosterPoll.js'

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
// Two independent kinds (#359), each with its own toggle, rates and cooldown:
// hospital churn and deliberate revive prep happen at very different rates, so
// sharing a window would force one of them to be tuned wrong.
function surgeConfigFrom(cfg: Record<string, unknown>): SurgeConfig {
  return {
    status: {
      enabled: !!cfg.surge_alerts_enabled,
      enemy: { threshold: Number(cfg.surge_enemy_threshold ?? 3), windowSec: Number(cfg.surge_enemy_window_sec ?? 60) },
      our: { threshold: Number(cfg.surge_our_threshold ?? 4), windowSec: Number(cfg.surge_our_window_sec ?? 60) },
      cooldownSec: Number(cfg.surge_cooldown_sec ?? 300),
    },
    revive: {
      enabled: !!cfg.surge_revive_alerts_enabled,
      enemy: { threshold: Number(cfg.surge_revive_enemy_threshold ?? 3), windowSec: Number(cfg.surge_revive_enemy_window_sec ?? 300) },
      our: { threshold: Number(cfg.surge_revive_our_threshold ?? 4), windowSec: Number(cfg.surge_revive_our_window_sec ?? 300) },
      cooldownSec: Number(cfg.surge_revive_cooldown_sec ?? 600),
    },
  }
}

// User-facing copy per kind and direction. The two kinds carry different
// instructions: a status surge means they are already back up and swinging,
// while a revive surge means they are being SET UP to come back — which is a
// warning to act before it lands, not a report that it has.
function surgeMessage(ev: SurgeEvent): { title: string; body: string } {
  if (ev.kind === 'revive') {
    return ev.direction === 'enemy'
      ? { title: '💉 Push incoming?', body: `${ev.count} enemies just turned revives on — they're setting up a push.` }
      : { title: '💉 Revives on', body: `${ev.count} of ours just turned revives on — we're set up to push.` }
  }
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

  // When we last swept the whole roster — read BEFORE writing anything, since
  // the #330 guard below asks "were we watching just now?" and the answer must
  // be about the previous sweep, not this one.
  const prev = await db.query(
    'SELECT last_roster_sync_at FROM war_room_config_v2 WHERE id = 1'
  )
  const lastSyncAt: string | null = prev.rows[0]?.last_roster_sync_at ?? null

  const changed: any[] = []
  for (const [memberId, { faction_id, m }] of fresh) {
    const state = memberState(m)
    const res = await db.query(
      `INSERT INTO war_room_state_v2 (member_id, faction_id, member_name, level, "position", state, deleted_at, updated_at, travel_departed_at)
       -- A member first seen ALREADY travelling gets NULL: we did not witness
       -- the departure, so we have nothing to count from (#330).
       VALUES ($1, $2, $3, $4, $5, $6, NULL, now(), NULL)
       ON CONFLICT (member_id) DO UPDATE SET
         faction_id = EXCLUDED.faction_id, member_name = EXCLUDED.member_name,
         level = EXCLUDED.level, "position" = EXCLUDED.position,
         state = EXCLUDED.state, deleted_at = NULL, updated_at = now(),
         travel_departed_at = CASE
           -- Landed, or never left: nothing to count from.
           WHEN EXCLUDED.state->'status'->>'state' <> 'Traveling' THEN NULL
           -- Took off, and the BOARD was watching closely enough to believe
           -- it. Without a freshness check the first tick after the board was
           -- off (disabled, cadence 0, restart) reads a member who departed
           -- hours ago as having just left, and produces a confidently wrong
           -- arrival time. Wrong is worse than absent — a lead waits on it.
           --
           -- The check is against the ROSTER SYNC marker, not this row's
           -- updated_at. That was the bug: a row is only written when a member
           -- CHANGES, so an offline member sitting idle stops advancing their
           -- updated_at while we poll them every second — and their eventual
           -- take-off was then discarded as unwitnessed. Which is every
           -- take-off, because "idle, then travels" is what travelling looks
           -- like from the roster's point of view.
           WHEN war_room_state_v2.state->'status'->>'state' IS DISTINCT FROM 'Traveling'
                AND $7::timestamptz IS NOT NULL
                AND $7::timestamptz > now() - interval '120 seconds'
             THEN now()
           -- Took off, but our last sweep of the roster was too long ago to
           -- trust the edge.
           WHEN war_room_state_v2.state->'status'->>'state' IS DISTINCT FROM 'Traveling'
             THEN NULL
           -- Still in the air: keep the departure we already latched.
           ELSE war_room_state_v2.travel_departed_at
         END
       WHERE war_room_state_v2.state IS DISTINCT FROM EXCLUDED.state
          OR war_room_state_v2.member_name IS DISTINCT FROM EXCLUDED.member_name
          OR war_room_state_v2.level IS DISTINCT FROM EXCLUDED.level
          OR war_room_state_v2.faction_id IS DISTINCT FROM EXCLUDED.faction_id
          OR war_room_state_v2.deleted_at IS NOT NULL
       RETURNING *`,
      [memberId, faction_id, m.name, m.level ?? null, m.position ?? null, JSON.stringify(state),
       lastSyncAt]
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

  // Mark the sweep complete. Written LAST and unconditionally: it records that
  // we looked at the whole roster, which is true whether or not anybody
  // changed — the distinction the per-member updated_at could not make.
  // Upsert, not UPDATE: the sync is also driven directly by the lifecycle
  // baseline and by tests, where the config row may not exist yet. An UPDATE
  // would silently affect zero rows and the marker would stay null forever,
  // which reads as "never watching" and suppresses every departure.
  await db.query(
    `INSERT INTO war_room_config_v2 (id, last_roster_sync_at) VALUES (1, now())
     ON CONFLICT (id) DO UPDATE SET last_roster_sync_at = now()`
  )

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
  // When the roster last synced. In-process rather than a DB column: it is
  // read and written every heartbeat, and a restart re-syncing immediately is
  // the behaviour we want anyway.
  let lastRosterSyncMs: number | null = null
  // Enrolled-key count, cached: it sets the fastest cadence the pool can
  // sustain (#342) and changes rarely, so re-counting every heartbeat would be
  // pure waste.
  let poolSize = 1
  let poolSizeAt = 0
  // Throttle for the "we overrode your setting" log, so a permanently
  // over-ambitious cadence doesn't write a line every second.
  let lastClampLogAt = 0
  let lastTickErrorLogAt = 0
  // Why the last tick did nothing, so an idle ticker can explain itself. Logged
  // only when the reason CHANGES — an idle war room is the normal state and
  // must not write a line every heartbeat (#342).
  let lastIdleReason: string | null = null

  /**
   * Report why a tick is doing nothing.
   *
   * Every one of these was previously a bare `return`. That is fine when the
   * war room is deliberately off, and awful when it is not: a board frozen
   * because its managed war ended (very common on a cloned staging database,
   * where auto_managed and managed_war_id arrive pointing at a finished war)
   * looked exactly like a board with nothing to say.
   */
  function idle(reason: string): void {
    if (lastIdleReason === reason) return
    lastIdleReason = reason
    console.log(`[war-room] ticker idle: ${reason}`)
  }

  function active(): void {
    if (lastIdleReason !== null) {
      console.log('[war-room] ticker active again')
      lastIdleReason = null
    }
  }

  async function enrolledKeyCount(): Promise<number> {
    if (Date.now() - poolSizeAt < 60_000) return poolSize
    const res = await db.query(
      `SELECT count(*)::int AS n FROM member_secrets
        WHERE disabled = false AND consent_at IS NOT NULL AND cpr_api_key IS NOT NULL
          AND has_faction_access IS NOT FALSE`
    )
    poolSize = Math.max(1, Number(res.rows[0]?.n ?? 1))
    poolSizeAt = Date.now()
    return poolSize
  }

  /**
   * One pass. `respectRosterCadence` is the automatic heartbeat's flag: it
   * paces the roster sync against roster_poll_interval_ms. A DIRECT tick()
   * call (tests, and any future "poll now") always syncs — pacing is a
   * property of the heartbeat, not of what a tick means.
   */
  async function tick({ respectRosterCadence = false } = {}): Promise<void> {
    if (ticking) return
    ticking = true
    try {
      const config = await db.query('SELECT * FROM war_room_config_v2 WHERE id = 1')
      const cfg = config.rows[0]
      // ENABLED IS THE ONLY GATE (#345). There used to be a second one: an
      // auto-managed session refused to poll outside its war's start/end
      // window. That made "enabled" mean "enabled, unless the calendar
      // disagrees" — a board could sit frozen for days while showing every
      // sign of being live, which is exactly what happened before a scheduled
      // war. Leadership decides when the room runs; the cadence settings
      // (0 = off) decide what it polls.
      if (!cfg?.enabled) return idle('war room is disabled')
      if (!cfg.faction_id) return idle('no opponent faction set')

      const claimed = await pool.claim()
      if (!claimed) return idle('no usable API key in the pool')
      active()

      const us = await db.query('SELECT torn_faction_id FROM faction_config LIMIT 1')
      const ourId = Number(us.rows[0].torn_faction_id)
      const enemyId = Number(cfg.faction_id)

      // Roster sync on its own cadence (#339). The heartbeat now runs faster
      // than the default rate so 2 Hz is reachable, which means the sync — and
      // everything derived from it — has to be gated, or lowering the setting
      // would speed the board up instead of slowing it down.
      //
      // The dibs sweep and surge detection live INSIDE this gate deliberately:
      // both diff against the states this sync produces, so running them on a
      // heartbeat with no fresh data would compare a snapshot against itself.
      // Never poll faster than the key pool can sustain (#342). A sync spends
      // two Torn calls on ONE key, so the configured cadence alone is not a
      // safety limit: 0.5s against a small pool exceeded Torn's per-key rate,
      // every sync threw, and the swallowed error froze the board silently.
      const keys = await enrolledKeyCount()
      const configured = Number(cfg.roster_poll_interval_ms ?? 0)
      const rosterInterval = safeRosterIntervalMs(configured, keys)
      if (configured > 0 && rosterInterval > configured && Date.now() - lastClampLogAt > 300_000) {
        lastClampLogAt = Date.now()
        console.warn(
          `[war-room] roster cadence held at ${rosterInterval}ms (configured ${configured}ms): ` +
          `${keys} enrolled key(s) cannot sustain it without exceeding Torn's per-key rate limit.`
        )
      }
      const rosterDue = !respectRosterCadence
        || rosterPollDue(lastRosterSyncMs, rosterInterval, Date.now())
      if (rosterDue) {
        lastRosterSyncMs = Date.now()

        // Snapshot dibbed/assisted targets' hospital status BEFORE the sync
        // overwrites it — both auto-expiry sweeps diff old vs new (see
        // warRoomDibsExpiry / warRoomAssistsExpiry).
        const prevDibStatus = await snapshotDibbedStatus(db)
        const prevAssistStatus = await snapshotAssistedStatus(db)
        const changed = await syncWarRoomMemberStates(db, client, claimed.key, enemyId, ourId)
        const expiredDibs = await sweepDibsExpiry(
          db, prevDibStatus,
          // Live-editable in the war-room settings (#159); the static dep is a
          // test/override fallback.
          Number(cfg.dibs_expiry_seconds ?? deps.dibsExpirySeconds ?? DIBS_EXPIRY_SECONDS)
        )
        // #523: assist requests have no config knob (short and fixed by
        // design) — nothing to thread through from cfg here.
        const expiredAssists = await sweepAssistsExpiry(db, prevAssistStatus)

        if (changed.length > 0 || expiredDibs.length > 0 || expiredAssists.length > 0) {
          const now = await db.query('SELECT now() AS server_now')
          if (changed.length > 0) hub.broadcast('state', changed, now.rows[0].server_now)
          if (expiredDibs.length > 0) hub.broadcast('dibs', expiredDibs, now.rows[0].server_now)
          if (expiredAssists.length > 0) hub.broadcast('assist', expiredAssists, now.rows[0].server_now)
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
          hub.alert({ kind: 'surge', surge: ev.kind, direction: ev.direction, count: ev.count, ...msg })
          // Subscribers: a background web-push, even with the tab closed. The
          // tag includes the kind (#359) — sharing one tag would let a revive
          // alert silently REPLACE an unread status alert in the tray.
          void deps.pushService?.sendToAll({ ...msg, url: '/war-room', tag: `surge-${ev.kind}-${ev.direction}` }).catch(() => {})
        }
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
      // Heartbeat, not the poll rate: each sub-poll (roster, chains, member
      // stats) gates itself on its own configured cadence. It runs at the
      // roster floor so the fastest allowed setting is actually reachable.
      timer = setInterval(
        () => {
          void tick({ respectRosterCadence: true }).catch((err) => {
            // Was `.catch(() => {})`. A Torn rate-limit error thrown by the
            // roster sync vanished here, so a board that had stopped updating
            // looked identical to one with nothing to report (#342). Throttled
            // so a persistent fault cannot flood the log.
            if (Date.now() - lastTickErrorLogAt < 60_000) return
            lastTickErrorLogAt = Date.now()
            console.error('[war-room] tick failed:', err?.message ?? err)
          })
        },
        deps.intervalMs ?? TICKER_HEARTBEAT_MS
      )
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}
