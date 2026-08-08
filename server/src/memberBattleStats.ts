// Our own members' battle stats (#348).
//
// Three sources, tried in descending order of trust, so every member ends up
// with the best figure available rather than a uniform guess:
//
//   1. torn      — /v2/user?selections=battlestats with the member's OWN key.
//                  Exact and current. Self-only (no {id} variant) and needs
//                  Limited access, which is our enrolment floor, so every
//                  pooled key qualifies.
//   2. tornstats — the faction spy report for OUR faction. As fresh as
//                  whoever last spied.
//   3. bsp       — Battle Stats Predictor's estimate. A guess, but better
//                  than nothing for members who never enrolled a key.
//
// `source` is persisted so the UI can say which one it is showing. Presenting
// a BSP estimate with the same confidence as a member's own exact figure would
// be worse than showing nothing.
//
// LEAD-ONLY. Battle stats decide who can hit whom; the read path checks the
// role and the table is deliberately separate from `members`, which is read
// everywhere. See warRoom.ts LEAD_ONLY_CHANNELS for the same reasoning applied
// to live energy.
import type pg from 'pg'

export type BattleStatsSource = 'torn' | 'tornstats' | 'bsp'

export interface BattleStats {
  strength: number | null
  defense: number | null
  speed: number | null
  dexterity: number | null
  total: number | null
}

const EMPTY: BattleStats = {
  strength: null, defense: null, speed: null, dexterity: null, total: null,
}

function num(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value
}

/**
 * Parse /v2/user?selections=battlestats.
 *
 * v2 wraps each stat as `{ value, modifier, modifiers }` rather than a bare
 * number, so `strength` is an object and `strength.value` is the figure. The
 * modifiers are the temporary buffs on top; we store the base `value` because
 * a stat that changes when a drug wears off is not a useful comparison.
 */
export function parseTornBattleStats(body: unknown): BattleStats {
  const b = (body ?? {}) as Record<string, any>
  const bs = b.battlestats ?? b
  if (!bs || typeof bs !== 'object') return { ...EMPTY }
  const stat = (k: string): number | null => {
    const v = bs[k]
    // Tolerate a bare number in case Torn ever flattens these.
    if (typeof v === 'number') return num(v)
    return num(v?.value)
  }
  const strength = stat('strength')
  const defense = stat('defense')
  const speed = stat('speed')
  const dexterity = stat('dexterity')
  const reported = stat('total')
  // Prefer Torn's own total; fall back to the sum when every part is present,
  // so a missing `total` field doesn't blank an otherwise complete row.
  const parts = [strength, defense, speed, dexterity]
  const total = reported ?? (parts.every((p) => p !== null)
    ? parts.reduce((a, b2) => (a as number) + (b2 as number), 0)
    : null)
  return { strength, defense, speed, dexterity, total }
}

/** Parse one member's entry out of a TornStats faction spy payload. */
export function parseTornStatsSpy(entry: unknown): { stats: BattleStats; spyAt: Date | null } | null {
  const spy = (entry as any)?.spy
  if (!spy || typeof spy.total !== 'number' || spy.total <= 0) return null
  const ts = typeof spy.timestamp === 'number' ? spy.timestamp : null
  return {
    stats: {
      strength: num(spy.strength),
      defense: num(spy.defense),
      speed: num(spy.speed),
      dexterity: num(spy.dexterity),
      total: num(spy.total),
    },
    spyAt: ts ? new Date(ts * 1000) : null,
  }
}

/** Parse a Battle Stats Predictor response. Result 1 and 6 both carry stats. */
export function parseBspStats(body: unknown): BattleStats | null {
  const d = body as any
  if (!d || (d.Result !== 1 && d.Result !== 6) || typeof d.TBS !== 'number') return null
  return {
    strength: num(d.Strength),
    defense: num(d.Defense),
    speed: num(d.Speed),
    dexterity: num(d.Dexterity),
    total: num(d.TBS),
  }
}

/**
 * Should we overwrite what we already have with a reading from `next`?
 *
 * Sources are ranked, and a run must never downgrade a member's exact figure
 * to an estimate just because the estimate arrived later. A same-or-better
 * source always wins (it is fresher); a worse one only fills a blank.
 */
const RANK: Record<BattleStatsSource, number> = { torn: 3, tornstats: 2, bsp: 1 }

export function shouldReplace(
  existing: { source?: string | null; total?: number | null } | null | undefined,
  next: BattleStatsSource
): boolean {
  if (!existing || existing.total == null) return true
  const current = RANK[(existing.source ?? 'bsp') as BattleStatsSource] ?? 0
  return RANK[next] >= current
}

/** Persist one member's stats, respecting the source ranking. */
export async function storeBattleStats(
  db: pg.Pool,
  memberId: string | number,
  stats: BattleStats,
  source: BattleStatsSource,
  opts: { spyAt?: Date | null; lastError?: string | null } = {}
): Promise<boolean> {
  const existing = await db.query(
    'SELECT source, total FROM member_battle_stats WHERE member_id = $1',
    [memberId]
  )
  if (!shouldReplace(existing.rows[0], source)) return false
  await db.query(
    `INSERT INTO member_battle_stats
       (member_id, strength, defense, speed, dexterity, total, source, fetched_at, spy_at, last_error, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8, $9, now())
     ON CONFLICT (member_id) DO UPDATE SET
       strength = EXCLUDED.strength, defense = EXCLUDED.defense,
       speed = EXCLUDED.speed, dexterity = EXCLUDED.dexterity,
       total = EXCLUDED.total, source = EXCLUDED.source,
       fetched_at = EXCLUDED.fetched_at, spy_at = EXCLUDED.spy_at,
       last_error = EXCLUDED.last_error, updated_at = now()`,
    [memberId, stats.strength, stats.defense, stats.speed, stats.dexterity,
     stats.total, source, opts.spyAt ?? null, opts.lastError ?? null]
  )
  return true
}
