// Ranked-wars sync — port of scripts/war_data_update.py + the ranked_wars/
// war_member_contributions row shapes from sync_to_supabase.py. Fetches the
// paginated war list, updates live scores in place (never touching the
// manual is_termed flag), and pulls the official report once per completed
// war: rewards/ranks/forfeit plus per-member contributions for both
// factions. Reports Torn refuses permanently (codes 2/7/13/14) are flagged
// report_unavailable and skipped forever; transient failures retry on the
// next run.
import type { JobDeps } from './itemsSync.js'
import type { RunResult } from '../runLog.js'
import { TornApiError } from '../tornClient.js'

const PERMANENT_REPORT_ERRORS = new Set([2, 7, 13, 14])

export async function warsSyncJob({ db, pool, client }: JobDeps): Promise<RunResult> {
  const claimed = await pool.claim()
  if (!claimed) throw new Error('no pooled key available')

  const config = await db.query('SELECT torn_faction_id FROM faction_config LIMIT 1')
  const us = Number(config.rows[0].torn_faction_id)

  // 1. Paginate the full ranked-wars list.
  const wars: any[] = []
  for (let offset = 0; ; offset += 100) {
    const data = await client.fetch(`/v2/faction/${us}/rankedwars?offset=${offset}&limit=100`, claimed.key)
    const page: any[] = data.rankedwars ?? []
    if (page.length === 0) break
    wars.push(...page)
    if (page.length < 100) break
  }

  let warsNew = 0
  for (const raw of wars) {
    const factions: any[] = raw.factions ?? []
    const our = factions.find((f) => Number(f.id) === us)
    const opponent = factions.find((f) => Number(f.id) !== us)
    // Insert normalizes the whole row; update touches ONLY the live fields
    // (scores, end, winner) so is_termed and report data survive.
    const res = await db.query(
      `INSERT INTO ranked_wars (id, start_at, end_at, opponent_id, opponent_name,
         our_score, opponent_score, target, winner_faction_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET
         our_score = EXCLUDED.our_score, opponent_score = EXCLUDED.opponent_score,
         end_at = EXCLUDED.end_at, winner_faction_id = EXCLUDED.winner_faction_id,
         updated_at = now()
       RETURNING (xmax = 0) AS inserted`,
      [raw.id, raw.start ?? 0, raw.end || null, opponent?.id ?? null, opponent?.name ?? null,
       our?.score ?? 0, opponent?.score ?? 0, raw.target ?? null, raw.winner ?? null]
    )
    if (res.rows[0].inserted) warsNew += 1
  }

  // 2. Reports for completed wars that don't have one yet.
  const pending = await db.query(
    `SELECT id FROM ranked_wars
     WHERE end_at IS NOT NULL AND end_at > 0
       AND report_fetched = false AND report_unavailable = false
     ORDER BY id`
  )
  let reportsFetched = 0
  let reportsUnavailable = 0
  let transientErrors = 0
  let contributionRows = 0
  for (const { id } of pending.rows) {
    let report: any
    try {
      const data = await client.fetch(`/v2/faction/${id}/rankedwarreport`, claimed.key)
      report = data.rankedwarreport
    } catch (err) {
      if (err instanceof TornApiError && PERMANENT_REPORT_ERRORS.has(err.tornCode)) {
        await db.query('UPDATE ranked_wars SET report_unavailable = true, updated_at = now() WHERE id = $1', [id])
        reportsUnavailable += 1
      } else {
        transientErrors += 1
      }
      continue
    }
    if (!report) {
      transientErrors += 1
      continue
    }

    const factions: any[] = report.factions ?? []
    const our = factions.find((f) => Number(f.id) === us)
    await db.query(
      `UPDATE ranked_wars SET
         rewards_items = $2, rank_before = $3, rank_after = $4, forfeit = $5,
         our_score = COALESCE($6, our_score), report_fetched = true, updated_at = now()
       WHERE id = $1`,
      [id,
       our?.rewards?.items ? JSON.stringify(our.rewards.items) : null,
       our?.rank?.before ?? null, our?.rank?.after ?? null,
       report.forfeit ?? false, our?.score ?? null]
    )

    for (const faction of factions) {
      for (const member of faction.members ?? []) {
        await db.query(
          `INSERT INTO war_member_contributions (war_id, member_id, member_name, level, attacks, score, faction_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (war_id, member_id) DO UPDATE SET
             member_name = EXCLUDED.member_name, level = EXCLUDED.level,
             attacks = EXCLUDED.attacks, score = EXCLUDED.score,
             faction_id = EXCLUDED.faction_id, updated_at = now()`,
          [id, member.id, member.name ?? null, member.level ?? null,
           member.attacks ?? 0, member.score ?? 0, faction.id ?? null]
        )
        contributionRows += 1
      }
    }
    reportsFetched += 1
  }

  return {
    rows: wars.length + contributionRows,
    details: {
      wars_seen: wars.length,
      wars_new: warsNew,
      reports_fetched: reportsFetched,
      reports_unavailable: reportsUnavailable,
      transient_errors: transientErrors,
    },
  }
}
