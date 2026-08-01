// Shared war-room chain helpers: converting Torn's chain payload to our storage
// shape and persisting each side of the chain singleton (war_room_chain_v2).
// Used by both the manual "fetch-chains" seed and the live ticker poller so the
// two behave identically.
//
// Torn returns `timeout`/`cooldown` as RELATIVE seconds (e.g. timeout 184 =
// "184s until the chain drops"); the war-room UI counts down against ABSOLUTE
// epochs. We convert on store. `start`/`end` are already absolute and pass
// through untouched. 0/absent ⇒ no active timer ⇒ null.
import type pg from 'pg'

export const CHAIN_FORCE_POLL_SEC = 6

/** Relative seconds → absolute epoch, or null when there is no active timer. */
export function absTimer(rel: unknown, nowEpoch: number): number | null {
  const n = Number(rel)
  return Number.isFinite(n) && n > 0 ? nowEpoch + n : null
}

/** A chain object with `timeout`/`cooldown` converted to absolute epochs. */
export function chainTimersToAbsolute(chain: Record<string, unknown>, nowEpoch: number): Record<string, unknown> {
  return { ...chain, timeout: absTimer(chain.timeout, nowEpoch), cooldown: absTimer(chain.cooldown, nowEpoch) }
}

/**
 * Persist OUR chain into the singleton (id=1), converting relative timers.
 * Leaves the enemy side and the save claim untouched. Returns the full row.
 */
export async function storeOurChain(db: pg.Pool, rawChain: any, nowEpoch = Math.floor(Date.now() / 1000)) {
  const oc = rawChain ?? {}
  const res = await db.query(
    `INSERT INTO war_room_chain_v2 (id, current, max, modifier, timeout, start_ts, cooldown, end_ts,
       our_last_fetched_at, updated_at)
     VALUES (1, $1, $2, $3, $4, $5, $6, $7, now(), now())
     ON CONFLICT (id) DO UPDATE SET
       current = EXCLUDED.current, max = EXCLUDED.max, modifier = EXCLUDED.modifier,
       timeout = EXCLUDED.timeout, start_ts = EXCLUDED.start_ts, cooldown = EXCLUDED.cooldown,
       end_ts = EXCLUDED.end_ts, our_last_fetched_at = now(), updated_at = now()
     RETURNING *`,
    [oc.current ?? null, oc.max ?? null, oc.modifier ?? null, absTimer(oc.timeout, nowEpoch),
     oc.start ?? null, absTimer(oc.cooldown, nowEpoch), oc.end ?? null]
  )
  return res.rows[0]
}

/**
 * Persist the ENEMY chain jsonb into the singleton, converting relative timers.
 * Leaves our side untouched. Returns the full row. Call only with a fetched
 * chain — a transient enemy-fetch failure should not wipe the last good value.
 */
export async function storeEnemyChain(db: pg.Pool, rawChain: any, nowEpoch = Math.floor(Date.now() / 1000)) {
  const enemyChain = rawChain ? chainTimersToAbsolute(rawChain, nowEpoch) : null
  const res = await db.query(
    `INSERT INTO war_room_chain_v2 (id, enemy, enemy_last_fetched_at, updated_at)
     VALUES (1, $1, now(), now())
     ON CONFLICT (id) DO UPDATE SET
       enemy = EXCLUDED.enemy, enemy_last_fetched_at = now(), updated_at = now()
     RETURNING *`,
    [enemyChain ? JSON.stringify(enemyChain) : null]
  )
  return res.rows[0]
}

/**
 * Has `intervalSec` elapsed since the last fetch? `lastFetchedEpochSec` is the
 * epoch-seconds of the last fetch (from SQL `extract(epoch from ...)`) or null
 * when never fetched. Epoch-based, not string-parsed, so pg's timestamptz text
 * format never trips it.
 */
export function chainPollDue(
  lastFetchedEpochSec: number | null | undefined,
  intervalSec: number,
  nowMs: number
): boolean {
  const last = Number(lastFetchedEpochSec)
  if (lastFetchedEpochSec == null || !Number.isFinite(last)) return true
  return nowMs / 1000 - last >= Math.max(1, intervalSec)
}

/**
 * Is the stored (absolute) chain timeout within `forceSec` of expiring? Used to
 * force an off-cadence poll so we catch the drop precisely.
 */
export function chainNearExpiry(timeoutEpoch: number | null | undefined, nowEpoch: number, forceSec: number): boolean {
  if (timeoutEpoch == null) return false
  const left = Number(timeoutEpoch) - nowEpoch
  return left > 0 && left <= forceSec
}
