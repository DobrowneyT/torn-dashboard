// Member profile enrichment (#226) — split out of member-stats. Donator
// status, property name and last-action only change on a daily timescale, so
// they get their own once-daily job instead of riding every member-stats run
// (which goes intraday under #225). One profile call per current member,
// upserted onto today's member_daily_stats row; COALESCE means it composes with
// whatever member-stats wrote to the same row (personalstats + gym) in any order.
import type { JobDeps } from './itemsSync.js'
import type { RunResult } from '../runLog.js'

const isoDate = (d: Date) => d.toISOString().slice(0, 10)

export async function memberProfileJob({ db, pool, client }: JobDeps): Promise<RunResult> {
  const claimed = await pool.claim()
  if (!claimed) throw new Error('no pooled key available')

  const members = await db.query(
    `SELECT member_id FROM members WHERE is_current = true ORDER BY member_id`
  )
  if (members.rows.length === 0) return { rows: 0, details: { note: 'no current members' } }

  const todayStr = isoDate(new Date())
  let written = 0

  for (const m of members.rows) {
    let profile: any = null
    try {
      const data = await client.fetch(`/v2/user/${m.member_id}/profile?striptags=true`, claimed.key)
      profile = data.profile ?? null
    } catch {
      // Skip this member — the next run retries them.
      continue
    }
    if (!profile) continue

    await db.query(
      `INSERT INTO member_daily_stats
         (member_id, snapshot_date, profile, is_donator, property_name, last_action_timestamp, api_version)
       VALUES ($1, $2, $3, $4, $5, $6, 'v2-all')
       ON CONFLICT (member_id, snapshot_date) DO UPDATE SET
         profile = COALESCE(EXCLUDED.profile, member_daily_stats.profile),
         is_donator = COALESCE(EXCLUDED.is_donator, member_daily_stats.is_donator),
         property_name = COALESCE(EXCLUDED.property_name, member_daily_stats.property_name),
         last_action_timestamp = COALESCE(EXCLUDED.last_action_timestamp, member_daily_stats.last_action_timestamp),
         api_version = EXCLUDED.api_version`,
      [m.member_id, todayStr, JSON.stringify(profile),
       profile.donator_status != null, profile.property?.name ?? null, profile.last_action?.timestamp ?? null]
    )
    written++
  }

  return { rows: written }
}
