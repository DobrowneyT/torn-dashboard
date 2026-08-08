// Server-side PUSH-surge detection (#208, extended #359). One detector
// instance lives in the war-room ticker (the single source of truth) and
// watches member state deltas for two independent kinds of surge:
//
//   status — members coming out of hospital ("becoming Okay"). The push is
//            already under way by the time this fires.
//   revive — members turning their revives ON. Nobody does that casually
//            mid-war; they do it because they expect to be hospitalised and
//            want a hired reviver to bring them straight back. This is the
//            push being SET UP.
//
// In each kind:
//   enemy-side surge  → defensive ("we're being pushed")
//   our-side surge    → offensive ("organize a push")
//
// A surge fires when >= N members transition within M seconds on one side,
// with per-direction thresholds and a per-kind, per-direction cooldown so
// flicker can't re-spam. Detection is a pure state machine over the changed
// rows the ticker already produces, so it is unit-testable without a DB.

export type SurgeDirection = 'enemy' | 'our'
export type SurgeKind = 'status' | 'revive'

export const SURGE_KINDS: SurgeKind[] = ['status', 'revive']
const DIRECTIONS: SurgeDirection[] = ['enemy', 'our']

export interface SurgeDirectionConfig {
  /** Members that must transition within the window to fire. */
  threshold: number
  /** Rolling window length in seconds. */
  windowSec: number
}

export interface SurgeKindConfig {
  enabled: boolean
  enemy: SurgeDirectionConfig
  our: SurgeDirectionConfig
  /** Per-direction quiet period after a fire, in seconds. */
  cooldownSec: number
}

export interface SurgeConfig {
  status: SurgeKindConfig
  revive: SurgeKindConfig
}

export interface SurgeEvent {
  kind: SurgeKind
  direction: SurgeDirection
  /** How many transitioned in the window at fire time. */
  count: number
  windowSec: number
}

export interface ObserveContext {
  enemyId: number
  ourId: number
  config: SurgeConfig
  nowMs: number
}

/** A war-room state row as produced by syncWarRoomMemberStates. */
interface StateRow {
  member_id: number | string
  faction_id: number | string
  deleted_at?: unknown
  state?: {
    status?: { state?: string } | null
    is_revivable?: unknown
  } | null
}

function statusState(row: StateRow): string | null {
  return row.state?.status?.state ?? null
}

/**
 * Is this member revivable?
 *
 * Keyed off `is_revivable` rather than `revive_setting` deliberately. Torn
 * reports `revive_setting` as "Unknown" for an opponent — which is why
 * reviveAudience() treats unknown as "anyone" (#342) — and the enemy side is
 * the entire point of this alert. `is_revivable` is the one revive signal that
 * crosses faction lines.
 */
function isRevivable(row: StateRow): boolean | null {
  if (!row.state) return null
  const v = row.state.is_revivable
  return typeof v === 'boolean' ? v : null
}

export function createSurgeDetector() {
  // Last-known value per member per kind, so we detect genuine TRANSITIONS
  // rather than "is in this state now". Seeded silently on first sighting: a
  // process restart re-reads the whole roster in one tick, and without the
  // seed that would look like every member surging at once.
  const lastStatus = new Map<string, string>()
  const lastRevivable = new Map<string, boolean>()

  const windows: Record<SurgeKind, Record<SurgeDirection, number[]>> = {
    status: { enemy: [], our: [] },
    revive: { enemy: [], our: [] },
  }
  const cooldownUntil: Record<SurgeKind, Record<SurgeDirection, number>> = {
    status: { enemy: 0, our: 0 },
    revive: { enemy: 0, our: 0 },
  }

  function directionFor(factionId: number, ctx: ObserveContext): SurgeDirection | null {
    if (factionId === ctx.enemyId) return 'enemy'
    if (factionId === ctx.ourId) return 'our'
    return null
  }

  return {
    /**
     * Feed one tick's changed rows; returns the surges that fired this tick.
     * A kind whose toggle is off is not tracked at all — no windows, no
     * transitions — so switching it on starts from a clean slate rather than
     * immediately firing on history accumulated while it was disabled.
     */
    observe(changed: StateRow[], ctx: ObserveContext): SurgeEvent[] {
      const cfg = ctx.config
      const anyEnabled = SURGE_KINDS.some((k) => cfg[k]?.enabled)
      if (!anyEnabled) return []
      const fired: SurgeEvent[] = []

      for (const row of changed) {
        const id = String(row.member_id)
        // A roster leaver isn't a surge; forget them so a rejoin re-seeds.
        if (row.deleted_at) {
          lastStatus.delete(id)
          lastRevivable.delete(id)
          continue
        }
        const dir = directionFor(Number(row.faction_id), ctx)

        // ── status: any non-Okay → Okay ───────────────────────────────────
        if (cfg.status?.enabled) {
          const next = statusState(row)
          if (next) {
            const prev = lastStatus.get(id)
            lastStatus.set(id, next)
            if (prev !== undefined && prev !== 'Okay' && next === 'Okay' && dir) {
              windows.status[dir].push(ctx.nowMs)
            }
          }
        }

        // ── revive: false → true ──────────────────────────────────────────
        if (cfg.revive?.enabled) {
          const next = isRevivable(row)
          if (next !== null) {
            const prev = lastRevivable.get(id)
            lastRevivable.set(id, next)
            if (prev === false && next === true && dir) {
              windows.revive[dir].push(ctx.nowMs)
            }
          }
        }
      }

      for (const kind of SURGE_KINDS) {
        const kindCfg = cfg[kind]
        if (!kindCfg?.enabled) continue
        for (const dir of DIRECTIONS) {
          const dirCfg = kindCfg[dir]
          const cutoff = ctx.nowMs - dirCfg.windowSec * 1000
          windows[kind][dir] = windows[kind][dir].filter((t) => t >= cutoff)
          if (
            windows[kind][dir].length >= dirCfg.threshold &&
            ctx.nowMs >= cooldownUntil[kind][dir]
          ) {
            fired.push({
              kind,
              direction: dir,
              count: windows[kind][dir].length,
              windowSec: dirCfg.windowSec,
            })
            cooldownUntil[kind][dir] = ctx.nowMs + kindCfg.cooldownSec * 1000
            windows[kind][dir] = [] // reset so the next fire needs a fresh surge
          }
        }
      }

      return fired
    },
  }
}
