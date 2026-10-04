// Per-member Hall of Fame snapshot (#872): one row per member per day from
// `GET /user/{id}/hof`.
//
// ⚠️ Cadence is a STATED choice, not a guess. One call per member means ~100
// per sweep for a full faction, which makes daily clearly affordable and
// per-page-load clearly not. HoF positions move on the order of days, so daily
// is ample resolution for a bragging-rights board.
//
// ⚠️ Multi-key fan-out via `createKeyRotator`, like `memberStatsJob` — a
// hundred sequential calls on one key is exactly the pattern that got the
// fleet into trouble before (2026-09-10).
import type { JobDeps } from './itemsSync.js'
import type { RunResult } from '../runLog.js'
import { createKeyRotator } from '../sampleCapture.js'
import { readMemberHof } from '../../memberHof.js'

const isoDate = (d: Date) => d.toISOString().slice(0, 10)

export async function memberHofSyncJob({ db, pool, client }: JobDeps): Promise<RunResult> {
  const { active, rfetch } = await createKeyRotator(pool, client)
  if (active.length === 0) throw new Error('no pooled key available')

  const members = await db.query(
    `SELECT member_id FROM members WHERE is_current = true AND is_fallen = false ORDER BY member_id`
  )
  if (members.rows.length === 0) return { rows: 0, details: { note: 'no current members' } }

  const today = isoDate(new Date())
  let written = 0
  let empty = 0

  for (const m of members.rows) {
    const data = await rfetch(`/v2/user/${m.member_id}/hof`)
    const hof = readMemberHof(data)
    // ⚠️ An empty read must not overwrite a good snapshot with an empty one.
    // A call that came back wrong and a member with genuinely no standings look
    // identical in the row; only one of them should replace today's.
    // Same guard as `factionUpgradesSyncJob`.
    if (Object.keys(hof).length === 0) { empty += 1; continue }

    await db.query(
      `INSERT INTO member_hof_snapshots (member_id, snapshot_date, hof, fetched_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (member_id, snapshot_date) DO UPDATE
         SET hof = EXCLUDED.hof, fetched_at = now()`,
      [String(m.member_id), today, JSON.stringify(hof)]
    )
    written += 1
  }

  return {
    rows: written,
    details: { members: members.rows.length, written, empty, keys: active.length },
  }
}
