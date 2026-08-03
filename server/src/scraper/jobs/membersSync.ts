// Faction members sync — port of cpr_scraper.py's _sync_members_to_supabase
// + _reconcile_key_pool. Marks everyone not in the fresh roster as left
// (rows are history, never deleted), upserts current members, and keeps the
// consented key pool aligned with membership: leavers' keys drop out of
// rotation, rejoiners' keys come back in (claim-time validation still
// guards a stale key).
//
// #284: also captures the roster's lifetime `days_in_faction` onto
// members.total_days_in_faction, and maintains member_faction_stints — one
// open stint per current member — so the days-in-faction streak can be derived.
import type { JobDeps } from './itemsSync.js'
import type { RunResult } from '../runLog.js'

// A snapshot gap larger than this many days reads as an absence when seeding a
// new stint's start from history; ≤ this tolerates brief job downtime.
const STINT_GAP_DAYS = 2

// Infer the current stint's joined_at for a member we're first opening a stint
// for. If they have a run of recent daily snapshots (the stats/profile jobs only
// snapshot current members), walk back the most recent contiguous run and use
// its start. A stale-or-absent newest snapshot means a fresh join/rejoin ⇒ now.
async function seedJoinedAt(dbc: any, memberId: string): Promise<Date> {
  const now = new Date()
  const res = await dbc.query(
    `SELECT snapshot_date::text AS d FROM member_daily_stats
     WHERE member_id = $1 ORDER BY snapshot_date DESC`,
    [memberId]
  )
  if (res.rows.length === 0) return now
  const dayMs = 86400_000
  const toDate = (s: string) => new Date(`${s}T00:00:00Z`)
  const dates = res.rows.map((r: { d: string }) => toDate(r.d))
  if (now.getTime() - dates[0].getTime() > STINT_GAP_DAYS * dayMs) return now
  let start = dates[0]
  for (let i = 1; i < dates.length; i++) {
    if (dates[i - 1].getTime() - dates[i].getTime() <= STINT_GAP_DAYS * dayMs) start = dates[i]
    else break
  }
  return start
}

export async function membersSyncJob({ db, pool, client }: JobDeps): Promise<RunResult> {
  const claimed = await pool.claim()
  if (!claimed) throw new Error('no pooled key available')

  const data = await client.fetch('/v2/faction/members', claimed.key)
  const roster: Array<{ id: number; name: string; days_in_faction?: number }> = data.members ?? []
  if (roster.length === 0) throw new Error('Torn returned an empty roster — refusing to mark everyone as left')

  const dbc = await db.connect()
  try {
    await dbc.query('BEGIN')

    // Whom did we consider present going into this run? (open stints)
    const openBefore = await dbc.query(
      `SELECT member_id FROM member_faction_stints WHERE left_at IS NULL`
    )
    const openSet = new Set<string>(openBefore.rows.map((r: { member_id: string }) => String(r.member_id)))

    await dbc.query(
      `UPDATE members SET is_current = false, last_seen = now() WHERE is_current = true`
    )
    for (const m of roster) {
      await dbc.query(
        `INSERT INTO members (member_id, member_name, total_days_in_faction, is_current, last_seen, updated_at)
         VALUES ($1, $2, $3, true, now(), now())
         ON CONFLICT (member_id) DO UPDATE SET
           member_name = EXCLUDED.member_name,
           total_days_in_faction = EXCLUDED.total_days_in_faction,
           is_current = true, last_seen = now(), updated_at = now()`,
        [String(m.id), m.name, m.days_in_faction ?? null]
      )
    }

    // Key-pool reconcile off the roster we just wrote.
    const currentIds = roster.map((m) => String(m.id))
    await dbc.query(
      `UPDATE member_secrets SET disabled = true,
              last_error = 'not in faction as of ' || now()::text, updated_at = now()
       WHERE disabled = false AND NOT (member_id = ANY($1))`,
      [currentIds]
    )
    await dbc.query(
      `UPDATE member_secrets SET disabled = false, last_error = NULL, updated_at = now()
       WHERE disabled = true AND member_id = ANY($1)`,
      [currentIds]
    )

    // Stints: close anyone who dropped off the roster, open a stint for anyone
    // newly present. Members already holding an open stint are left untouched.
    const currentSet = new Set(currentIds)
    const toClose = [...openSet].filter((id) => !currentSet.has(id))
    if (toClose.length > 0) {
      await dbc.query(
        `UPDATE member_faction_stints SET left_at = now()
         WHERE left_at IS NULL AND member_id = ANY($1)`,
        [toClose]
      )
    }
    for (const id of currentIds) {
      if (openSet.has(id)) continue
      const joinedAt = await seedJoinedAt(dbc, id)
      await dbc.query(
        `INSERT INTO member_faction_stints (member_id, joined_at) VALUES ($1, $2)
         ON CONFLICT (member_id) WHERE left_at IS NULL DO NOTHING`,
        [id, joinedAt]
      )
    }

    await dbc.query('COMMIT')
  } catch (err) {
    await dbc.query('ROLLBACK')
    throw err
  } finally {
    dbc.release()
  }

  return { rows: roster.length }
}
