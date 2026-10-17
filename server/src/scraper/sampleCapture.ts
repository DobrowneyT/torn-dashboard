// Shared sample-capture machinery for the intraday series (#227/#228) and the
// exact boundary captures (#230): the multi-key rotator, the slim-sample shape,
// and a one-shot "capture a sample for every current member, stamped at instant
// T" used by competition start/end timers.
import type { JobDeps } from './jobs/itemsSync.js'
import { TornApiError, TORN_RATE_LIMIT_CODES } from './tornClient.js'

// The personalstats categories a competition metric can read. Only these are
// kept in the slim sample series — the full ~200-field blob stays in the
// once-daily member_daily_stats row.
export const SAMPLE_CATEGORIES = ['drugs', 'attacking', 'hospital', 'other']

export function slimStats(personalstats: unknown): Record<string, unknown> {
  const ps = (personalstats ?? {}) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const cat of SAMPLE_CATEGORIES) if (ps[cat] !== undefined) out[cat] = ps[cat]
  return out
}

export const GYM_COLUMNS: Record<string, string> = {
  gymstrength: 'gym_strength',
  gymspeed: 'gym_speed',
  gymdexterity: 'gym_dexterity',
  gymdefense: 'gym_defense',
  gymenergy: 'gym_energy',
}

// Multi-key fan-out (#228): spread per-member calls across several pooled keys
// so a run finishes fast, and retry a call on another key when one fails.
// Bounded (default 3) so other scrapers keep keys; operator-tunable.
export const MAX_KEYS = Math.max(1, Number(process.env.MEMBER_STATS_MAX_KEYS) || 3)
// Torn error codes that mean the KEY is bad — drop + disable it.
const KEY_DISABLE_CODES = new Set([2, 10, 13])
// Codes transient for the key (rate limit / IP block) — try another key.
// ⚠️ The named constant, not a literal: this is RATE LIMITING (a routine
// soft stop), deliberately distinct from TORN_UNAVAILABLE_CODES (an
// outage, which should fail visibly). Four files used to spell this
// `[5, 8]` each, with nothing saying which concept it was.
const KEY_TRANSIENT_CODES = TORN_RATE_LIMIT_CODES

export interface KeyRotator {
  active: { member_id: string; key: string }[]
  /** GET via key rotation + retry. null = no key could satisfy it. */
  rfetch(path: string): Promise<any | null>
}

// Claim up to MAX_KEYS distinct pooled keys and hand back a rotating fetcher.
export async function createKeyRotator(
  pool: JobDeps['pool'],
  client: JobDeps['client'],
  maxKeys = MAX_KEYS,
  /**
   * Restrict the rotation to keys whose owner accepted a disclosure covering
   * this purpose (#894).
   *
   * ⚠️ Omitting it is the baseline and claims exactly what it always did, so
   * every existing job is unaffected. Only a job for a NEWLY disclosed purpose
   * passes one, and then a member who has not re-accepted is skipped for that
   * job alone.
   */
  purpose?: string
): Promise<KeyRotator> {
  const active: { member_id: string; key: string }[] = []
  const seen = new Set<string>()
  for (let i = 0; i < maxKeys; i++) {
    const k = await pool.claim(purpose ? { purpose } : {})
    if (!k || seen.has(k.member_id)) break
    seen.add(k.member_id)
    active.push(k)
  }

  let rr = 0
  async function rfetch(path: string): Promise<any | null> {
    const tried = new Set<string>()
    while (true) {
      const candidates = active.filter((k) => !tried.has(k.member_id))
      if (candidates.length === 0) return null
      const key = candidates[rr % candidates.length]
      rr++
      tried.add(key.member_id)
      try {
        return await client.fetch(path, key.key)
      } catch (err) {
        const code = err instanceof TornApiError ? err.tornCode : -1
        if (KEY_DISABLE_CODES.has(code)) {
          await pool.disable(key.member_id, `Torn error ${code}: key rejected`)
          const i = active.findIndex((k) => k.member_id === key.member_id)
          if (i >= 0) active.splice(i, 1)
          continue // key gone — try another
        }
        if (KEY_TRANSIENT_CODES.has(code)) continue // try another key, keep this one
        return null // member-specific / unknown — another key won't help
      }
    }
  }

  return { active, rfetch }
}

// Capture a fresh, real-time sample for every current member and append it to
// member_stat_samples stamped at exactly `capturedAt` (#230). Stamping at the
// boundary instant is what makes the sample count as the "latest sample ≤
// boundary" during resolution — capturing a moment late with now() would place
// it just past the cutoff and exclude it. Best-effort: returns how many landed
// (0 if there's no pooled key).
export async function captureBoundarySamples(
  { db, pool, client }: JobDeps,
  capturedAt: Date
): Promise<number> {
  const { active, rfetch } = await createKeyRotator(pool, client)
  if (active.length === 0) return 0

  const members = await db.query(
    `SELECT member_id FROM members WHERE is_current = true AND is_fallen = false ORDER BY member_id`
  )
  const psById = new Map<string, unknown>()
  for (const m of members.rows) {
    const data = await rfetch(`/v2/user/${m.member_id}/personalstats?cat=all`)
    if (data?.personalstats) psById.set(m.member_id, data.personalstats)
  }

  const gymData = new Map<string, Record<string, number>>()
  for (const [stat, column] of Object.entries(GYM_COLUMNS)) {
    const data = await rfetch(`/v2/faction/contributors?stat=${stat}&cat=current`)
    if (data) {
      for (const entry of data.contributors ?? []) {
        const mid = String(entry.id)
        if (!gymData.has(mid)) gymData.set(mid, {})
        gymData.get(mid)![column] = entry.value ?? 0
      }
    }
  }

  const ids = new Set<string>([...psById.keys(), ...gymData.keys()])
  let n = 0
  for (const mid of ids) {
    const gym = gymData.get(mid) ?? {}
    await db.query(
      `INSERT INTO member_stat_samples
         (member_id, captured_at, stats, gym_strength, gym_speed, gym_dexterity, gym_defense, gym_energy)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [mid, capturedAt, JSON.stringify(slimStats(psById.get(mid))),
       gym.gym_strength ?? null, gym.gym_speed ?? null, gym.gym_dexterity ?? null,
       gym.gym_defense ?? null, gym.gym_energy ?? null]
    )
    n++
  }
  return n
}
