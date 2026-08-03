// Revives sync for one ranked war — port of scripts/fetch_revives_for_war.py.
// Resolves the war's window, ASC-paginates incoming revives across it, and
// upserts the flattened rows tagged with the war id.
import type { JobDeps } from './itemsSync.js'
import type { RunResult } from '../runLog.js'

const PAGE_FULL = 100

export async function revivesSyncJob({ db, pool, client }: JobDeps, warId: number): Promise<RunResult> {
  const war = await db.query('SELECT start_at, end_at FROM ranked_wars WHERE id = $1', [warId])
  if (war.rows.length === 0) throw new Error(`War ${warId} not found`)
  const from = Number(war.rows[0].start_at)
  const to = war.rows[0].end_at ? Number(war.rows[0].end_at) : Math.floor(Date.now() / 1000)

  const claimed = await pool.claim()
  if (!claimed) throw new Error('no pooled key available')

  let rows = 0
  let cursor = from
  for (;;) {
    const data = await client.fetch(
      `/v2/faction/revives?filters=incoming&striptags=true&sort=ASC&from=${cursor}&to=${to}`,
      claimed.key
    )
    const revives: any[] = data.revives ?? []
    if (revives.length === 0) break

    for (const raw of revives) {
      const reviver = raw.reviver ?? {}
      const target = raw.target ?? {}
      const lastAction = target.last_action
      await db.query(
        `INSERT INTO faction_revives (revive_id, rw_id, "timestamp", reviver_id, reviver_name,
           reviver_faction_id, reviver_faction_name, reviver_skill, target_id, target_name,
           target_faction_id, target_faction_name, hospital_reason, early_discharge,
           target_last_action, target_online_status, success_chance, result, fetched_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, now())
         ON CONFLICT (revive_id) DO UPDATE SET
           rw_id = EXCLUDED.rw_id, hospital_reason = EXCLUDED.hospital_reason,
           early_discharge = EXCLUDED.early_discharge, result = EXCLUDED.result,
           success_chance = EXCLUDED.success_chance, fetched_at = now()`,
        [raw.id, warId, raw.timestamp ?? null, reviver.id ?? null, reviver.name ?? null,
         reviver.faction?.id ?? null, reviver.faction?.name ?? null, reviver.skill ?? null,
         target.id ?? null, target.name ?? null, target.faction?.id ?? null,
         target.faction?.name ?? null, target.hospital_reason ?? null,
         Boolean(target.early_discharge ?? false),
         typeof lastAction === 'object' && lastAction !== null ? lastAction.timestamp ?? null : lastAction ?? null,
         target.online_status ?? null, raw.success_chance ?? null, raw.result ?? null]
      )
      rows += 1
    }

    if (revives.length < PAGE_FULL) break
    cursor = revives[revives.length - 1].timestamp ?? cursor
  }

  return { rows, details: { war_id: warId, from, to } }
}
