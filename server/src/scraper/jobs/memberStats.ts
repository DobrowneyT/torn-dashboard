// Member daily stats — port of scripts/scrape_member_stats.py:
//   1. Backfill: for each current member, any of the last 30 days missing a
//      snapshot gets a personalstats?cat=all call at that date's 01:00 UTC
//      (no historical profile exists, so backfill rows carry stats only).
//   2. Today: personalstats + profile per member, with the compliance
//      denormalisations (is_donator, property_name, last_action_timestamp).
//   3. Gym contributions: five faction-level calls, merged into today's rows
//      (gym-only rows for anyone missing personalstats today).
import type { JobDeps } from './itemsSync.js'
import type { RunResult } from '../runLog.js'

const BACKFILL_DAYS = 30
const SNAPSHOT_OFFSET_SECONDS = 3600
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
  const claimed = await pool.claim()
  if (!claimed) throw new Error('no pooled key available')

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
      try {
        const data = await client.fetch(
          `/v2/user/${m.member_id}/personalstats?cat=all&timestamp=${ts}`,
          claimed.key
        )
        if (data.personalstats) {
          records.push({ member_id: m.member_id, snapshot_date: d, personalstats: data.personalstats })
        }
      } catch {
        // Skip the day — the next run retries it (it stays missing).
      }
    }
  }

  // 2. Today: personalstats + profile.
  for (const m of members.rows) {
    let personalstats: unknown = null
    try {
      const data = await client.fetch(`/v2/user/${m.member_id}/personalstats?cat=all`, claimed.key)
      personalstats = data.personalstats ?? null
    } catch {
      personalstats = null
    }
    if (!personalstats) continue

    const record: StatsRecord = { member_id: m.member_id, snapshot_date: todayStr, personalstats }
    try {
      const data = await client.fetch(`/v2/user/${m.member_id}/profile?striptags=true`, claimed.key)
      const profile = data.profile
      if (profile) {
        record.profile = profile
        record.is_donator = profile.donator_status != null
        record.property_name = profile.property?.name ?? null
        record.last_action_timestamp = profile.last_action?.timestamp ?? null
      }
    } catch {
      // Profile is enrichment only — stats row still lands.
    }
    records.push(record)
  }

  // 3. Gym contributions (five faction-level calls).
  const gymData = new Map<string, Record<string, number>>()
  for (const [stat, column] of Object.entries(GYM_COLUMNS)) {
    try {
      const data = await client.fetch(`/v2/faction/contributors?stat=${stat}&cat=current`, claimed.key)
      for (const entry of data.contributors ?? []) {
        const mid = String(entry.id)
        if (!gymData.has(mid)) gymData.set(mid, {})
        gymData.get(mid)![column] = entry.value ?? 0
      }
    } catch {
      // A missing gym stat never blocks the snapshot.
    }
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

  return { rows: records.length, details: { backfill_calls: backfillCalls, gym_members: gymData.size } }
}
