// Faction lookup completion — the tag half of the `factions` table (restores
// the old sync's `_backfill_factions` step). attacks-sync now captures faction
// names inline from the attack payload, but that payload carries no tag; this
// job fills the gaps via /v2/faction/{id}/basic for faction ids referenced by
// attacks that are either entirely unknown or known-by-name-but-tagless, so the
// payout opposing-faction filter shows "SMTH - Phoenix Nirvana [PN]" rather
// than a bare name or "Faction #20465".
//
// A faction with genuinely no tag is stored with an empty-string tag (not NULL)
// so it isn't re-looked-up every run. Runs are capped per tick so a large
// backlog (e.g. right after a war introduces dozens of new opponents) can't
// exhaust the per-key budget in one go — the next run continues.
import type { JobDeps } from './itemsSync.js'
import type { RunResult } from '../runLog.js'
import { TornApiError } from '../tornClient.js'

const MAX_PER_RUN = 40
// Transient Torn errors (too-many-requests / IP-block): stop the batch as a
// soft success so already-upserted names stay and the next run resumes.
const RATE_LIMIT_CODES = new Set([5, 8])

export async function factionsSyncJob({ db, pool, client }: JobDeps): Promise<RunResult> {
  // Faction ids referenced by attacks (attacker OR defender) that we can't yet
  // label fully: either not in `factions` at all, or present by name but with no
  // tag resolved (the state attacks-sync leaves them in). A '' tag counts as
  // resolved, so genuinely tagless factions aren't retried forever.
  const missing = await db.query(
    `SELECT DISTINCT fid FROM (
       SELECT attacker_faction_id AS fid FROM faction_attacks
       UNION
       SELECT defender_faction_id AS fid FROM faction_attacks
     ) refs
     WHERE fid IS NOT NULL
       AND fid NOT IN (SELECT id FROM factions WHERE tag IS NOT NULL)
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
    // Store '' (not NULL) when a faction has no tag, so it reads as "resolved"
    // and the tag-IS-NULL selector above won't re-fetch it every run.
    await db.query(
      `INSERT INTO factions (id, name, tag, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, tag = EXCLUDED.tag, updated_at = now()`,
      [Number(basic.id ?? fid), name, basic.tag ?? '']
    )
    rows += 1
  }

  return { rows, details: { missing: missing.rows.length, rate_limited: rateLimited } }
}
