// Member daily stats — port of scripts/scrape_member_stats.py:
//   1. Backfill: for each current member, any of the last 30 days missing a
//      snapshot gets a personalstats?cat=all call at that date's 01:00 UTC
//      (no historical profile exists, so backfill rows carry stats only).
//   2. Today: personalstats per member. Profile denorms (is_donator,
//      property_name, last_action_timestamp) moved to the once-daily
//      member-profile job (#226).
//   3. Gym contributions: five faction-level calls, merged into today's rows
//      (gym-only rows for anyone missing personalstats today).
import type { JobDeps } from './itemsSync.js'
import type { RunResult } from '../runLog.js'
import { TornApiError } from '../tornClient.js'

const BACKFILL_DAYS = 30
const SNAPSHOT_OFFSET_SECONDS = 3600

// Multi-key fan-out (#228): spread the per-member calls across several pooled
// keys so a run finishes in a fraction of the single-key time, and retry a call
// on another key when one fails. Bounded (default 3) so other scrapers keep keys
// available; operator-tunable via MEMBER_STATS_MAX_KEYS.
const MAX_KEYS = Math.max(1, Number(process.env.MEMBER_STATS_MAX_KEYS) || 3)
// Torn error codes that mean the KEY is bad — drop it from the run and disable
// it in the pool.
const KEY_DISABLE_CODES = new Set([2, 10, 13])
// Codes that are transient for the key (rate limit / IP block) — just try
// another key for this call; the key stays in rotation.
const KEY_TRANSIENT_CODES = new Set([5, 8])

// The personalstats categories a competition metric can read (#227). Only these
// are kept in the slim sample series — the full ~200-field blob stays in the
// once-daily member_daily_stats row.
const SAMPLE_CATEGORIES = ['drugs', 'attacking', 'hospital', 'other']

function slimStats(personalstats: unknown): Record<string, unknown> {
  const ps = (personalstats ?? {}) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const cat of SAMPLE_CATEGORIES) if (ps[cat] !== undefined) out[cat] = ps[cat]
  return out
}
const GYM_COLUMNS: Record<string, string> = {
  gymstrength: 'gym_strength',
  gymspeed: 'gym_speed',
  gymdexterity: 'gym_dexterity',
  gymdefense: 'gym_defense',
  gymenergy: 'gym_energy',
}

interface StatsRecord {
  member_id: string
  snapshot_date: string
  personalstats?: unknown
  profile?: unknown
  is_donator?: boolean
  property_name?: string | null
  last_action_timestamp?: number | null
  gym?: Record<string, number>
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10)

export async function memberStatsJob({ db, pool, client }: JobDeps): Promise<RunResult> {
  // Claim up to MAX_KEYS distinct pooled keys to fan out across. The pool hands
  // out least-recently-claimed keys; we stop when it repeats (pool smaller than
  // MAX_KEYS) or is empty.
  const active: { member_id: string; key: string }[] = []
  const seen = new Set<string>()
  for (let i = 0; i < MAX_KEYS; i++) {
    const k = await pool.claim()
    if (!k || seen.has(k.member_id)) break
    seen.add(k.member_id)
    active.push(k)
  }
  if (active.length === 0) throw new Error('no pooled key available')

  // Fetch with key rotation + retry (#228): rotate keys for load-spread; on a
  // transient or bad-key error retry the SAME call on another key; drop+disable
  // a bad key. Returns null only when the call can't be satisfied by any key (a
  // member-specific/unknown error, or every key exhausted) — so no member is
  // dropped after a single failed attempt.
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

  const members = await db.query(
    `SELECT member_id, member_name FROM members WHERE is_current = true ORDER BY member_id`
  )
  if (members.rows.length === 0) return { rows: 0, details: { note: 'no current members' } }

  const today = new Date()
  const todayStr = isoDate(today)
  const targetDates: string[] = []
  for (let i = 1; i <= BACKFILL_DAYS; i++) {
    targetDates.push(isoDate(new Date(today.getTime() - i * 86400_000)))
  }

  const records: StatsRecord[] = []
  let backfillCalls = 0

  // 1. Backfill (personalstats only).
  for (const m of members.rows) {
    const existing = await db.query(
      `SELECT snapshot_date FROM member_daily_stats WHERE member_id = $1`,
      [m.member_id]
    )
    const have = new Set(existing.rows.map((r) => String(r.snapshot_date)))
    for (const d of targetDates) {
      if (have.has(d)) continue
      const ts = Math.floor(new Date(`${d}T00:00:00Z`).getTime() / 1000) + SNAPSHOT_OFFSET_SECONDS
      backfillCalls += 1
      const data = await rfetch(`/v2/user/${m.member_id}/personalstats?cat=all&timestamp=${ts}`)
      if (data?.personalstats) {
        records.push({ member_id: m.member_id, snapshot_date: d, personalstats: data.personalstats })
      }
      // If no key could satisfy it, the day stays missing — the next run retries.
    }
  }

  // 2. Today: personalstats. Profile denorms (is_donator, property_name,
  //    last_action_timestamp) are the separate once-daily member-profile job
  //    (#226) — they change too slowly to re-fetch on every intraday run.
  for (const m of members.rows) {
    const data = await rfetch(`/v2/user/${m.member_id}/personalstats?cat=all`)
    const personalstats = data?.personalstats ?? null
    if (!personalstats) continue
    records.push({ member_id: m.member_id, snapshot_date: todayStr, personalstats })
  }

  // 3. Gym contributions (five faction-level calls).
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
    // A missing gym stat never blocks the snapshot (rfetch returns null).
  }
  const todayIds = new Set(records.filter((r) => r.snapshot_date === todayStr).map((r) => r.member_id))
  for (const r of records) {
    if (r.snapshot_date === todayStr && gymData.has(r.member_id)) r.gym = gymData.get(r.member_id)
  }
  for (const [mid, gym] of gymData) {
    if (!todayIds.has(mid)) records.push({ member_id: mid, snapshot_date: todayStr, gym })
  }

  // 4. Upsert on (member_id, snapshot_date).
  for (const r of records) {
    const gym = r.gym ?? {}
    await db.query(
      `INSERT INTO member_daily_stats (member_id, snapshot_date, personalstats, profile,
         is_donator, property_name, last_action_timestamp, api_version,
         gym_strength, gym_speed, gym_dexterity, gym_defense, gym_energy)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'v2-all', $8, $9, $10, $11, $12)
       ON CONFLICT (member_id, snapshot_date) DO UPDATE SET
         personalstats = COALESCE(EXCLUDED.personalstats, member_daily_stats.personalstats),
         profile = COALESCE(EXCLUDED.profile, member_daily_stats.profile),
         is_donator = COALESCE(EXCLUDED.is_donator, member_daily_stats.is_donator),
         property_name = COALESCE(EXCLUDED.property_name, member_daily_stats.property_name),
         last_action_timestamp = COALESCE(EXCLUDED.last_action_timestamp, member_daily_stats.last_action_timestamp),
         api_version = EXCLUDED.api_version,
         gym_strength = COALESCE(EXCLUDED.gym_strength, member_daily_stats.gym_strength),
         gym_speed = COALESCE(EXCLUDED.gym_speed, member_daily_stats.gym_speed),
         gym_dexterity = COALESCE(EXCLUDED.gym_dexterity, member_daily_stats.gym_dexterity),
         gym_defense = COALESCE(EXCLUDED.gym_defense, member_daily_stats.gym_defense),
         gym_energy = COALESCE(EXCLUDED.gym_energy, member_daily_stats.gym_energy)`,
      [r.member_id, r.snapshot_date,
       r.personalstats != null ? JSON.stringify(r.personalstats) : null,
       r.profile != null ? JSON.stringify(r.profile) : null,
       r.is_donator ?? null, r.property_name ?? null, r.last_action_timestamp ?? null,
       gym.gym_strength ?? null, gym.gym_speed ?? null, gym.gym_dexterity ?? null,
       gym.gym_defense ?? null, gym.gym_energy ?? null]
    )
  }

  // 5. Append a slim, timestamped sample per member for today (#227). Append-
  //    only — this is the series competition resolution reads at exact
  //    boundaries. captured_at defaults to now(); gym-only members still get a
  //    sample (empty stats + gym) so gym-metric contests see them.
  let samples = 0
  for (const r of records) {
    if (r.snapshot_date !== todayStr) continue
    const gym = r.gym ?? {}
    await db.query(
      `INSERT INTO member_stat_samples
         (member_id, stats, gym_strength, gym_speed, gym_dexterity, gym_defense, gym_energy)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [r.member_id, JSON.stringify(slimStats(r.personalstats)),
       gym.gym_strength ?? null, gym.gym_speed ?? null, gym.gym_dexterity ?? null,
       gym.gym_defense ?? null, gym.gym_energy ?? null]
    )
    samples++
  }

  return { rows: records.length, details: { backfill_calls: backfillCalls, gym_members: gymData.size, samples } }
}
