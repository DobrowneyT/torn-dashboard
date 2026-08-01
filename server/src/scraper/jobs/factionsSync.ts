// Faction-name backfill — restores the old sync's `_backfill_factions` step
// (scripts/sync_to_supabase.py), which was dropped in the server migration.
// Any faction id referenced by an attack (either side) that we don't yet have
// a name for is looked up via /v2/faction/{id}/basic and upserted into the
// `factions` lookup table, so the payout opposing-faction filter shows real
// names ("SMTH - Phoenix Nirvana [PN]") instead of "Faction #20465".
//
// The v2 attacks payload only carries faction ids, so the names have to be
// resolved out-of-band here. Runs are capped per tick so a large backlog (e.g.
// right after a war introduces dozens of new opponents) can't exhaust the
// per-key budget in one go — the next run continues with whatever's still
// missing.
import type { JobDeps } from './itemsSync.js'
import type { RunResult } from '../runLog.js'
import { TornApiError } from '../tornClient.js'

const MAX_PER_RUN = 40
// Transient Torn errors (too-many-requests / IP-block): stop the batch as a
// soft success so already-upserted names stay and the next run resumes.
const RATE_LIMIT_CODES = new Set([5, 8])

export async function factionsSyncJob({ db, pool, client }: JobDeps): Promise<RunResult> {
  // Faction ids referenced by attacks (attacker OR defender) with no name yet.
  const missing = await db.query(
    `SELECT DISTINCT fid FROM (
       SELECT attacker_faction_id AS fid FROM faction_attacks
       UNION
       SELECT defender_faction_id AS fid FROM faction_attacks
     ) refs
     WHERE fid IS NOT NULL AND fid NOT IN (SELECT id FROM factions)
     ORDER BY fid
     LIMIT $1`,
    [MAX_PER_RUN]
  )
  if (missing.rows.length === 0) return { rows: 0, details: { missing: 0 } }

  const claimed = await pool.claim()
  if (!claimed) throw new Error('no pooled key available')

  let rows = 0
  let rateLimited = false
  for (const { fid } of missing.rows) {
    let data: any
    try {
      data = await client.fetch(`/v2/faction/${fid}/basic`, claimed.key)
    } catch (err) {
      if (err instanceof TornApiError && RATE_LIMIT_CODES.has(err.tornCode)) { rateLimited = true; break }
      // A single faction failing (disbanded, bad id) must not abort the batch.
      continue
    }
    const basic = data.basic ?? {}
    const name = basic.name
    if (!name) continue  // no name in the response — skip, retried next run
    await db.query(
      `INSERT INTO factions (id, name, tag, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, tag = EXCLUDED.tag, updated_at = now()`,
      [Number(basic.id ?? fid), name, basic.tag ?? null]
    )
    rows += 1
  }

  return { rows, details: { missing: missing.rows.length, rate_limited: rateLimited } }
}
