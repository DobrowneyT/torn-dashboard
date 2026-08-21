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
import { createKeyRotator, slimStats, GYM_COLUMNS } from '../sampleCapture.js'

const BACKFILL_DAYS = 30
const SNAPSHOT_OFFSET_SECONDS = 3600

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

// Upsert one (member_id, snapshot_date) row. Shared by the incremental backfill
// (#247 — written as each day is fetched, so a crash mid-backfill keeps its
// progress) and the today/gym write. Idempotent: re-running COALESCEs onto the
// existing row.
async function upsertDailyStats(db: JobDeps['db'], r: StatsRecord): Promise<void> {
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

export async function memberStatsJob({ db, pool, client }: JobDeps): Promise<RunResult> {
  // Multi-key fan-out + retry (#228): spread per-member calls across up to
  // MAX_KEYS pooled keys, retrying a call on another key when one fails.
  const { active, rfetch } = await createKeyRotator(pool, client)
  if (active.length === 0) throw new Error('no pooled key available')

  const members = await db.query(
    `SELECT member_id, member_name FROM members WHERE is_current = true AND is_fallen = false ORDER BY member_id`
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
  let backfillRows = 0

  // 1. Backfill (personalstats only) — written PER DAY as fetched (#247), so an
  //    interruption during this long phase keeps the days already captured and
  //    the next run only fetches the still-missing ones.
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
        await upsertDailyStats(db, { member_id: m.member_id, snapshot_date: d, personalstats: data.personalstats })
        backfillRows += 1
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

  // 4. Upsert today's + gym-only rows (backfill days were already written in
  //    step 1). Same idempotent upsert.
  for (const r of records) {
    await upsertDailyStats(db, r)
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

  return { rows: backfillRows + records.length, details: { backfill_calls: backfillCalls, backfill_rows: backfillRows, gym_members: gymData.size, samples } }
}
