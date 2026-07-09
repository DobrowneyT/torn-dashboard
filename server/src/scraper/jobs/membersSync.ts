// Faction members sync — port of cpr_scraper.py's _sync_members_to_supabase
// + _reconcile_key_pool. Marks everyone not in the fresh roster as left
// (rows are history, never deleted), upserts current members, and keeps the
// consented key pool aligned with membership: leavers' keys drop out of
// rotation, rejoiners' keys come back in (claim-time validation still
// guards a stale key).
import type { JobDeps } from './itemsSync.js'
import type { RunResult } from '../runLog.js'

export async function membersSyncJob({ db, pool, client }: JobDeps): Promise<RunResult> {
  const claimed = await pool.claim()
  if (!claimed) throw new Error('no pooled key available')

  const data = await client.fetch('/v2/faction/members', claimed.key)
  const roster: Array<{ id: number; name: string }> = data.members ?? []
  if (roster.length === 0) throw new Error('Torn returned an empty roster — refusing to mark everyone as left')

  const dbc = await db.connect()
  try {
    await dbc.query('BEGIN')
    await dbc.query(
      `UPDATE members SET is_current = false, last_seen = now() WHERE is_current = true`
    )
    for (const m of roster) {
      await dbc.query(
        `INSERT INTO members (member_id, member_name, is_current, last_seen, updated_at)
         VALUES ($1, $2, true, now(), now())
         ON CONFLICT (member_id) DO UPDATE SET
           member_name = EXCLUDED.member_name, is_current = true,
           last_seen = now(), updated_at = now()`,
        [String(m.id), m.name]
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
    await dbc.query('COMMIT')
  } catch (err) {
    await dbc.query('ROLLBACK')
    throw err
  } finally {
    dbc.release()
  }

  return { rows: roster.length }
}
