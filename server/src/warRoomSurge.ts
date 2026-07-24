// Server-side PUSH-surge detection (#208). One detector instance lives in the
// war-room ticker (the single source of truth) and watches member state deltas
// for a rate-based surge of members coming out of hospital ("becoming Okay"):
//
//   enemy-side surge  → defensive ("we're being pushed")
//   our-side surge    → offensive ("organize a push")
//
// A surge fires when >= N members become Okay within M seconds on one side,
// with per-direction thresholds and a per-direction cooldown so Okay<->hospital
// flicker can't re-spam. Detection is a pure state machine over the changed
// rows the ticker already produces, so it is unit-testable without a DB.

export type SurgeDirection = 'enemy' | 'our'

export interface SurgeDirectionConfig {
  /** Members that must become Okay within the window to fire. */
  threshold: number
  /** Rolling window length in seconds. */
  windowSec: number
}

export interface SurgeConfig {
  enabled: boolean
  enemy: SurgeDirectionConfig
  our: SurgeDirectionConfig
  /** Per-direction quiet period after a fire, in seconds. */
  cooldownSec: number
}

export interface SurgeEvent {
  direction: SurgeDirection
  /** How many became Okay in the window at fire time. */
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
  state?: { status?: { state?: string } | null } | null
}

function statusState(row: StateRow): string | null {
  return row.state?.status?.state ?? null
}

export function createSurgeDetector() {
  // Last-known Okay/other status per member, so we detect genuine transitions
  // (not just "is Okay now"). Seeded silently on first sighting.
  const lastState = new Map<string, string>()
  const windows: Record<SurgeDirection, number[]> = { enemy: [], our: [] }
  const cooldownUntil: Record<SurgeDirection, number> = { enemy: 0, our: 0 }

  function directionFor(factionId: number, ctx: ObserveContext): SurgeDirection | null {
    if (factionId === ctx.enemyId) return 'enemy'
    if (factionId === ctx.ourId) return 'our'
    return null
  }

  return {
    /**
     * Feed one tick's changed rows; returns the surges that fired this tick.
     * No-op (and returns []) when detection is disabled.
     */
    observe(changed: StateRow[], ctx: ObserveContext): SurgeEvent[] {
      if (!ctx.config.enabled) return []
      const fired: SurgeEvent[] = []

      for (const row of changed) {
        const id = String(row.member_id)
        // A roster leaver isn't a surge; forget them so a rejoin re-seeds.
        if (row.deleted_at) {
          lastState.delete(id)
          continue
        }
        const next = statusState(row)
        if (!next) continue
        const prev = lastState.get(id)
        lastState.set(id, next)
        // Genuine hospital→Okay (or any non-Okay→Okay) transition only. First
        // sighting (prev === undefined) seeds without counting, so a process
        // restart doesn't read the whole roster as one big surge.
        if (prev !== undefined && prev !== 'Okay' && next === 'Okay') {
          const dir = directionFor(Number(row.faction_id), ctx)
          if (dir) windows[dir].push(ctx.nowMs)
        }
      }

      for (const dir of ['enemy', 'our'] as SurgeDirection[]) {
        const dirCfg = ctx.config[dir]
        const cutoff = ctx.nowMs - dirCfg.windowSec * 1000
        windows[dir] = windows[dir].filter((t) => t >= cutoff)
        if (
          windows[dir].length >= dirCfg.threshold &&
          ctx.nowMs >= cooldownUntil[dir]
        ) {
          fired.push({ direction: dir, count: windows[dir].length, windowSec: dirCfg.windowSec })
          cooldownUntil[dir] = ctx.nowMs + ctx.config.cooldownSec * 1000
          windows[dir] = [] // reset so the next fire needs a fresh surge
        }
      }

      return fired
    },
  }
}
